/**
 * One normalised payment-source row. Every importer — myPOS, SumUp, Shopify —
 * emits this shape, so the clustering engine in the client never knows which
 * provider a row came from beyond `source`.
 */
export interface SourceRow {
  date: string;
  type: 'Payment' | 'Fee';
  /** Signed: + for a sale, − for a fee. */
  amount: number;
  currency: string;
  terminal: string;
  card: string;
  ref: string;
  desc: string;
  source: 'mypos' | 'sumup' | 'shopify';
  isOnline: boolean;
  /** Shopify order number, when the row is an order. */
  orderNum?: string;
  /** Paid by a manual / custom gateway — likely already in the card data. */
  isManual?: boolean;
  /** myPOS device serial, used to name the device once. */
  serial?: string;
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
export const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const str = (v: unknown): string => (v == null ? '' : String(v));
export const pick = (row: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (row[k] != null) return row[k];
  return undefined;
};
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const dayStartISO = (d: string): string => (/T/.test(d) ? d : `${d}T00:00:00Z`);
export const dayEndISO = (d: string): string => (/T/.test(d) ? d : `${d}T23:59:59Z`);

/** live when credentials are present, unless the mode hint says otherwise. */
export function resolveMode(hint: string | undefined, hasCreds: boolean): 'live' | 'mock' {
  const m = (hint ?? '').trim().toLowerCase();
  return m === 'mock' ? 'mock' : m === 'live' ? 'live' : hasCreds ? 'live' : 'mock';
}

export class SourceError extends Error {
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
  }
}

/** Small key/value cache a client may use; backed by SQLite per account. */
export interface KvCache {
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown): void;
}
