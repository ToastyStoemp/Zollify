import { computed, reactive, ref } from 'vue';
import type { EventStock, InventoryItem } from '@boothly/shared';
import { openCoreDb } from './db';
import { getAccount } from '../session';
import { queueOp } from './outbox';
import { toPlain } from './plain';
import { recentTransactions } from './transactions';
import { allProducts } from './catalog';

/**
 * One inventory, with per-event claims on top.
 *
 * The booth owns a single pile of stock. An event may *claim* part of it, and
 * a claim is reserved — no other event can sell against it. An event with no
 * claim sells from whatever is left unclaimed, which is the normal case for a
 * booth working one event at a time.
 *
 * Nothing here is a running balance. `onHand` is what was counted; what is
 * still sellable is derived from recorded sales every time it is asked for.
 * A counter decremented per sale drifts the moment a sale is reverted or
 * arrives late from another register, and recomputing cannot drift.
 */

const items = reactive(new Map<string, InventoryItem>());
const claims = reactive(new Map<string, EventStock>());
const loaded = ref(false);

/** Inventory is keyed by product and variant; '' is the product itself. */
export function stockKey(productId: string, variantId: string | null | undefined): string {
  return `${productId}:${variantId ?? ''}`;
}

function claimKey(eventId: string, productId: string, variantId: string | null | undefined): string {
  return `${eventId}:${productId}:${variantId ?? ''}`;
}

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Inventory was used while signed out.');
  return account.accountId;
}

export async function loadInventory(): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const [stock, claimRows] = await Promise.all([
    db.inventory.toArray(),
    db.eventStock.toArray(),
  ]);

  items.clear();
  for (const row of stock) items.set(stockKey(row.productId, row.variantId), row);

  claims.clear();
  for (const row of claimRows) {
    claims.set(claimKey(row.eventId, row.productId, row.variantId), row);
  }

  loaded.value = true;
}

export const inventoryLoaded = computed(() => loaded.value);

export function onHandFor(productId: string, variantId: string | null = ''): number {
  return items.get(stockKey(productId, variantId))?.onHand ?? 0;
}

export function claimFor(
  eventId: string,
  productId: string,
  variantId: string | null = '',
): number | null {
  const row = claims.get(claimKey(eventId, productId, variantId));
  // null and 0 mean different things: no claim falls back to the shared pool,
  // a claim of 0 is a deliberate "take none of these".
  return row ? row.broughtQty : null;
}

export function claimsForEvent(eventId: string): EventStock[] {
  return [...claims.values()].filter((c) => c.eventId === eventId);
}

// ── Writes ──────────────────────────────────────────────────────────────────

export async function setOnHand(
  productId: string,
  variantId: string | null,
  onHand: number,
): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const row: InventoryItem = toPlain({
    productId,
    variantId: variantId ?? '',
    onHand: Math.max(0, Math.floor(onHand)),
    updatedAt: Date.now(),
  });
  await db.inventory.put(row);
  items.set(stockKey(productId, variantId), row);
  await queueOp({ type: 'inventory.set', payload: row });
}

export async function setClaim(
  eventId: string,
  productId: string,
  variantId: string | null,
  qty: number,
): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const row: EventStock = toPlain({
    eventId,
    productId,
    variantId: variantId ?? '',
    broughtQty: Math.max(0, Math.floor(qty)),
    updatedAt: Date.now(),
  });
  await db.eventStock.put(row);
  claims.set(claimKey(eventId, productId, variantId), row);
  await queueOp({ type: 'stock.set', payload: row });
}

/**
 * Drops a claim so the event falls back to the shared pool.
 *
 * Distinct from claiming zero, which reserves nothing but still says "this
 * event takes none of these" — the difference matters when reading a packing
 * list back.
 */
export async function clearClaim(
  eventId: string,
  productId: string,
  variantId: string | null,
): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const key: [string, string, string] = [eventId, productId, variantId ?? ''];
  await db.eventStock.delete(key);
  claims.delete(claimKey(eventId, productId, variantId));
  // Sync carries a tombstone rather than a deletion: the wire protocol has no
  // stock.delete, and a claim of -1 is unambiguous as "no claim".
  await queueOp({
    type: 'stock.set',
    payload: { eventId, productId, variantId: variantId ?? '', broughtQty: -1, updatedAt: Date.now() },
  });
}

export async function replaceInventory(rows: InventoryItem[]): Promise<void> {
  const db = openCoreDb(requireAccountId());
  await db.inventory.bulkPut(rows.map(toPlain));
  for (const row of rows) items.set(stockKey(row.productId, row.variantId), row);
}

export async function replaceClaims(rows: EventStock[]): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const live = rows.filter((r) => r.broughtQty >= 0);
  if (live.length) await db.eventStock.bulkPut(live.map(toPlain));
  for (const row of rows) {
    const key = claimKey(row.eventId, row.productId, row.variantId);
    if (row.broughtQty < 0) claims.delete(key);
    else claims.set(key, row);
  }
}

// ── Derived availability ────────────────────────────────────────────────────

/** Units sold per stock key, by event. Reverted sales do not count. */
const soldByEventAndKey = computed(() => {
  const byEvent = new Map<string, Map<string, number>>();
  for (const tx of recentTransactions.value) {
    if (tx.revertedAt) continue;
    const forEvent = byEvent.get(tx.eventId) ?? new Map<string, number>();
    for (const item of tx.items) {
      const key = stockKey(item.pid, item.vid);
      forEvent.set(key, (forEvent.get(key) ?? 0) + item.qty);
    }
    byEvent.set(tx.eventId, forEvent);
  }
  return byEvent;
});

export function soldAt(eventId: string, productId: string, variantId: string | null = ''): number {
  return soldByEventAndKey.value.get(eventId)?.get(stockKey(productId, variantId)) ?? 0;
}

/** Every sale of this item, across every event. */
export function soldTotal(productId: string, variantId: string | null = ''): number {
  const key = stockKey(productId, variantId);
  let total = 0;
  for (const forEvent of soldByEventAndKey.value.values()) total += forEvent.get(key) ?? 0;
  return total;
}

/** Units claimed by every event, for one item. */
export function claimedTotal(productId: string, variantId: string | null = ''): number {
  const key = stockKey(productId, variantId);
  let total = 0;
  for (const claim of claims.values()) {
    if (stockKey(claim.productId, claim.variantId) === key) total += claim.broughtQty;
  }
  return total;
}

/**
 * Units sold by events that hold no claim, per item.
 *
 * These all draw on the same shared pile, so they are counted together. Sales
 * made against a claim are excluded: that stock was already set aside.
 */
function poolSoldByKey(): Map<string, number> {
  const out = new Map<string, number>();
  for (const [soldEventId, forEvent] of soldByEventAndKey.value) {
    for (const [key, qty] of forEvent) {
      const [pid = '', vid = ''] = key.split(':');
      if (claimFor(soldEventId, pid, vid) !== null) continue;
      out.set(key, (out.get(key) ?? 0) + qty);
    }
  }
  return out;
}

/**
 * Stock nobody has claimed and nobody has sold — what an unclaimed event can
 * draw on.
 *
 * Sales made from a claim are deliberately not subtracted here: they were
 * already accounted for when the stock was claimed. Subtracting both is the
 * obvious mistake, and it makes the pool shrink twice for one sale.
 */
export function freeFor(productId: string, variantId: string | null = ''): number {
  const key = stockKey(productId, variantId);
  return onHandFor(productId, variantId) - claimedTotal(productId, variantId) - (poolSoldByKey().get(key) ?? 0);
}

export interface Availability {
  productId: string;
  variantId: string;
  label: string;
  onHand: number;
  /** This event's claim, or null when it sells from the shared pool. */
  claimed: number | null;
  soldHere: number;
  /** Claimed by other events, and therefore untouchable from here. */
  reservedElsewhere: number;
  /** What this event can still sell. */
  available: number;
  source: 'claim' | 'pool';
}

/**
 * What one event can still sell of each item.
 *
 * With a claim: the claim minus what this event has already sold. The shared
 * pool is irrelevant — that is what reserving means.
 *
 * Without a claim: everything not owned by someone else's claim, minus what
 * every unclaimed event has sold out of that same pool. Two events with no
 * claims genuinely share one pile, and pretending otherwise would let a booth
 * sell the same print twice.
 */
export function availabilityFor(eventId: string): Availability[] {
  const rows: Availability[] = [];

  const poolSold = poolSoldByKey();

  for (const product of allProducts.value) {
    const variants = product.variants ?? [];
    const entries = variants.length
      ? variants.map((v) => ({ id: v.id, label: `${product.title} · ${v.name}` }))
      : [{ id: '', label: product.title }];

    for (const entry of entries) {
      const key = stockKey(product.id, entry.id);
      const onHand = onHandFor(product.id, entry.id);
      const claimed = claimFor(eventId, product.id, entry.id);
      const soldHere = soldAt(eventId, product.id, entry.id);
      const totalClaimed = claimedTotal(product.id, entry.id);

      const reservedElsewhere = totalClaimed - (claimed ?? 0);
      const available =
        claimed !== null
          ? claimed - soldHere
          : onHand - totalClaimed - (poolSold.get(key) ?? 0);

      rows.push({
        productId: product.id,
        variantId: entry.id,
        label: entry.label,
        onHand,
        claimed,
        soldHere,
        reservedElsewhere,
        available,
        source: claimed !== null ? 'claim' : 'pool',
      });
    }
  }

  return rows;
}

export interface InventoryRow {
  productId: string;
  variantId: string;
  label: string;
  onHand: number;
  claimed: number;
  sold: number;
  /** Unclaimed and unsold — what an event with no claim can draw on. */
  free: number;
  /** More is promised or already gone than the booth owns. */
  overCommitted: boolean;
}

/** The whole inventory, with what is spoken for. */
export function inventoryRows(): InventoryRow[] {
  const rows: InventoryRow[] = [];

  for (const product of allProducts.value) {
    const variants = product.variants ?? [];
    const entries = variants.length
      ? variants.map((v) => ({ id: v.id, label: `${product.title} · ${v.name}` }))
      : [{ id: '', label: product.title }];

    for (const entry of entries) {
      const onHand = onHandFor(product.id, entry.id);
      const claimed = claimedTotal(product.id, entry.id);
      const sold = soldTotal(product.id, entry.id);
      const free = freeFor(product.id, entry.id);

      rows.push({
        productId: product.id,
        variantId: entry.id,
        label: entry.label,
        onHand,
        claimed,
        sold,
        free,
        // A negative pool is the honest signal: between claims and sales, more
        // has been committed than exists.
        overCommitted: free < 0,
      });
    }
  }

  return rows;
}

export function resetInventoryCache(): void {
  items.clear();
  claims.clear();
  loaded.value = false;
}
