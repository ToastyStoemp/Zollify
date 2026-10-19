/** Types and pure helpers used by both the Electron main process and the renderer. */

/** A file linked to one product or variant, with the PhotoCraft `file.print` params it prints with. */
export interface PrintLink {
  file: string;
  /** PhotoCraft `file.print` params: printer, paper, orientation, scale, marks, printerSettings... */
  params: Record<string, unknown>;
  /** Prints with its own params instead of the global print settings. */
  own?: boolean;
}

/** One sellable item of the catalogue, keyed like the inventory ("pid:vid", '' for no variant). */
export interface CatalogRow {
  key: string;
  productId: string;
  variantId: string;
  title: string;
  variant: string;
  sku: string;
  onHand: number;
}

export interface PrintJob {
  key: string;
  file: string;
  params: Record<string, unknown>;
  copies: number;
}

export interface PrintResult {
  key: string;
  ok: boolean;
  /** Where the job went, or why it did not. */
  message: string;
}

/** One item of a print run: copies still to print, as far as the print queue says. */
export interface CopyProgress {
  key: string;
  copies: number;
  left: number;
  /** Driver job status, a printer problem, or why the job never reached the queue. */
  status: string;
  done: boolean;
  failed?: boolean;
}

export interface Settings {
  server: string;
  /** Path to photocraft-cli (or photocraft-cli.exe). */
  photocraft: string;
  deviceId: string;
  /** Account id -> stock key -> link. */
  links: Record<string, Record<string, PrintLink>>;
  /** After printing, count the printed copies into the Zollify inventory. */
  addToStock: boolean;
  /** 'system' follows the device. */
  theme: Theme;
  /**
   * Print settings for every item without its own (PrintLink.own). Each item still gets its own
   * paper (from the A size in its name) and orientation (from its image).
   */
  global: Record<string, unknown> | null;
}

export type Theme = 'system' | 'light' | 'dark';

export interface Session {
  accountId: string;
  email: string;
}

export interface Printer {
  name: string;
  default: boolean;
}

/** Files a product can be linked to: what PhotoCraft opens and prints. */
export const PRINT_FILE_EXTENSIONS = ['psd', 'psb', 'pcraft', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp'] as const;
export const isPrintFile = (path: string): boolean => (PRINT_FILE_EXTENSIONS as readonly string[]).includes(path.split('.').pop()?.toLowerCase() ?? '');

// ── Paper sizes ──────────────────────────────────────────────────────────────

/** Papers PhotoCraft knows by name; any other size goes to it as [width, height] in points. */
const PHOTOCRAFT_PAPERS = new Set(['letter', 'legal', 'tabloid', 'a3', 'a4', 'a5', '4x6', '5x7']);
/** ISO A sizes, millimetres, portrait. */
const ISO_A_MM: Record<string, [number, number]> = { a0: [841, 1189], a1: [594, 841], a2: [420, 594], a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148] };
const pt = (mm: number): number => Math.round((mm * 72 * 100) / 25.4) / 100;

/** What the paper picker offers, A sizes first. */
export const PAPER_OPTIONS = [...Object.keys(ISO_A_MM), 'letter', 'legal', 'tabloid', '4x6', '5x7'] as const;

/** A paper name as PhotoCraft's `paper` param: its own name where it has one, else [w, h] points. */
export function paperParam(name: string): string | [number, number] {
  const n = name.toLowerCase();
  if (PHOTOCRAFT_PAPERS.has(n)) return n;
  const mm = ISO_A_MM[n];
  return mm ? [pt(mm[0]), pt(mm[1])] : n;
}

/** Other papers PhotoCraft knows by name, millimetres, portrait. */
const NAMED_MM: Record<string, [number, number]> = { letter: [215.9, 279.4], legal: [215.9, 355.6], tabloid: [279.4, 431.8], '4x6': [101.6, 152.4], '5x7': [127, 177.8] };

/** A `paper` param's size in millimetres (a name, or [w, h] points), or null when it is neither. */
export function paperMm(paper: unknown): [number, number] | null {
  if (typeof paper === 'string') return ISO_A_MM[paper.toLowerCase()] ?? NAMED_MM[paper.toLowerCase()] ?? null;
  if (!Array.isArray(paper) || paper.length !== 2) return null;
  const [w, h] = (paper as unknown[]).map(Number) as [number, number];
  return w > 0 && h > 0 ? [Math.round((w * 254) / 72) / 10, Math.round((h * 254) / 72) / 10] : null;
}

/** The named paper a `paper` param is ("a2" for A2's points, either way round), or null for a custom size. */
export function paperName(paper: unknown): string | null {
  if (typeof paper === 'string') return (PAPER_OPTIONS as readonly string[]).includes(paper.toLowerCase()) ? paper.toLowerCase() : null;
  if (!Array.isArray(paper) || paper.length !== 2) return null;
  const [w, h] = (paper as number[]).map(Number) as [number, number];
  for (const [name, [a, b]] of Object.entries(ISO_A_MM)) {
    const [pa, pb] = [pt(a), pt(b)];
    if ((Math.abs(w - pa) < 1 && Math.abs(h - pb) < 1) || (Math.abs(w - pb) < 1 && Math.abs(h - pa) < 1)) return name;
  }
  return null;
}

/**
 * The A size a product or variant name says, e.g. "A3", "Poster a4", "A2 matte":
 * a whole word A0-A6. "A3+" (Super A3) is a different paper and does not count.
 * The first name with a size wins, so pass the variant before the product title.
 */
export function sizeFromName(...names: string[]): string | null {
  for (const name of names) {
    const m = /(?:^|[^a-z0-9])a([0-6])(?![a-z0-9+])/i.exec(name ?? '');
    if (m) return `a${m[1]}`;
  }
  return null;
}

/**
 * Settings turned to the orientation of the image they print: landscape when
 * it is wider than tall, portrait when taller, unchanged when square. `turned`
 * says whether anything changed.
 *
 * The Windows driver settings (printerSettings) are kept: they hold the paper
 * type, quality and tray, and a PhotoCraft build with the Orientation change
 * (storytold/photocraft#7847) turns them to the layout when it prints. PhotoCraft
 * 0.10.0 refuses a landscape layout on portrait settings either way, kept or not.
 */
export function orientFor(params: Record<string, unknown>, width: number, height: number): { params: Record<string, unknown>; turned: boolean; orientation: string } {
  const current = params.orientation === 'landscape' ? 'landscape' : 'portrait';
  const orientation = width > height ? 'landscape' : height > width ? 'portrait' : current;
  if (orientation === current) return { params, turned: false, orientation };
  return { params: { ...params, orientation }, turned: true, orientation };
}

/**
 * One item's settings copied onto another. Same size (or a target with no
 * size in its name): everything. Another size: the target keeps its own paper.
 * The Windows driver settings (printerSettings) go along: Print Desk sets their
 * paper to the item's when it prints (printercaps.ts fitDriverPaper).
 */
export function settingsFor(source: Record<string, unknown>, sourceSize: string | null, targetSize: string | null): Record<string, unknown> {
  if (!targetSize || targetSize === sourceSize) return { ...source };
  return { ...source, paper: paperParam(targetSize) };
}

/**
 * What an item prints with: its own params when it has them (`own`) or there are no global
 * settings; else the global settings with the item's paper (the A size in its name, else its own
 * paper) and its own orientation (set from its image when the file was linked).
 */
export function effectiveParams(link: PrintLink | undefined, global: Record<string, unknown> | null | undefined, size: string | null): Record<string, unknown> | null {
  if (!global || link?.own) return link?.params ?? null;
  const own = link?.params ?? {};
  return { ...global, paper: size ? paperParam(size) : (own.paper ?? global.paper), orientation: own.orientation ?? global.orientation ?? 'portrait' };
}

export const stockKey = (productId: string, variantId: string | null | undefined): string => `${productId}:${variantId ?? ''}`;

/** The `file.print` params for one job: the link's, with the copies asked for and never a dry run or PDF output. */
export function printParams(link: PrintLink, copies: number): Record<string, unknown> {
  const { output: _o, dryRun: _d, send: _s, ...rest } = link.params;
  return { ...rest, copies: Math.max(1, Math.min(999, Math.floor(copies))), send: true };
}
