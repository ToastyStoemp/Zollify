import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CopyProgress } from './shared.js';

const run = promisify(execFile);

/**
 * The Windows print queue, as the drivers report it. PhotoCraft's Windows
 * route prints every copy as its own page of one spooler job, so a job's
 * PagesPrinted is the copies done. TotalPages is not used: drivers often
 * report 0 for it while printing. A job that has left the queue is done.
 *
 * "Printed" here is what the driver says it has sent to the printer; a
 * printer with its own memory can be a few sheets behind that.
 */

export interface SpoolJob {
  printer: string;
  id: number;
  document: string;
  /** The driver's job status ("Printing", "Paused", "Error", ...), '' while just queued. */
  status: string;
  pagesPrinted: number;
}
export interface SpoolPrinter {
  name: string;
  default: boolean;
  /** A problem the printer reports (no paper, offline...), '' when none. */
  issue: string;
}
export interface Snapshot {
  jobs: SpoolJob[];
  printers: SpoolPrinter[];
}

/** Win32_Printer.DetectedErrorState values worth showing; 0-2 are unknown/other/none. */
const ISSUES: Record<number, string> = {
  3: 'Low paper',
  4: 'No paper',
  5: 'Low ink',
  6: 'No ink',
  7: 'Door open',
  8: 'Paper jam',
  9: 'Offline',
  10: 'Needs service',
  11: 'Output tray full',
};

const SCRIPT = [
  '$j = @(Get-CimInstance Win32_PrintJob | ForEach-Object { [pscustomobject]@{ name = $_.Name; id = $_.JobId; document = $_.Document; status = $_.JobStatus; pages = $_.PagesPrinted } })',
  '$p = @(Get-CimInstance Win32_Printer | ForEach-Object { [pscustomobject]@{ name = $_.Name; default = $_.Default; error = $_.DetectedErrorState; offline = $_.WorkOffline } })',
  '[pscustomobject]@{ jobs = $j; printers = $p } | ConvertTo-Json -Compress -Depth 3',
].join('; ');

const list = <T>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Parses the script's JSON. A job's Name is "<printer>, <job id>". */
export function parseSnapshot(json: string): Snapshot {
  const raw = JSON.parse(json || '{}') as {
    jobs?: { name?: string; id?: number; document?: string; status?: string | null; pages?: number | null }[];
    printers?: { name?: string; default?: boolean; error?: number | null; offline?: boolean }[];
  };
  return {
    jobs: list(raw.jobs).map((j) => {
      const name = String(j.name ?? '');
      const comma = name.lastIndexOf(', ');
      return { printer: comma > 0 ? name.slice(0, comma) : name, id: Number(j.id) || 0, document: String(j.document ?? ''), status: String(j.status ?? ''), pagesPrinted: Number(j.pages) || 0 };
    }),
    printers: list(raw.printers).map((p) => ({
      name: String(p.name ?? ''),
      default: !!p.default,
      issue: p.offline ? 'Offline' : (ISSUES[Number(p.error)] ?? ''),
    })),
  };
}

/** The queue now; null where there is no Windows spooler to ask. */
export async function snapshot(): Promise<Snapshot | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, timeout: 15_000 });
    return parseSnapshot(stdout.trim());
  } catch {
    return null;
  }
}

const same = (a: string, b: string): boolean => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/** The printer a job goes to: the one it names, else the system default. */
export function targetPrinter(snap: Snapshot, named: unknown): string {
  return typeof named === 'string' && named ? named : (snap.printers.find((p) => p.default)?.name ?? '');
}

/** The job a print just added: on that printer, with that document name, and not in the queue before. */
export function newJob(before: Snapshot, after: Snapshot, printer: string, document: string): SpoolJob | undefined {
  const old = new Set(before.jobs.map((j) => `${j.printer}|${j.id}`));
  return after.jobs
    .filter((j) => same(j.printer, printer) && same(j.document, document) && !old.has(`${j.printer}|${j.id}`))
    .sort((a, b) => b.id - a.id)[0];
}

/** How far one tracked job is: copies left, and what the driver or printer says. */
export function progressOf(key: string, copies: number, job: SpoolJob | undefined, printer: SpoolPrinter | undefined): CopyProgress {
  if (!job) return { key, copies, left: 0, status: 'Printed', done: true };
  const left = copies - Math.min(copies, job.pagesPrinted);
  const status = [job.status || (job.pagesPrinted ? 'Printing' : 'Queued'), printer?.issue].filter(Boolean).join(' · ');
  return { key, copies, left, status, done: false };
}
