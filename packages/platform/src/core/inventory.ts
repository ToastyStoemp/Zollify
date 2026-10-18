import { computed, reactive, ref } from 'vue';
import type { EventStock, InventoryItem, SalesEvent } from '@zollify/shared';
import { eventHasEnded, localIsoDay } from '@zollify/shared';
import { openCoreDb } from './db';
import { getAccount } from '../session';
import { queueOp } from './outbox';
import { toPlain } from './plain';
import { recentTransactions } from './transactions';
import { allProducts } from './catalog';
import { getSalesEvent } from './sales-events';

/**
 * One inventory, with per-event claims on top.
 *
 * The booth owns a single pile of stock. An event may *claim* part of it, and
 * a claim is reserved - no other event can sell against it. An event with no
 * claim sells from whatever is left unclaimed, which is the normal case for a
 * booth working one event at a time.
 *
 * Nothing here is a running balance. `onHand` is what was counted, and when;
 * what is still sellable is that count minus the sales made *since* it - a
 * count already reflects everything sold before it. Deriving from recorded
 * sales every time means a reverted or late-arriving sale cannot drift the
 * figure the way a decremented counter would.
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

/** When the item was last counted; 0 when it never was, so every sale counts. */
export function countedAt(productId: string, variantId: string | null = ''): number {
  return items.get(stockKey(productId, variantId))?.updatedAt ?? 0;
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

/** Every claim, all events. Reactive. */
export function allClaims(): EventStock[] {
  return [...claims.values()];
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
  opts: { carried?: { from: string; qty: number } } = {},
): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const broughtQty = Math.max(0, Math.floor(qty));
  // An edit keeps where the stock came from, never more of it than is now claimed.
  const prior = claims.get(claimKey(eventId, productId, variantId))?.carried;
  const carried = opts.carried ?? prior;
  const row: EventStock = toPlain({
    eventId,
    productId,
    variantId: variantId ?? '',
    broughtQty,
    updatedAt: Date.now(),
    ...(carried && carried.qty > 0 && broughtQty > 0 ? { carried: { from: carried.from, qty: Math.min(Math.floor(carried.qty), broughtQty) } } : {}),
  });
  await db.eventStock.put(row);
  claims.set(claimKey(eventId, productId, variantId), row);
  await queueOp({ type: 'stock.set', payload: row });
}

/**
 * When a claim was cleared. The row itself is gone (nothing else has to skip
 * a tombstone), so this is what stops an older claim that syncs in late -
 * from a device that was offline - bringing it back, as the server's
 * last-change-wins already does (reduceStock).
 */
const CLEARED_PREFIX = 'core.claimCleared.';
const clearedKey = (key: [string, string, string]): string => `${CLEARED_PREFIX}${key.join('|')}`;
export async function rememberClaimCleared(db: ReturnType<typeof openCoreDb>, key: [string, string, string], at: number): Promise<void> {
  await db.settings.put({ key: clearedKey(key), value: at });
}
export async function claimClearedAt(db: ReturnType<typeof openCoreDb>, key: [string, string, string]): Promise<number> {
  const row = await db.settings.get(clearedKey(key));
  return typeof row?.value === 'number' ? row.value : 0;
}

/**
 * Drops a claim so the event falls back to the shared pool.
 *
 * Distinct from claiming zero, which reserves nothing but still says "this
 * event takes none of these" - the difference matters when reading a packing
 * list back.
 */
export async function clearClaim(
  eventId: string,
  productId: string,
  variantId: string | null,
): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const key: [string, string, string] = [eventId, productId, variantId ?? ''];
  const now = Date.now();
  await db.eventStock.delete(key);
  await rememberClaimCleared(db, key, now);
  claims.delete(claimKey(eventId, productId, variantId));
  // Sync carries a tombstone rather than a deletion: the wire protocol has no
  // stock.delete, and a claim of -1 is unambiguous as "no claim".
  await queueOp({
    type: 'stock.set',
    payload: { eventId, productId, variantId: variantId ?? '', broughtQty: -1, updatedAt: now },
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

// The per-key sums below are computeds, not loops per call: a catalogue
// screen asks for them once per row, and a row-by-row scan of every
// transaction is what made pages crawl once the history grew.

/** Like soldByEventAndKey, but only sales made after the item's last count - the ones the count does not already reflect. */
const soldSinceCountByEventAndKey = computed(() => {
  const byEvent = new Map<string, Map<string, number>>();
  for (const tx of recentTransactions.value) {
    if (tx.revertedAt) continue;
    const forEvent = byEvent.get(tx.eventId) ?? new Map<string, number>();
    for (const item of tx.items) {
      const key = stockKey(item.pid, item.vid);
      if (tx.timestamp < (items.get(key)?.updatedAt ?? 0)) continue;
      forEvent.set(key, (forEvent.get(key) ?? 0) + item.qty);
    }
    byEvent.set(tx.eventId, forEvent);
  }
  return byEvent;
});

const soldTotalByKey = computed(() => {
  const out = new Map<string, number>();
  for (const forEvent of soldByEventAndKey.value.values()) {
    for (const [key, qty] of forEvent) out.set(key, (out.get(key) ?? 0) + qty);
  }
  return out;
});

/** Every sale of this item ever, across every event - a lifetime counter, not what Free subtracts. */
export function soldTotal(productId: string, variantId: string | null = ''): number {
  return soldTotalByKey.value.get(stockKey(productId, variantId)) ?? 0;
}

const soldSinceCountByKey = computed(() => {
  const out = new Map<string, number>();
  for (const forEvent of soldSinceCountByEventAndKey.value.values()) {
    for (const [key, qty] of forEvent) out.set(key, (out.get(key) ?? 0) + qty);
  }
  return out;
});

/**
 * What is physically left of the pile: the last count minus every sale made
 * since, claimed or not. Unlike Free, claims are not subtracted - claimed
 * stock still exists, it is only promised.
 */
export function remainingFor(productId: string, variantId: string | null = ''): number {
  return onHandFor(productId, variantId) - (soldSinceCountByKey.value.get(stockKey(productId, variantId)) ?? 0);
}

/**
 * A claim only reserves stock while its event is still to come or under way.
 * Once the event is over (closed, or its last day has passed) whatever it
 * took is either sold - and counted as such - or back in the pile.
 */
export function eventIsOver(event: SalesEvent | undefined, today = localIsoDay()): boolean {
  // No event (deleted, or never synced here): nothing to reserve for.
  if (!event) return true;
  return eventHasEnded(event, today);
}

/** Units carried on from each event to others (Claim leftovers), per item: they left that event. */
const carriedOutByEventAndKey = computed(() => {
  const out = new Map<string, Map<string, number>>();
  for (const c of claims.values()) {
    if (!c.carried) continue;
    const forEvent = out.get(c.carried.from) ?? new Map<string, number>();
    const key = stockKey(c.productId, c.variantId);
    forEvent.set(key, (forEvent.get(key) ?? 0) + c.carried.qty);
    out.set(c.carried.from, forEvent);
  }
  return out;
});

function carriedOut(eventId: string, key: string, exceptTo?: string): number {
  if (exceptTo === undefined) return carriedOutByEventAndKey.value.get(eventId)?.get(key) ?? 0;
  let n = 0;
  for (const c of claims.values()) {
    if (c.carried?.from === eventId && c.eventId !== exceptTo && stockKey(c.productId, c.variantId) === key) n += c.carried.qty;
  }
  return n;
}

/** An event's claim less what was carried on from it to other events: what it still had to sell. */
function ownClaim(eventId: string, productId: string, variantId: string | null): number | null {
  const claim = claimFor(eventId, productId, variantId);
  return claim === null ? null : Math.max(0, claim - carriedOut(eventId, stockKey(productId, variantId)));
}

/**
 * What a running event still holds of an item: its own claim less what it
 * sold, never negative. Nothing once the event is over, or without a claim.
 * Sales are counted whenever they were made - a recount does not give back
 * stock the event already sold.
 */
export function heldFor(eventId: string, productId: string, variantId: string | null = ''): number {
  if (eventIsOver(getSalesEvent(eventId))) return 0;
  const own = ownClaim(eventId, productId, variantId);
  return own === null ? 0 : Math.max(0, own - soldAt(eventId, productId, variantId));
}

const heldByKey = computed(() => {
  const out = new Map<string, number>();
  for (const c of claims.values()) {
    const held = heldFor(c.eventId, c.productId, c.variantId);
    if (held > 0) out.set(stockKey(c.productId, c.variantId), (out.get(stockKey(c.productId, c.variantId)) ?? 0) + held);
  }
  return out;
});

const claimedByKey = computed(() => {
  const out = new Map<string, number>();
  for (const claim of claims.values()) {
    if (eventIsOver(getSalesEvent(claim.eventId))) continue;
    const key = stockKey(claim.productId, claim.variantId);
    out.set(key, (out.get(key) ?? 0) + claim.broughtQty);
  }
  return out;
});

/** Units claimed by every event still on, for one item - as claimed, for display. */
export function claimedTotal(productId: string, variantId: string | null = ''): number {
  return claimedByKey.value.get(stockKey(productId, variantId)) ?? 0;
}

/** What running events still hold of their claims (claimed less sold there), for one item. */
export function heldTotal(productId: string, variantId: string | null = ''): number {
  return heldByKey.value.get(stockKey(productId, variantId)) ?? 0;
}

/** What is here now: the last count less sales since. 0 for an item never counted. */
export function inStockFor(productId: string, variantId: string | null = ''): number {
  return countedAt(productId, variantId) > 0 ? remainingFor(productId, variantId) : 0;
}

/**
 * Stock nobody holds - what an event without a claim can draw on: what is
 * physically left (the last count less sales since) less what running events
 * still hold of their claims. A sale within a claim is already gone from the
 * pile and from what its event holds, so it is never subtracted twice; a sale
 * past a claim simply comes off the pile.
 */
export function freeFor(productId: string, variantId: string | null = ''): number {
  return remainingFor(productId, variantId) - (heldByKey.value.get(stockKey(productId, variantId)) ?? 0);
}

export interface UnsoldRow {
  productId: string;
  variantId: string;
  /** What the event claimed and did not sell. */
  qty: number;
}

/**
 * What an event took and brought back: its claim minus what it sold, per
 * claimed item. Only claimed items appear - an event that sold from the
 * shared pool never set anything aside, so there is nothing of its own left.
 * Selling past a claim leaves zero, never a negative.
 */
export function unsoldFrom(eventId: string, exceptTo?: string): UnsoldRow[] {
  return claimsForEvent(eventId).map((c) => ({
    productId: c.productId,
    variantId: c.variantId,
    // What was already carried on to another event left this one.
    qty: Math.max(0, c.broughtQty - carriedOut(eventId, stockKey(c.productId, c.variantId), exceptTo) - soldAt(eventId, c.productId, c.variantId)),
  }));
}

/**
 * Claims for `targetId` exactly what `sourceId` claimed and did not sell - the
 * stock carried straight on from one show to the next. The units move: the
 * source stops holding them (its claim stays as it was, for customs and the
 * packing list), so they are never reserved twice - also while the source is
 * still open, or after it is reopened. Replaces the target's claims on those
 * items; an item with nothing left is skipped, so the target keeps selling it
 * from the shared pool. Running it again takes over what is left now.
 * Returns how many items were claimed.
 */
export async function claimUnsoldFrom(sourceId: string, targetId: string): Promise<number> {
  if (sourceId === targetId) throw new Error('Pick a different event to claim from.');
  const rows = unsoldFrom(sourceId, targetId).filter((r) => r.qty > 0);
  for (const row of rows) await setClaim(targetId, row.productId, row.variantId, row.qty, { carried: { from: sourceId, qty: row.qty } });
  return rows.length;
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
 * pool is irrelevant - that is what reserving means.
 *
 * Without a claim: everything not owned by someone else's claim, minus what
 * every unclaimed event has sold out of that same pool. Two events with no
 * claims genuinely share one pile, and pretending otherwise would let a booth
 * sell the same print twice.
 */
export function availabilityFor(eventId: string): Availability[] {
  const rows: Availability[] = [];

  // Once over, whatever the event had is soft-released back to the shared
  // pool for selling purposes - but the claim itself is still there to look
  // at and edit (e.g. reopening a finished event to correct what it took).
  const reserving = !eventIsOver(getSalesEvent(eventId));

  for (const product of allProducts.value) {
    const variants = product.variants ?? [];
    const entries = variants.length
      ? variants.map((v) => ({ id: v.id, label: `${product.title} · ${v.name}` }))
      : [{ id: '', label: product.title }];

    for (const entry of entries) {
      const onHand = onHandFor(product.id, entry.id);
      const claimed = claimFor(eventId, product.id, entry.id);
      // What it still had to sell: the claim less what was carried on to other events.
      const reservingClaim = reserving ? ownClaim(eventId, product.id, entry.id) : null;
      const soldHere = soldAt(eventId, product.id, entry.id);
      // What other running events still hold - their claims less what they sold or handed on.
      const reservedElsewhere = heldTotal(product.id, entry.id) - (reserving ? heldFor(eventId, product.id, entry.id) : 0);
      const available = reservingClaim !== null ? reservingClaim - soldHere : freeFor(product.id, entry.id);

      rows.push({
        productId: product.id,
        variantId: entry.id,
        label: entry.label,
        onHand,
        claimed,
        soldHere,
        reservedElsewhere,
        available,
        source: reservingClaim !== null ? 'claim' : 'pool',
      });
    }
  }

  return rows;
}

export interface InventoryRow {
  productId: string;
  variantId: string;
  label: string;
  /** Here now: the last count less every sale since. Editing it is a fresh count. */
  onHand: number;
  /** False until someone has counted this item; until then Free means nothing. */
  counted: boolean;
  /** Still set aside for running events: their claims less what they sold. */
  claimed: number;
  /** Sold ever, across every event. */
  sold: number;
  /** On hand less claimed - what an event with no claim can draw on. */
  free: number;
  /** More is promised or already gone than the booth owns. */
  overCommitted: boolean;
}

/**
 * A product that got variants later can still have a count, a claim or sales
 * on the product itself, from before. Those would drop out of every total
 * without a word, so the product gets a row of its own for them until they
 * are cleared (recount it to 0).
 */
function hasPreVariantStock(productId: string): boolean {
  const key = stockKey(productId, '');
  if ((items.get(key)?.onHand ?? 0) !== 0 || inStockFor(productId, '') !== 0) return true;
  for (const c of claims.values()) if (c.productId === productId && c.variantId === '' && !eventIsOver(getSalesEvent(c.eventId))) return true;
  return false;
}

/** The whole inventory, with what is spoken for. */
export function inventoryRows(): InventoryRow[] {
  const rows: InventoryRow[] = [];

  for (const product of allProducts.value) {
    const variants = product.variants ?? [];
    const entries = variants.length
      ? [
          ...variants.map((v) => ({ id: v.id, label: `${product.title} · ${v.name}` })),
          ...(hasPreVariantStock(product.id) ? [{ id: '', label: `${product.title} · not a variant (counted before it had variants)` }] : []),
        ]
      : [{ id: '', label: product.title }];

    for (const entry of entries) {
      const onHand = inStockFor(product.id, entry.id);
      const claimed = heldTotal(product.id, entry.id);
      const sold = soldTotal(product.id, entry.id);
      const free = freeFor(product.id, entry.id);
      const counted = countedAt(product.id, entry.id) > 0;

      rows.push({
        productId: product.id,
        variantId: entry.id,
        label: entry.label,
        onHand,
        counted,
        claimed,
        sold,
        free,
        // A negative pool is the honest signal: between claims and sales, more
        // has been committed than exists.
        overCommitted: counted && free < 0,
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
