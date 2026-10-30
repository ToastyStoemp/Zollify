import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { PrintJob, PrintResult, Printer } from './shared.js';
import { printParams, type ImageInfo } from './shared.js';
import { A4, cardLayout, sheetCommands, type CardArt, type Command, type Placed, type PriceFormat } from './cards.js';

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

/** Runs photocraft-cli; its output, or an error with the CLI's own error line. */
async function exec(exe: string, args: string[], timeout = 0): Promise<string> {
  if (!exe) throw new Error('Set the path to photocraft-cli first (it is installed with PhotoCraft).');
  try {
    // info lists every layer: a big PSD's JSON can run to many megabytes.
    return (await run(exe, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout })).stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string; killed?: boolean };
    if (e.killed) throw new Error(`photocraft-cli did not answer within ${timeout / 1000} s`);
    const text = (e.stderr || e.message || 'photocraft-cli failed').trim();
    const line = text.split('\n').find((l) => l.startsWith('error:'));
    throw new Error(line ? line.replace(/^error:\s*/, '') : text);
  }
}

/** `photocraft-cli run` with one command; its JSON result, or the CLI's error text. */
async function cli(exe: string, args: string[], timeout = 0): Promise<Record<string, unknown>> {
  const stdout = await exec(exe, args, timeout);
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

// ── Price cards ──

/** `photocraft-cli run` on a file, or on a new document, with commands in order, saved to `out`. */
async function runCommands(exe: string, source: string | Record<string, unknown>, commands: Command[], out: string): Promise<void> {
  const args = ['run', ...(typeof source === 'string' ? [source] : ['--new', JSON.stringify(source)])];
  for (const [id, params] of commands) args.push('--cmd', id, '--params', JSON.stringify(params));
  await exec(exe, [...args, '--out', out], 180_000);
}

/** A PNG's size in pixels, from its header; null for anything else. */
export async function pngSize(file: string): Promise<{ width: number; height: number } | null> {
  const head = await readFile(file).catch(() => null);
  if (!head || head.length < 24 || head.toString('latin1', 1, 4) !== 'PNG') return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** A PNG beside a card or sheet PSD, for the list ("Keychain.psd" -> "Keychain.png"). */
const previewOf = (psd: string): string => psd.replace(/\.psd$/i, '') + '.png';
const renderPreview = (exe: string, psd: string): Promise<string> => exec(exe, ['convert', psd, previewOf(psd)], 120_000).then(() => previewOf(psd));

/** Draws a card into `file` (a PSD), and its preview PNG beside it. */
export async function drawCard(exe: string, art: CardArt, fmt: PriceFormat, file: string): Promise<{ file: string; preview: string; width: number; height: number; layout: string }> {
  const { width, height, layout, commands } = cardLayout(art, fmt);
  await runCommands(exe, { width, height, resolution: 300, background: 'white', name: art.title }, commands, file);
  return { file, preview: await renderPreview(exe, file), width, height, layout };
}

interface InfoLayer {
  id: number;
  kind: string;
  name: string;
  children?: InfoLayer[];
}

/**
 * Sets the text of a card's text layers by name, in the PSD itself, and draws its preview again.
 * Layers renamed or deleted by hand are left out and named in `missing`.
 */
export async function setCardTexts(exe: string, file: string, texts: Record<string, string>): Promise<{ updated: number; missing: string[]; preview: string }> {
  const info = JSON.parse(await exec(exe, ['info', file, '--compact'], 60_000)) as { layers?: InfoLayer[] };
  const ids = new Map<string, number>();
  const walk = (layers: InfoLayer[] = []): void => {
    for (const l of layers) {
      if (l.kind === 'Type' && !ids.has(l.name)) ids.set(l.name, l.id);
      walk(l.children);
    }
  };
  walk(info.layers);
  const commands: Command[] = Object.entries(texts)
    .filter(([name]) => ids.has(name))
    .map(([name, text]) => ['type.edit', { layer: ids.get(name), text }]);
  if (commands.length) await runCommands(exe, file, commands, file);
  return { updated: commands.length, missing: Object.keys(texts).filter((n) => !ids.has(n)), preview: await renderPreview(exe, file) };
}

/** A4 pages of cards as embedded Smart Objects, saved as `<base>-<n>.psd` with a preview each. */
export async function drawSheets(exe: string, placed: (Placed & { file: string })[], base: string): Promise<{ file: string; preview: string }[]> {
  const pages = [...new Set(placed.map((p) => p.page))].sort((a, b) => a - b);
  const out: { file: string; preview: string }[] = [];
  for (const page of pages) {
    const file = `${base}-${page + 1}.psd`;
    await runCommands(exe, { ...A4, resolution: 300, background: 'white', name: `Price cards ${page + 1}` }, sheetCommands(placed.filter((p) => p.page === page)), file);
    out.push({ file, preview: await renderPreview(exe, file) });
  }
  return out;
}

/** A sheet as a PDF beside it, A4 at its own size (2480 x 3508 at 300 ppi is the page). */
export async function sheetPdf(exe: string, file: string): Promise<string> {
  const output = file.replace(/\.psd$/i, '') + '.pdf';
  await cli(exe, ['run', file, '--cmd', 'file.print', '--params', JSON.stringify({ paper: 'a4', orientation: 'portrait', scale: 100, output, send: false })], 120_000);
  return output;
}
