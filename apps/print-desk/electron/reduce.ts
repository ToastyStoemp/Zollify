import type { DiscountRule, InventoryItem, Product } from '@zollify/shared';
import { stockKey, type CatalogRow } from './shared.js';

/**
 * Print Desk only prints art prints. Same rule as customs' isArtwork
 * (modules/customs-ch/src/lib/artwork.ts): case-insensitive, plural and a
 * missing space allowed. A copy, because @zollify/shared is TS source the
 * Electron main process cannot load at runtime.
 */
export const isArtPrint = (type?: string | null): boolean => /^art\s*prints?$/i.test((type ?? '').trim());

export interface PulledOp {
  type: string;
  payload: unknown;
}

/** Products by id: product.upsert last writer wins by updatedAt, product.delete marks deletedAt. */
function reduceProducts(ops: PulledOp[]): Map<string, Product> {
  const products = new Map<string, Product>();
  for (const op of ops) {
    if (op.type === 'product.upsert') {
      const p = op.payload as Product;
      const cur = products.get(p.id);
      if (!cur || p.updatedAt >= cur.updatedAt) products.set(p.id, p);
    } else if (op.type === 'product.delete') {
      const d = op.payload as { id?: string; deletedAt?: number; productId?: string; updatedAt?: number };
      const id = d.id ?? d.productId ?? '';
      const at = d.deletedAt ?? d.updatedAt ?? 0;
      const p = products.get(id);
      if (p && at >= p.updatedAt) products.set(id, { ...p, deletedAt: at });
    }
  }
  return products;
}

/**
 * Every live product (all types, not only art prints) and every live discount rule, for price
 * cards. Discounts reduce as the server's reduceDiscounts: discount.upsert last writer wins,
 * discount.delete ({ id, deletedAt }, or the older { ruleId, updatedAt }) deletes.
 */
export function priceData(ops: PulledOp[]): { products: Product[]; discounts: DiscountRule[] } {
  const discounts = new Map<string, DiscountRule>();
  for (const op of ops) {
    if (op.type === 'discount.upsert') {
      const r = op.payload as DiscountRule;
      const cur = discounts.get(r.id);
      if (!cur || r.updatedAt >= cur.updatedAt) discounts.set(r.id, r);
    } else if (op.type === 'discount.delete') {
      const p = op.payload as { id?: string; deletedAt?: number; ruleId?: string; updatedAt?: number };
      const id = p.id ?? p.ruleId ?? '';
      const at = p.deletedAt ?? p.updatedAt ?? 0;
      const r = discounts.get(id);
      if (r && at >= r.updatedAt) discounts.set(id, { ...r, deletedAt: at });
    }
  }
  return {
    products: [...reduceProducts(ops).values()].filter((p) => !p.deletedAt),
    discounts: [...discounts.values()].filter((d) => !d.deletedAt),
  };
}

/**
 * The live art prints and their inventory from an account's op log: product.upsert /
 * product.delete and inventory.set, last writer wins by updatedAt - the same
 * rules the server and the web app apply.
 */
export function catalogRows(ops: PulledOp[]): CatalogRow[] {
  const products = reduceProducts(ops);
  const stock = new Map<string, InventoryItem>();
  for (const op of ops) {
    if (op.type === 'inventory.set') {
      const i = op.payload as InventoryItem;
      const k = stockKey(i.productId, i.variantId);
      const cur = stock.get(k);
      if (!cur || i.updatedAt >= cur.updatedAt) stock.set(k, i);
    }
  }
  const rows: CatalogRow[] = [];
  for (const p of products.values()) {
    if (p.deletedAt || !isArtPrint(p.type)) continue;
    const variants = p.variants ?? [];
    const row = (variantId: string, variant: string, sku: string): CatalogRow => {
      const key = stockKey(p.id, variantId);
      return { key, productId: p.id, variantId, title: p.title || '', variant, sku, onHand: stock.get(key)?.onHand ?? 0 };
    };
    if (variants.length) for (const v of variants) rows.push(row(v.id, v.name || '', v.sku || p.sku || ''));
    else rows.push(row('', '', p.sku || ''));
  }
  rows.sort((a, b) => `${a.title} ${a.variant}`.localeCompare(`${b.title} ${b.variant}`));
  return rows;
}

/** What the last closed event sold, per stock key. */
export interface EventSold {
  event: { id: string; name: string; dateStart?: string; dateEnd?: string };
  sold: Record<string, number>;
}

interface EventLike {
  id: string;
  name?: string;
  kind?: string;
  status?: string;
  dateStart?: string;
  dateEnd?: string;
  updatedAt: number;
  deletedAt?: number;
}

/**
 * The last closed event (by end date, else start date, else when it last changed; stores are
 * not events) and the copies it sold of each item: tx.create lines of that event, less reverted
 * sales (tx.revert). Events reduce as the server does: event.upsert last writer wins, event.close
 * closes. null when no event is closed.
 * ponytail: sales of products merged away later (product.merge) stay under the old product, which
 * Print Desk no longer lists; map them through the merges if that comes up.
 */
interface SaleLike {
  eventId: string;
  timestamp: number;
  items: { pid: string; vid: string | null; qty: number }[];
}

/**
 * Events and sales as the server reduces them: event.upsert last writer wins, event.close closes;
 * tx.create once per id, less reverted ones (tx.revert, ZollTool's `txId` or Zollify's `id`).
 */
function eventsAndSales(ops: PulledOp[]): { events: Map<string, EventLike>; sales: SaleLike[] } {
  const events = new Map<string, EventLike>();
  const txs = new Map<string, SaleLike>();
  const reverted = new Set<string>();
  for (const op of ops) {
    if (op.type === 'event.upsert') {
      const e = op.payload as EventLike;
      const cur = events.get(e.id);
      if (!cur || e.updatedAt >= cur.updatedAt) events.set(e.id, e);
    } else if (op.type === 'event.close') {
      const { eventId, updatedAt } = op.payload as { eventId: string; updatedAt: number };
      const e = events.get(eventId);
      if (e && updatedAt >= e.updatedAt) events.set(eventId, { ...e, status: 'closed', updatedAt });
    } else if (op.type === 'tx.create') {
      const tx = op.payload as { id: string; eventId: string; timestamp?: number; items?: SaleLike['items'] };
      if (!txs.has(tx.id)) txs.set(tx.id, { eventId: tx.eventId, timestamp: Number(tx.timestamp) || 0, items: tx.items ?? [] });
    } else if (op.type === 'tx.revert') {
      // ZollTool wrote `txId`, Zollify writes `id` (as the server reads it).
      const p = op.payload as { txId?: string; id?: string };
      reverted.add(p.txId ?? p.id ?? '');
    }
  }
  return { events, sales: [...txs].filter(([id]) => !reverted.has(id)).map(([, tx]) => tx) };
}

export function lastClosedEventSold(ops: PulledOp[]): EventSold | null {
  const { events, sales } = eventsAndSales(ops);
  const when = (e: EventLike): string => e.dateEnd || e.dateStart || '';
  const closed = [...events.values()].filter((e) => e.status === 'closed' && !e.deletedAt && e.kind !== 'store');
  closed.sort((a, b) => when(b).localeCompare(when(a)) || b.updatedAt - a.updatedAt);
  const event = closed[0];
  if (!event) return null;
  const sold: Record<string, number> = {};
  for (const tx of sales) {
    if (tx.eventId !== event.id) continue;
    for (const item of tx.items) {
      const key = stockKey(item.pid, item.vid);
      sold[key] = (sold[key] ?? 0) + (Number(item.qty) || 0);
    }
  }
  return { event: { id: event.id, name: event.name ?? '', dateStart: event.dateStart, dateEnd: event.dateEnd }, sold };
}

/** What items sell, for planning a print run: see `demandForecast`. */
export interface DemandForecast {
  /** The event planned for: the next one to come, with its days and how busy its earlier editions were. */
  event: { name: string; days: number; factor: number } | null;
  /** Event days the forecast covers: the next event's (times its factor), or an average event's. */
  horizonDays: number;
  /** Units sold per event day, by stock key, over the last year. Items that never sold are absent. */
  perDay: Record<string, number>;
  /** Price by stock key: the variant's, else the product's. */
  price: Record<string, number>;
}

const DAY_MS = 86_400_000;
/** A date range longer than this is a store-like run, not a show. */
const MAX_RANGE_DAYS = 31;
const isoDay = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** Days in an event's date range, both ends counted; null without dates or for a long run. */
function rangeDays(e: EventLike): number | null {
  const a = e.dateStart || e.dateEnd;
  const b = e.dateEnd || e.dateStart;
  if (!a || !b) return null;
  const n = Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / DAY_MS) + 1;
  return n >= 1 && n <= MAX_RANGE_DAYS ? n : null;
}

/**
 * Demand per item, as the Sourcing forecast reckons it in a simpler form: units sold per event day
 * at events (stores sell every day and would drown the rate) over the last year, an event's days
 * being its date range, or the days it sold when it has none. The next event to come sets the days
 * to plan for, scaled by how busy its earlier editions (same series) were against the average.
 * ponytail: no sold-out correction (Sourcing's "exposure"), so an item that sold out early reads a
 * little slow; add it from event stock if smart fits starve sell-outs.
 */
export function demandForecast(ops: PulledOp[], today: string): DemandForecast {
  const { events, sales } = eventsAndSales(ops);
  const shows = new Map([...events].filter(([, e]) => e.kind !== 'store' && !e.deletedAt));
  const since = Date.parse(`${today}T00:00:00`) - 365 * DAY_MS;
  // Per event: units, selling days, and per item units.
  const perEvent = new Map<string, { units: number; days: Set<string>; recent: boolean }>();
  const recentUnits = new Map<string, number>();
  for (const t of sales) {
    if (!shows.has(t.eventId)) continue;
    const ev = perEvent.get(t.eventId) ?? { units: 0, days: new Set<string>(), recent: false };
    perEvent.set(t.eventId, ev);
    const recent = t.timestamp >= since;
    ev.recent ||= recent;
    ev.days.add(isoDay(t.timestamp));
    for (const it of t.items) {
      const qty = Number(it.qty) || 0;
      ev.units += qty;
      if (recent) recentUnits.set(stockKey(it.pid, it.vid), (recentUnits.get(stockKey(it.pid, it.vid)) ?? 0) + qty);
    }
  }
  const daysOf = (id: string): number => rangeDays(shows.get(id)!) ?? perEvent.get(id)!.days.size;
  let recentDays = 0;
  let allDays = 0;
  let allUnits = 0;
  for (const [id, ev] of perEvent) {
    const d = daysOf(id);
    allDays += d;
    allUnits += ev.units;
    if (ev.recent) recentDays += d;
  }
  const perDay: Record<string, number> = {};
  if (recentDays > 0) for (const [k, n] of recentUnits) perDay[k] = n / recentDays;
  const averageEventDays = perEvent.size ? allDays / perEvent.size : 1;

  const startOf = (e: EventLike): string => e.dateStart || e.dateEnd || '9999';
  const next = [...shows.values()]
    .filter((e) => e.status !== 'closed' && (e.dateEnd || e.dateStart || '9999') >= today)
    .sort((a, b) => startOf(a).localeCompare(startOf(b)))[0];
  let event: DemandForecast['event'] = null;
  if (next) {
    const n = next as EventLike & { seriesId?: string };
    let units = 0;
    let days = 0;
    for (const [id, ev] of perEvent) {
      const e = shows.get(id) as EventLike & { seriesId?: string };
      if (n.seriesId && e.seriesId === n.seriesId && e.id !== n.id && startOf(e) < startOf(n)) {
        units += ev.units;
        days += daysOf(id);
      }
    }
    const avg = allDays ? allUnits / allDays : 0;
    const factor = days && avg ? Math.round((units / days / avg) * 100) / 100 : 1;
    event = { name: next.name ?? '', days: rangeDays(next) ?? Math.max(1, Math.round(averageEventDays)), factor };
  }

  const products = new Map<string, Product>();
  for (const op of ops) {
    if (op.type !== 'product.upsert') continue;
    const p = op.payload as Product;
    const cur = products.get(p.id);
    if (!cur || p.updatedAt >= cur.updatedAt) products.set(p.id, p);
  }
  const price: Record<string, number> = {};
  for (const p of products.values()) {
    if (p.variants?.length) for (const v of p.variants) price[stockKey(p.id, v.id)] = Number(v.price ?? p.price) || 0;
    else price[stockKey(p.id, '')] = Number(p.price) || 0;
  }
  return { event, horizonDays: event ? event.days * event.factor : averageEventDays, perDay, price };
}
