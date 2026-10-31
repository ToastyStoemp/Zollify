/** Types and pure helpers used by both the Electron main process and the renderer. */
import type { CardDef, CardTheme, PriceFormat, SheetOptions } from './cards.js';

/** A file linked to one product or variant, with the PhotoCraft `file.print` params it prints with. */
export interface PrintLink {
  file: string;
  /** PhotoCraft `file.print` params: printer, paper, orientation, scale, marks, printerSettings... */
  params: Record<string, unknown>;
  /** Prints with its own params instead of the global print settings. */
  own?: boolean;
  /**
   * With the global settings: what this item prints differently (paper, orientation, scaleToFit,
   * scale, center), ahead of the paper from its name and the orientation from its image.
   */
  overrides?: Record<string, unknown>;
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
  /** Copies done so far: pages the driver sent, and in the end what Windows logged as printed. */
  printed: number;
  left: number;
  /** Driver job status, a printer problem, or why the job never reached the queue. */
  status: string;
  done: boolean;
  failed?: boolean;
  /** Cancelled in the queue: `printed` copies came out, the rest did not. */
  cancelled?: boolean;
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
  /** Base stock per item: "Fill to target" prints each item up to this many on hand. */
  target: number;
  /** Base stock per A size ("a3": 10), for items whose name says that size; others use `target`. */
  sizeTargets: Record<string, number>;
  /** Account id -> stock key -> the item's own target stock, ahead of its size's and the main one. */
  itemTargets: Record<string, Record<string, number>>;
  /** The unit print sizes and positions show in. */
  units: Units;
  /** Paper size ("a3", "letter") -> the Zollify material (id) a printed copy of that size uses up. */
  paperMaterials: Record<string, string>;
  /** Whether a printer key for Zollify's materials is stored (the key itself stays in the main process). */
  hasPrinterKey: boolean;
  /** Account id -> stock keys of items printed elsewhere (outsourced): out of the fills and the print run. */
  hidden: Record<string, string[]>;
  priceCards: PriceCardSettings;
}

/** Price cards: the themes, each account's cards, how prices read, and where the PSDs go. */
export interface PriceCardSettings {
  themes: CardTheme[];
  /** Account id -> its cards, in sheet order. */
  cards: Record<string, CardDef[]>;
  format: PriceFormat;
  /** Folder for the card and sheet PSDs; '' for Documents/Price cards. */
  outDir: string;
  /** `file.print` params the sheets print with (their own printer, profile, driver settings); null or unset: the global print settings. */
  print?: Record<string, unknown> | null;
  /** The event whose local prices the cards show (its currency, rate, rounding, pinned prices); '' or unset: the catalogue's. */
  event?: string;
  /** How sheets are laid out; unset: fewest sheets, no cut marks. */
  sheet?: SheetOptions;
}

export type Units = 'cm' | 'mm' | 'in';
export const MM_PER: Record<Units, number> = { mm: 1, cm: 10, in: 25.4 };

/** An image as PhotoCraft prints it: pixels, and pixels per inch (its resolution). */
export interface ImageInfo {
  width: number;
  height: number;
  resolution: number;
}

/** The image's printed width and height in millimetres at `scale` percent: PhotoCraft prints pixels / resolution inches. */
export const printSizeMm = (image: ImageInfo, scale: number): [number, number] => {
  const mm = (px: number): number => ((px / Math.max(1, image.resolution)) * 25.4 * scale) / 100;
  return [mm(image.width), mm(image.height)];
};

/** The scale (percent) that prints `px` pixels at `resolution` as `mm` millimetres. */
export const scaleForMm = (px: number, resolution: number, mm: number): number => (mm / ((px / Math.max(1, resolution)) * 25.4)) * 100;

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
 * paper) and its own orientation (set from its image when the file was linked), then whatever
 * the item overrides (`withOverrides` false leaves those out, to show what they replace).
 */
export function effectiveParams(link: PrintLink | undefined, global: Record<string, unknown> | null | undefined, size: string | null, withOverrides = true): Record<string, unknown> | null {
  if (!global || link?.own) return link?.params ?? null;
  const own = link?.params ?? {};
  const base = { ...global, paper: size ? paperParam(size) : (own.paper ?? global.paper), orientation: own.orientation ?? global.orientation ?? 'portrait' };
  return withOverrides ? { ...base, ...(link?.overrides ?? {}) } : base;
}

export const stockKey = (productId: string, variantId: string | null | undefined): string => `${productId}:${variantId ?? ''}`;

/** The `file.print` params for one job: the link's, with the copies asked for and never a dry run or PDF output. */
export function printParams(link: PrintLink, copies: number): Record<string, unknown> {
  const { output: _o, dryRun: _d, send: _s, ...rest } = link.params;
  return { ...rest, copies: Math.max(1, Math.min(999, Math.floor(copies))), send: true };
}

/** An item's target stock: its own when set, else its A size's, else the main one. */
export const targetFor = (own: number | undefined, size: string | null, target: number, sizeTargets: Record<string, number> | undefined): number =>
  own ?? (size ? sizeTargets?.[size] : undefined) ?? target;

/** Copies of one item on one paper size, for paper planning. */
export interface PaperItem {
  key: string;
  /** The paper size it prints on ("a3"), or "custom". */
  size: string;
  copies: number;
}

/** Sheets needed per paper size: one per copy. */
export function paperNeeds(items: PaperItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) if (i.copies > 0) out[i.size] = (out[i.size] ?? 0) + i.copies;
  return out;
}

/**
 * Print counts that fit the paper on hand: per size where the copies need more sheets than
 * `stock` has, each item gets its share of the sheets in proportion to the copies it wanted
 * (largest remainders get the sheets left over, then the bigger orders). Sizes without a stock
 * figure, and sizes with enough, keep their counts.
 */
export function fitToStock(items: PaperItem[], stock: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(items.map((i) => [i.key, Math.max(0, i.copies)]));
  const bySize = new Map<string, PaperItem[]>();
  for (const i of items) if (i.copies > 0) bySize.set(i.size, [...(bySize.get(i.size) ?? []), i]);
  for (const [size, list] of bySize) {
    if (!(size in stock)) continue;
    const need = list.reduce((n, i) => n + i.copies, 0);
    const sheets = Math.max(0, Math.floor(stock[size]!));
    if (need <= sheets) continue;
    const shares = list.map((i, order) => ({ i, order, exact: (i.copies * sheets) / need }));
    let left = sheets;
    for (const s of shares) {
      out[s.i.key] = Math.floor(s.exact);
      left -= out[s.i.key]!;
    }
    shares.sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) || b.i.copies - a.i.copies || a.order - b.order);
    for (const s of shares) {
      if (left <= 0) break;
      out[s.i.key]! += 1;
      left--;
    }
  }
  return out;
}

/** Chance that a Poisson demand with this `mean` reaches `n` or more. */
export function poissonTail(mean: number, n: number): number {
  if (n <= 0) return 1;
  if (!(mean > 0)) return 0;
  // 1 - P(D < n), summing the terms in log space so a large mean doesn't underflow.
  let logTerm = -mean;
  let below = 0;
  for (let k = 0; k < n; k++) {
    if (k > 0) logTerm += Math.log(mean) - Math.log(k);
    below += Math.exp(logTerm);
  }
  return Math.min(1, Math.max(0, 1 - below));
}

/** An item for the smart fit: its copies, what it has, and what it is expected to sell at what price. */
export interface SmartItem extends PaperItem {
  onHand: number;
  /** Units it is expected to sell before the next print run; null when it has no sales to go by. */
  mean: number | null;
  price: number;
}

/**
 * Print counts that make the most of short paper: per size short of sheets, each sheet goes to the
 * copy worth the most, a copy being worth its price times the chance it sells (Poisson demand
 * around the item's forecast, after what it has on hand). Never more copies than an item asked
 * for. An item with no sales to go by takes its own count as its forecast; one with no price
 * takes the size's average price. Sizes with enough paper, or no stock figure, keep their counts.
 * `gain` is, per size, the copies and value the fitted counts are expected to sell.
 */
export function smartFit(items: SmartItem[], stock: Record<string, number>): { counts: Record<string, number>; gain: Record<string, { units: number; value: number }> } {
  const counts: Record<string, number> = Object.fromEntries(items.map((i) => [i.key, Math.max(0, i.copies)]));
  const gain: Record<string, { units: number; value: number }> = {};
  const bySize = new Map<string, SmartItem[]>();
  for (const i of items) if (i.copies > 0) bySize.set(i.size, [...(bySize.get(i.size) ?? []), i]);
  for (const [size, list] of bySize) {
    if (!(size in stock)) continue;
    const need = list.reduce((n, i) => n + i.copies, 0);
    let sheets = Math.max(0, Math.floor(stock[size]!));
    if (need <= sheets) continue;
    const priced = list.filter((i) => i.price > 0);
    const fallbackPrice = priced.length ? priced.reduce((n, i) => n + i.price, 0) / priced.length : 1;
    const state = list.map((i, order) => ({
      i,
      order,
      mean: i.mean ?? Math.max(0, i.onHand) + i.copies,
      price: i.price > 0 ? i.price : fallbackPrice,
      given: 0,
    }));
    const next = (s: (typeof state)[number]): number => s.price * poissonTail(s.mean, Math.max(0, s.i.onHand) + s.given + 1);
    gain[size] = { units: 0, value: 0 };
    for (const s of state) counts[s.i.key] = 0;
    while (sheets > 0) {
      let best: (typeof state)[number] | null = null;
      let bestValue = -1;
      for (const s of state) {
        if (s.given >= s.i.copies) continue;
        const v = next(s);
        if (v > bestValue || (v === bestValue && best && (s.mean > best.mean || (s.mean === best.mean && s.order < best.order)))) {
          best = s;
          bestValue = v;
        }
      }
      if (!best) break;
      gain[size]!.units += bestValue / best.price;
      gain[size]!.value += bestValue;
      best.given++;
      counts[best.i.key] = best.given;
      sheets--;
    }
  }
  return { counts, gain };
}
