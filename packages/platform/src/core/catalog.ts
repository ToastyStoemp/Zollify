import { computed, reactive, ref } from 'vue';
import type { Product } from '@zollify/shared';
import { openCoreDb } from './db';
import { getAccount } from '../session';
import { queueOp } from './outbox';
import { toPlain } from './plain';

/**
 * The product catalogue.
 *
 * Modules never open this table themselves - they read it through
 * `sdk.data.products`. Keeping the only writer here means the outbox stays
 * consistent: every mutation records an op for sync, and a module cannot write
 * a product without one.
 */

const products = reactive(new Map<string, Product>());
const loaded = ref(false);

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('The catalogue was used while signed out.');
  return account.accountId;
}

export async function loadCatalog(): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const rows = await db.products.toArray();
  products.clear();
  for (const row of rows) {
    if (!row.deletedAt) products.set(row.id, row);
  }
  loaded.value = true;
}

export const catalogLoaded = computed(() => loaded.value);

/** Everything sellable, title-sorted. Soft-deleted rows never appear. */
export const allProducts = computed(() =>
  [...products.values()].sort(
    // Manual order first - it is what a seller arranges on the tile grid so the
    // things they sell most are where their hand already is. Title breaks ties.
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.title.localeCompare(b.title),
  ),
);

export const forSaleProducts = computed(() => allProducts.value.filter((p) => p.forSale));

export function getProduct(id: string): Product | undefined {
  return products.get(id);
}

/**
 * Catalogue prices a helper may see.
 *
 * A helper is scoped to their events and should not learn the full price list;
 * this mirrors the restriction ZollTool enforces, and the server enforces the
 * same thing on sync. Hiding it here is convenience, not the control.
 */
export function visibleProductsFor(role: string, isHelper: boolean): Product[] {
  const list = forSaleProducts.value;
  if (role !== 'member' || !isHelper) return list;
  return list.filter((p) => !p.unlisted);
}

export async function upsertProduct(product: Product): Promise<void> {
  const db = openCoreDb(requireAccountId());
  // Plain data before it reaches IndexedDB - a caller may hand us reactive
  // state, and the structured clone algorithm cannot clone a Proxy.
  const next: Product = toPlain({ ...product, updatedAt: Date.now() });
  await db.products.put(next);
  products.set(next.id, next);
  await queueOp({ type: 'product.upsert', payload: next });
}

/**
 * Soft delete. Sync is last-write-wins across devices, so a hard delete would
 * simply be resurrected by any device that still had the row.
 */
export async function deleteProduct(id: string): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const existing = await db.products.get(id);
  if (!existing) return;
  const tombstoned: Product = toPlain({ ...existing, deletedAt: Date.now(), updatedAt: Date.now() });
  await db.products.put(tombstoned);
  products.delete(id);
  await queueOp({ type: 'product.delete', payload: { id, deletedAt: tombstoned.deletedAt } });
}

/** Replaces the local catalogue wholesale - used by sync pulls and the importer. */
export async function replaceCatalog(rows: Product[]): Promise<void> {
  const db = openCoreDb(requireAccountId());
  await db.products.bulkPut(rows.map(toPlain));
  for (const row of rows) {
    if (row.deletedAt) products.delete(row.id);
    else products.set(row.id, row);
  }
}

export function resetCatalogCache(): void {
  products.clear();
  loaded.value = false;
}
