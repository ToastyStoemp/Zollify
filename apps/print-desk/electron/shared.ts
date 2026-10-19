/** Types and pure helpers used by both the Electron main process and the renderer. */

/** A file linked to one product or variant, with the PhotoCraft `file.print` params it prints with. */
export interface PrintLink {
  file: string;
  /** PhotoCraft `file.print` params: printer, paper, orientation, scale, marks, printerSettings... */
  params: Record<string, unknown>;
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
 * One item's settings copied onto another. Same size (or a target with no
 * size in its name): everything. Another size: the target keeps its own paper,
 * and the Windows driver settings (printerSettings) stay behind, because they
 * carry the source's paper and PhotoCraft refuses a driver paper that differs
 * from the layout.
 */
export function settingsFor(source: Record<string, unknown>, sourceSize: string | null, targetSize: string | null): Record<string, unknown> {
  if (!targetSize || targetSize === sourceSize) return { ...source };
  const { printerSettings: _driver, ...rest } = source;
  return { ...rest, paper: paperParam(targetSize) };
}

export const stockKey = (productId: string, variantId: string | null | undefined): string => `${productId}:${variantId ?? ''}`;

/** The `file.print` params for one job: the link's, with the copies asked for and never a dry run or PDF output. */
export function printParams(link: PrintLink, copies: number): Record<string, unknown> {
  const { output: _o, dryRun: _d, send: _s, ...rest } = link.params;
  return { ...rest, copies: Math.max(1, Math.min(999, Math.floor(copies))), send: true };
}
