import { sdk } from './runtime';

/**
 * The server half (apps/server/src/modules/print-desk.ts): the settings every desk shares, what
 * each desk reports, and requests to a desk.
 */

export interface PrintDeskConfig {
  target?: number;
  sizeTargets?: Record<string, number>;
  itemTargets?: Record<string, number>;
  hidden?: string[];
  order?: string[];
  paperMaterials?: Record<string, string>;
  supplyMaterials?: Record<string, string>;
  global?: Record<string, unknown> | null;
  addToStock?: boolean;
  units?: 'cm' | 'mm' | 'in';
}

export interface RunItem {
  key: string;
  copies: number;
  printed: number;
  left: number;
  status: string;
  done: boolean;
  failed?: boolean;
  cancelled?: boolean;
}

export interface Desk {
  deviceId: string;
  updatedAt: number;
  online: boolean;
  name: string;
  version?: string;
  email?: string;
  allowRemote: boolean;
  printer?: string;
  counts: Record<string, number>;
  run: RunItem[];
  paper: Record<string, { needed: number; onHand: number | null }>;
  /** Ink tanks (percent left) and the maintenance cartridge (percent full), the printer's warning, and the linked material's stock. */
  supplies?: { id: string; name: string; kind: 'ink' | 'maintenance'; level: number; state: 'ok' | 'low' | 'out' | 'unknown'; material?: string; stock?: number }[];
  busy?: string;
  error?: string;
  /** What the printer waits for (its driver's prompt), and the copy that waits. */
  waiting?: string;
  waitingFor?: string;
}

export interface DeskRequest {
  id: string;
  deviceId: string | null;
  kind: 'counts' | 'print';
  payload: { counts?: Record<string, number>; onlySize?: string };
  status: 'pending' | 'taken' | 'done' | 'failed' | 'refused' | 'expired';
  result: string;
  takenBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export const getConfig = (): Promise<{ config: PrintDeskConfig; updatedAt: number }> => sdk().http.get<{ config: PrintDeskConfig; updatedAt: number }>('config');
/** Changes only the settings named; the rest stay as other devices left them. */
export const patchConfig = (patch: PrintDeskConfig): Promise<{ config: PrintDeskConfig; updatedAt: number }> => sdk().http.put<{ config: PrintDeskConfig; updatedAt: number }>('config', patch);
export const getDesks = (): Promise<{ now: number; desks: Desk[] }> => sdk().http.get<{ now: number; desks: Desk[] }>('status');
export const getRequests = (): Promise<{ requests: DeskRequest[] }> => sdk().http.get<{ requests: DeskRequest[] }>('requests');
export const sendRequest = (body: { kind: 'counts'; deviceId: string | null; counts: Record<string, number> } | { kind: 'print'; deviceId: string | null; onlySize?: string }): Promise<{ request: DeskRequest }> =>
  sdk().http.post<{ request: DeskRequest }>('requests', body);

/** The stock key Zollify uses: "pid:vid", '' for a product without variants. */
export const stockKey = (pid: string, vid: string | null | undefined): string => `${pid}:${vid ?? ''}`;

/** Print Desk only prints art prints: the product type "Art Print" (any case, plural, no space). */
export const isArtPrint = (type?: string | null): boolean => /^art\s*prints?$/i.test((type ?? '').trim());

/** The A size a variant or product name says ("A3", "Poster a4"), first name first; null for none. */
export function sizeFromName(...names: string[]): string | null {
  for (const name of names) {
    const m = /(?:^|[^a-z0-9])a([0-6])(?![a-z0-9+])/i.exec(name ?? '');
    if (m) return `a${m[1]}`;
  }
  return null;
}

/** An item's target: its own, else its A size's, else the main one - as Print Desk works it out. */
export function targetOf(config: PrintDeskConfig, key: string, size: string | null): number {
  return config.itemTargets?.[key] ?? (size ? config.sizeTargets?.[size] : undefined) ?? config.target ?? 0;
}
