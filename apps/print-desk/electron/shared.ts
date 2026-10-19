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

export const PAPERS = ['letter', 'legal', 'tabloid', 'a3', 'a4', 'a5', '4x6', '5x7'] as const;

export const stockKey = (productId: string, variantId: string | null | undefined): string => `${productId}:${variantId ?? ''}`;

/** The `file.print` params for one job: the link's, with the copies asked for and never a dry run or PDF output. */
export function printParams(link: PrintLink, copies: number): Record<string, unknown> {
  const { output: _o, dryRun: _d, send: _s, ...rest } = link.params;
  return { ...rest, copies: Math.max(1, Math.min(999, Math.floor(copies))), send: true };
}
