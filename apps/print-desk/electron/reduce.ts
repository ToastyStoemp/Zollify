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
