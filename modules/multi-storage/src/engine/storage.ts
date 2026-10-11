/**
 * Storage locations - where the stock physically is when it is not with you.
 *
 * Core keeps one counted pile per item. This module splits that pile by place:
 * a storage unit, a studio, a friend's garage. Each location holds a counted
 * allocation of an item; **Home** is everything else - what is left of the
 * pile, minus what sits in storage, minus what the stores hold on their
 * claims. Sales at events come out of Home (you sell what you carry), so a
 * storage figure only moves when someone moves stock in or out of it.
 *
 * Every location and every allocation is its own synced setting, so two
 * devices editing different rows never overwrite each other.
 */

export const PREFIX = 'multi-storage.';
export const LOCATION_PREFIX = `${PREFIX}loc.`;
export const ALLOCATION_PREFIX = `${PREFIX}alloc.`;
export const HOME_KEY = `${PREFIX}home`;
export const DEFAULT_HOME_NAME = 'Home';

export interface StorageLocation {
  id: string;
  name: string;
  address?: string;
  note?: string;
  order: number;
  updatedAt: number;
  /** Removed. Kept as a row so the removal syncs like any other edit. */
  deletedAt?: number;
}

/** How many of one item sit at one location, as last counted or moved. */
export interface Allocation {
  locationId: string;
  productId: string;
  /** '' for a product without variants. */
  variantId: string;
  qty: number;
  updatedAt: number;
}

export const locationKey = (id: string): string => `${LOCATION_PREFIX}${id}`;
export const itemKey = (productId: string, variantId: string | null | undefined): string => `${productId}:${variantId ?? ''}`;
export const allocationKey = (locationId: string, productId: string, variantId: string | null | undefined): string =>
  `${ALLOCATION_PREFIX}${locationId}|${itemKey(productId, variantId)}`;

/** Locations still in use, in their chosen order. */
export function liveLocations(rows: Iterable<StorageLocation>): StorageLocation[] {
  return [...rows].filter((l) => !l.deletedAt).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Allocation per location per item: `byItem.get(itemKey).get(locationId)`. Zero rows are left out. */
export function indexAllocations(rows: Iterable<Allocation>, locationIds: Set<string>): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const a of rows) {
    if (!locationIds.has(a.locationId) || !(a.qty > 0)) continue;
    const key = itemKey(a.productId, a.variantId);
    const forItem = out.get(key) ?? new Map<string, number>();
    forItem.set(a.locationId, a.qty);
    out.set(key, forItem);
  }
  return out;
}

export interface StockEntry {
  productId: string;
  variantId: string;
  label: string;
  type?: string;
}

export interface StorageRow extends StockEntry {
  key: string;
  /** What is physically left of the pile (last count minus sales since). */
  remaining: number;
  /** Held by stores on their claims, unsold. */
  atStores: number;
  /** Per location id; missing means none. */
  stored: Map<string, number>;
  storedTotal: number;
  /** Everything not in storage or at a store. Negative when more is allocated than exists. */
  home: number;
}

export interface RowInputs {
  remaining(productId: string, variantId: string): number;
  atStores(productId: string, variantId: string): number;
  allocations: Map<string, Map<string, number>>;
}

export function storageRows(entries: StockEntry[], input: RowInputs): StorageRow[] {
  return entries.map((e) => {
    const key = itemKey(e.productId, e.variantId);
    const stored = input.allocations.get(key) ?? new Map<string, number>();
    let storedTotal = 0;
    for (const qty of stored.values()) storedTotal += qty;
    const remaining = input.remaining(e.productId, e.variantId);
    const atStores = input.atStores(e.productId, e.variantId);
    return { ...e, key, remaining, atStores, stored, storedTotal, home: remaining - atStores - storedTotal };
  });
}

/** Where a move starts or ends: Home, a storage location, or outside the pile altogether. */
export type Place = { kind: 'home' } | { kind: 'location'; id: string } | { kind: 'new' } | { kind: 'gone' };

export interface MovePlan {
  /** New allocation per touched location id. */
  allocations: Map<string, number>;
  /** Change to the counted pile: + for new stock, - for stock that left it. 0 for a plain move. */
  pileDelta: number;
}

/**
 * Works out what a move changes, or throws a message for the person moving.
 *
 * Home is derived, so moving into or out of it only touches the other side.
 * `new` (stock arriving from the printer) and `gone` (damaged, given away)
 * change the counted pile as well.
 */
export function planMove(row: Pick<StorageRow, 'home' | 'stored'>, from: Place, to: Place, qty: number): MovePlan {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Move a whole number of at least 1.');
  if (samePlace(from, to)) throw new Error('Pick two different places.');
  if (from.kind === 'gone' || to.kind === 'new') throw new Error('Stock cannot come from "gone" or go to "new".');
  if (from.kind === 'new' && to.kind === 'gone') throw new Error('Pick where the stock is or goes.');

  const allocations = new Map<string, number>();
  if (from.kind === 'location') {
    const have = row.stored.get(from.id) ?? 0;
    if (qty > have) throw new Error(`Only ${have} there to move.`);
    allocations.set(from.id, have - qty);
  }
  if (from.kind === 'home') {
    const have = Math.max(0, row.home);
    if (qty > have) throw new Error(`Only ${have} at home to move.`);
  }
  if (to.kind === 'location') allocations.set(to.id, (row.stored.get(to.id) ?? 0) + qty);

  const pileDelta = from.kind === 'new' ? qty : to.kind === 'gone' ? -qty : 0;
  return { allocations, pileDelta };
}

function samePlace(a: Place, b: Place): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'location' || a.id === (b as { id: string }).id;
}

export interface PickStep {
  /** null = Home. */
  locationId: string | null;
  qty: number;
}

export interface PickLine {
  productId: string;
  variantId: string;
  label: string;
  need: number;
  steps: PickStep[];
  /** What none of the places hold. */
  short: number;
}

/**
 * Where to fetch what an event needs: Home first (nothing to drive to), then
 * storage in the locations' order. Only what each place actually holds is
 * planned; the rest is reported short rather than invented.
 */
export function pickPlan(need: number, row: Pick<StorageRow, 'home' | 'stored'>, locationOrder: string[]): { steps: PickStep[]; short: number } {
  let left = Math.max(0, need);
  const steps: PickStep[] = [];
  const fromHome = Math.min(left, Math.max(0, row.home));
  if (fromHome > 0) {
    steps.push({ locationId: null, qty: fromHome });
    left -= fromHome;
  }
  for (const id of locationOrder) {
    if (left <= 0) break;
    const take = Math.min(left, row.stored.get(id) ?? 0);
    if (take > 0) {
      steps.push({ locationId: id, qty: take });
      left -= take;
    }
  }
  return { steps, short: left };
}

/** Cleans a location's name and optional fields, or throws a message to show. */
export function cleanLocation(input: { name: string; address?: string; note?: string }): { name: string; address?: string; note?: string } {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Give the location a name.');
  if (name.length > 60) throw new Error('Keep the name under 60 characters.');
  const address = input.address?.trim() || undefined;
  const note = input.note?.trim() || undefined;
  if (address && address.length > 200) throw new Error('Keep the address under 200 characters.');
  if (note && note.length > 500) throw new Error('Keep the note under 500 characters.');
  return { name, address, note };
}
