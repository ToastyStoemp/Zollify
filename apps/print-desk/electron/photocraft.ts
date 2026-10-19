import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { PrintJob, PrintResult, Printer } from './shared.js';
import { printParams } from './shared.js';

const run = promisify(execFile);

/** Where PhotoCraft installs photocraft-cli; empty when it is not in a usual place. */
export function findExe(): string {
  const candidates = [
    `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\PhotoCraft\\photocraft-cli.exe`,
    `${process.env.LOCALAPPDATA ?? ''}\\Programs\\PhotoCraft\\photocraft-cli.exe`,
    '/Applications/PhotoCraft.app/Contents/MacOS/photocraft-cli',
    '/usr/local/bin/photocraft-cli',
    '/usr/bin/photocraft-cli',
  ];
  return candidates.find((c) => existsSync(c)) ?? '';
}

/** `photocraft-cli run` with one command; its JSON result, or the CLI's error text. */
async function cli(exe: string, args: string[], timeout = 0): Promise<Record<string, unknown>> {
  if (!exe) throw new Error('Set the path to photocraft-cli first (it is installed with PhotoCraft).');
  let stdout: string;
  try {
    ({ stdout } = await run(exe, args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout }));
  } catch (err) {
    const e = err as { stderr?: string; message?: string; killed?: boolean };
    if (e.killed) throw new Error(`photocraft-cli did not answer within ${timeout / 1000} s`);
    const text = (e.stderr || e.message || 'photocraft-cli failed').trim();
    const line = text.split('\n').find((l) => l.startsWith('error:'));
    throw new Error(line ? line.replace(/^error:\s*/, '') : text);
  }
  // One --cmd prints one {"command", "result"} object (pretty-printed, so parse the whole output).
  const text = stdout.trim();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return JSON.parse(text.slice(text.lastIndexOf('\n{') + 1)) as Record<string, unknown>;
  }
}

export async function printers(exe: string): Promise<Printer[]> {
  // file.print.printers, not file.printers: on Windows (PhotoCraft 0.10.0) file.printers hangs, this one asks the spooler directly.
  const out = await cli(exe, ['run', '--new', '{"width":8,"height":8}', '--cmd', 'file.print.printers'], 20_000);
  const result = out.result as { printers?: Printer[] } | undefined;
  return result?.printers ?? [];
}

/** Prints one job through `file.print`; never throws, the outcome is the result. */
export async function print(exe: string, job: PrintJob): Promise<PrintResult> {
  try {
    const params = printParams({ file: job.file, params: job.params }, job.copies);
    const out = await cli(exe, ['run', job.file, '--cmd', 'file.print', '--params', JSON.stringify(params)]);
    const r = out.result as { sent?: boolean; spooler?: string; backend?: string } | undefined;
    if (!r?.sent) return { key: job.key, ok: false, message: 'PhotoCraft rendered the page but did not send it' };
    return { key: job.key, ok: true, message: `${job.copies} x ${r.spooler ?? 'sent'}${r.backend ? ` (${r.backend})` : ''}` };
  } catch (err) {
    return { key: job.key, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
