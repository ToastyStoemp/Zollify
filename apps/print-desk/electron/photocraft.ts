import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { PrintJob, PrintResult, Printer } from './shared.js';
import { printParams, type ImageInfo } from './shared.js';

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

// ── PhotoCraft's last print settings ──

/**
 * PhotoCraft's settings folder, picked the way PhotoCraft picks it (apps/photocraft/src/app_dirs.rs):
 * PHOTOCRAFT_CONFIG_DIR, then a portable copy's PhotoCraftData beside the executable, then the
 * platform folder.
 */
export function photocraftConfigDir(exe: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (env.PHOTOCRAFT_CONFIG_DIR) return env.PHOTOCRAFT_CONFIG_DIR;
  const exeDir = exe ? dirname(exe) : '';
  if (exeDir && ['portable.txt', 'PhotoCraft.portable'].some((m) => existsSync(join(exeDir, m)))) return join(exeDir, 'PhotoCraftData');
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Photocraft');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Photocraft');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'photocraft');
}

/** Keys of PhotoCraft's remembered print that are not print settings of an item. */
const NOT_SETTINGS = ['copies', 'units', 'output', 'dryRun', 'send', 'printable'];

/**
 * The settings of PhotoCraft's last print (File › Print remembers them in its preferences), as an
 * item's `file.print` params: copies and dialog-only keys dropped. PhotoCraft's Windows dialog takes
 * the paper from the driver already turned, with orientation "portrait"; a wider-than-tall paper is
 * stored here as the portrait paper with orientation "landscape", the same page, so the paper picker
 * still names it ("A3", not a custom size).
 */
export function printSettingsFrom(preferences: unknown): Record<string, unknown> | null {
  const dialogs = (preferences as { dialogs?: Record<string, unknown> } | null)?.dialogs;
  const last = dialogs?.['file.print'];
  if (!last || typeof last !== 'object' || Array.isArray(last)) return null;
  const params = Object.fromEntries(Object.entries(last as Record<string, unknown>).filter(([k]) => !NOT_SETTINGS.includes(k)));
  const paper = params.paper;
  if (Array.isArray(paper) && paper.length === 2 && Number(paper[0]) > Number(paper[1]) && params.orientation !== 'landscape') {
    params.paper = [paper[1], paper[0]];
    params.orientation = 'landscape';
  }
  return params;
}

/** PhotoCraft's last print settings, or an error that says how to get some. */
export async function lastPrint(exe: string): Promise<Record<string, unknown>> {
  const file = join(photocraftConfigDir(exe), 'preferences.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(`PhotoCraft's settings were not found at ${file}. Print once from PhotoCraft (File › Print) first.`);
  }
  let prefs: unknown;
  try {
    prefs = JSON.parse(text);
  } catch {
    throw new Error(`PhotoCraft's settings file could not be read (${file}).`);
  }
  const params = printSettingsFrom(prefs);
  if (!params) throw new Error('PhotoCraft has no print settings yet. Set up a print in PhotoCraft (File › Print) and print it once; PhotoCraft then remembers those settings.');
  return params;
}

/** `photocraft-cli run` with one command; its JSON result, or the CLI's error text. */
async function cli(exe: string, args: string[], timeout = 0): Promise<Record<string, unknown>> {
  if (!exe) throw new Error('Set the path to photocraft-cli first (it is installed with PhotoCraft).');
  let stdout: string;
  try {
    // info lists every layer: a big PSD's JSON can run to many megabytes.
    ({ stdout } = await run(exe, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout }));
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

/** An image's size in pixels, from `photocraft-cli info` (any file PhotoCraft opens, PSD included). */
export async function imageSize(exe: string, file: string): Promise<ImageInfo> {
  const out = await cli(exe, ['info', file, '--compact'], 60_000);
  const width = Number(out.width);
  const height = Number(out.height);
  if (!(width > 0 && height > 0)) throw new Error('PhotoCraft did not report the image size');
  // PhotoCraft prints at the document's resolution; 72 is what it takes when there is none.
  const resolution = Number(out.resolution) > 0 ? Number(out.resolution) : 72;
  return { width, height, resolution };
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
