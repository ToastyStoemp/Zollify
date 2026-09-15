import type { Product, ProductMerge } from '@zollify/shared';
import { buildMergeMap, mergeKey, remapTxItems, resolveMergedRef } from '@zollify/shared';
import { openCoreDb, type CoreDb } from './db';
import { getAccount } from '../session';
import { queueOp } from './outbox';
import { toPlain } from './plain';
import { deleteProduct, loadCatalog, upsertProduct } from './catalog';
import { loadDiscounts } from './discounts';
import { loadInventory } from './inventory';
import { loadSalesEvents } from './sales-events';
import { loadTransactions } from './transactions';

/**
 * Product merge - ported from ZollTool. Two or more plain products fold into
 * one product with a variant each, and their whole sales history re-attaches
 * to those variants through one append-only `product.merge` op. Nothing is
 * lost and nothing needs a resync: every device materialises the same op.
 */

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Merging was attempted while signed out.');
  return account.accountId;
}

/**
 * Rewrites the local tables for one merge: sale lines, claims, on-hand
 * counts, discount targets and local price overrides. Idempotent - once a
 * source key is remapped it no longer matches, so a second run is a no-op.
 */
export async function materializeMerge(db: CoreDb, merge: ProductMerge): Promise<void> {
  const map = buildMergeMap([merge]);
  if (!map.size) return;
  const now = Date.now();

  for (const tx of await db.transactions.toArray()) {
    const items = remapTxItems(tx.items, map);
    if (items !== tx.items) await db.transactions.put({ ...tx, items });
  }

  // Claims and on-hand counts: re-key, folding into an existing target row.
  for (const row of await db.eventStock.toArray()) {
    const t = resolveMergedRef(map, row.productId, row.variantId || null);
    if (!t) continue;
    await db.eventStock.delete([row.eventId, row.productId, row.variantId]);
    const key: [string, string, string] = [row.eventId, t.pid, t.vid ?? ''];
    const existing = await db.eventStock.get(key);
    await db.eventStock.put({ eventId: row.eventId, productId: t.pid, variantId: t.vid ?? '', broughtQty: (existing?.broughtQty ?? 0) + row.broughtQty, updatedAt: now });
  }
  for (const row of await db.inventory.toArray()) {
    const t = resolveMergedRef(map, row.productId, row.variantId || null);
    if (!t) continue;
    await db.inventory.delete([row.productId, row.variantId]);
    const key: [string, string] = [t.pid, t.vid ?? ''];
    const existing = await db.inventory.get(key);
    // Keep the earliest count time: "sold since count" must still see every
    // sale either side of the merge made after its own count.
    await db.inventory.put({ productId: t.pid, variantId: t.vid ?? '', onHand: (existing?.onHand ?? 0) + row.onHand, updatedAt: Math.min(existing?.updatedAt ?? row.updatedAt, row.updatedAt) });
  }

  for (const rule of await db.discounts.toArray()) {
    let changed = false;
    const variantIds = new Set(rule.variantIds ?? []);
    const productIds = (rule.productIds ?? []).filter((pid) => {
      const t = resolveMergedRef(map, pid, null);
      if (!t) return true;
      // A whole-product target becomes a variant target under the merged product.
      changed = true;
      variantIds.add(mergeKey(t.pid, t.vid));
      return false;
    });
    for (const vref of rule.variantIds ?? []) {
      const [pid = '', vid] = vref.split(':');
      const t = resolveMergedRef(map, pid, vid ?? null);
      if (t) {
        changed = true;
        variantIds.delete(vref);
        variantIds.add(mergeKey(t.pid, t.vid));
      }
    }
    if (changed) await db.discounts.put({ ...rule, productIds, variantIds: [...variantIds], updatedAt: now });
  }

  for (const event of await db.events.toArray()) {
    if (!event.localPriceOverrides) continue;
    let changed = false;
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(event.localPriceOverrides)) {
      const [pid = '', vid] = k.split(':');
      const t = resolveMergedRef(map, pid, vid ?? null);
      if (t) {
        changed = true;
        next[mergeKey(t.pid, t.vid)] = v;
      } else next[k] = v;
    }
    if (changed) await db.events.put({ ...event, localPriceOverrides: next, updatedAt: now });
  }
}

async function reloadAll(): Promise<void> {
  await Promise.all([loadCatalog(), loadSalesEvents(), loadTransactions(), loadDiscounts(), loadInventory()]);
}

/**
 * Merges products: `merged` survives (reusing the primary's id), the other
 * sources are tombstoned, and the merge op carries the remap for every device.
 */
export async function mergeProducts(merged: Product, merge: ProductMerge, removedIds: string[]): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const record = toPlain(merge);
  await upsertProduct(merged);
  for (const pid of removedIds) if (pid !== merged.id) await deleteProduct(pid);
  await queueOp({ type: 'product.merge', payload: record });
  await materializeMerge(db, record);
  await reloadAll();
}
