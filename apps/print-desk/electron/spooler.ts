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

/** How far a job in the queue is: copies done and left, and what the driver or printer says. */
export function progressOf(key: string, copies: number, job: SpoolJob, printer: SpoolPrinter | undefined): CopyProgress {
  const printed = Math.min(copies, job.pagesPrinted);
  const status = [job.status || (job.pagesPrinted ? 'Printing' : 'Queued'), printer?.issue].filter(Boolean).join(' · ');
  return { key, copies, printed, left: copies - printed, status, done: false };
}

/**
 * How a job that left the queue ended, from Windows' print log
 * (Microsoft-Windows-PrintService/Operational): event 307 when it printed, with the pages it
 * printed; event 310 alone when it was deleted (cancelled) before that.
 */
export type JobOutcome = { kind: 'printed'; pages: number } | { kind: 'deleted' };

/** The outcome of job `id` on `printer` among the log's 307/310 events (the script's JSON); null when not logged yet. */
export function parseOutcome(json: string, printer: string, id: number): JobOutcome | null {
  const events = list(JSON.parse(json || '[]') as { id?: number; job?: number; printer?: string; pages?: number }[] | null).filter(
    (e) => Number(e.job) === id && same(String(e.printer ?? ''), printer),
  );
  const printed = events.find((e) => e.id === 307);
  if (printed) return { kind: 'printed', pages: Number(printed.pages) || 0 };
  return events.some((e) => e.id === 310) ? { kind: 'deleted' } : null;
}

const OUTCOME = [
  '$since = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$args[0]).LocalDateTime',
  "$e = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-PrintService/Operational'; Id = 307, 310; StartTime = $since } -ErrorAction SilentlyContinue | ForEach-Object { $d = ([xml]$_.ToXml()).Event.UserData.FirstChild; if ($_.Id -eq 307) { [pscustomobject]@{ id = 307; job = [int]$d.Param1; printer = $d.Param5; pages = [int]$d.Param8 } } else { [pscustomobject]@{ id = 310; job = [int]$d.Param1; printer = $d.Param4; pages = 0 } } })",
  'ConvertTo-Json -Compress -InputObject $e',
].join('; ');

/** How the job ended, per Windows' print log since `since` (ms); null when not logged (yet, or the log is off). */
export async function jobOutcome(printer: string, id: number, since: number): Promise<JobOutcome | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${OUTCOME} } ${Math.floor(since)}`], { windowsHide: true, timeout: 15_000 });
    return parseOutcome(stdout.trim(), printer, id);
  } catch {
    return null;
  }
}

/**
 * The last word on a job that left the queue. Printed: the pages Windows logged (each copy is a
 * page). Cancelled: the copies the driver had sent before (`sentBefore`), the rest never printed.
 * Not logged: all copies, as far as Print Desk can tell.
 */
export function finishedOf(key: string, copies: number, sentBefore: number, outcome: JobOutcome | null): CopyProgress {
  if (outcome?.kind === 'deleted') {
    const printed = Math.min(copies, sentBefore);
    return { key, copies, printed, left: 0, status: `Cancelled after ${printed} of ${copies}`, done: true, cancelled: true };
  }
  const printed = outcome ? Math.min(copies, outcome.pages) : copies;
  return { key, copies, printed, left: 0, status: outcome ? 'Printed' : 'Left the queue (Windows logged no outcome)', done: true };
}
