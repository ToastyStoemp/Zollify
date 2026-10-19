import type { InventoryItem, Product } from '@zollify/shared';
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

/**
 * The live art prints and their inventory from an account's op log: product.upsert /
 * product.delete and inventory.set, last writer wins by updatedAt - the same
 * rules the server and the web app apply.
 */
export function catalogRows(ops: PulledOp[]): CatalogRow[] {
  const products = new Map<string, Product>();
  const stock = new Map<string, InventoryItem>();
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
    } else if (op.type === 'inventory.set') {
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
export function lastClosedEventSold(ops: PulledOp[]): EventSold | null {
  const events = new Map<string, EventLike>();
  const txs = new Map<string, { eventId: string; items: { pid: string; vid: string | null; qty: number }[] }>();
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
      const tx = op.payload as { id: string; eventId: string; items?: { pid: string; vid: string | null; qty: number }[] };
      if (!txs.has(tx.id)) txs.set(tx.id, { eventId: tx.eventId, items: tx.items ?? [] });
    } else if (op.type === 'tx.revert') {
      // ZollTool wrote `txId`, Zollify writes `id` (as the server reads it).
      const p = op.payload as { txId?: string; id?: string };
      reverted.add(p.txId ?? p.id ?? '');
    }
  }
  const when = (e: EventLike): string => e.dateEnd || e.dateStart || '';
  const closed = [...events.values()].filter((e) => e.status === 'closed' && !e.deletedAt && e.kind !== 'store');
  closed.sort((a, b) => when(b).localeCompare(when(a)) || b.updatedAt - a.updatedAt);
  const event = closed[0];
  if (!event) return null;
  const sold: Record<string, number> = {};
  for (const [id, tx] of txs) {
    if (tx.eventId !== event.id || reverted.has(id)) continue;
    for (const item of tx.items) {
      const key = stockKey(item.pid, item.vid);
      sold[key] = (sold[key] ?? 0) + (Number(item.qty) || 0);
    }
  }
  return { event: { id: event.id, name: event.name ?? '', dateStart: event.dateStart, dateEnd: event.dateEnd }, sold };
}
