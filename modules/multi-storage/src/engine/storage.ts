/**
 * Storage locations - where the stock physically is.
 *
 * Core keeps one counted pile per item. This module splits that pile by place:
 * a storage unit, a studio, a friend's garage. Each location holds a counted
 * allocation of an item, minus what was sold from it since that count; **Home**
 * is everything else - what is left of the pile, minus what sits at the
 * locations, minus what the stores hold on their claims.
 *
 * Each device picks the location it sells from. A sale at an event with no
 * claim on the item comes out of the location its device had picked at the
 * time of the sale; a device that picked none sells from Home. Claimed sales
 * come out of the claim, which is stock already taken along.
 *
 * Every location, allocation and device pick is its own synced setting, so
 * two devices editing different rows never overwrite each other. Allocations
 * and device picks live under the team prefix, so staff can move stock too;
 * the locations themselves are the admins'.
 */

export const PREFIX = 'multi-storage.';
/** Synced settings under `team.` are writable by staff (see TEAM_SETTING_PREFIX in @zollify/shared). */
export const TEAM_PREFIX = `team.${PREFIX}`;
export const LOCATION_PREFIX = `${PREFIX}loc.`;
export const ALLOCATION_PREFIX = `${TEAM_PREFIX}alloc.`;
export const DEVICE_PREFIX = `${TEAM_PREFIX}device.`;
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

/**
 * Where one device sells from, with every earlier pick kept: a sale is
 * charged to the pick in force when it was made, so changing a device's
 * location later never moves past sales.
 */
export interface DeviceHome {
  deviceId: string;
  history: { locationId: string | null; from: number }[];
  updatedAt: number;
}

export const locationKey = (id: string): string => `${LOCATION_PREFIX}${id}`;
export const deviceKey = (deviceId: string): string => `${DEVICE_PREFIX}${deviceId}`;
export const itemKey = (productId: string, variantId: string | null | undefined): string => `${productId}:${variantId ?? ''}`;
export const allocationKey = (locationId: string, productId: string, variantId: string | null | undefined): string =>
  `${ALLOCATION_PREFIX}${locationId}|${itemKey(productId, variantId)}`;

/** Locations still in use, in their chosen order. */
export function liveLocations(rows: Iterable<StorageLocation>): StorageLocation[] {
  return [...rows].filter((l) => !l.deletedAt).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export interface Counted {
  qty: number;
  /** When it was counted; sales before this are already reflected. */
  at: number;
}

/** Allocation per location per item: `byItem.get(itemKey).get(locationId)`. Rows of removed locations are left out. */
export function indexAllocations(rows: Iterable<Allocation>, locationIds: Set<string>): Map<string, Map<string, Counted>> {
  const out = new Map<string, Map<string, Counted>>();
  for (const a of rows) {
    if (!locationIds.has(a.locationId)) continue;
    const key = itemKey(a.productId, a.variantId);
    const forItem = out.get(key) ?? new Map<string, Counted>();
    forItem.set(a.locationId, { qty: Math.max(0, a.qty || 0), at: a.updatedAt || 0 });
    out.set(key, forItem);
  }
  return out;
}

/** The location a device sold from at `at`; null = Home. */
export function locationAt(history: DeviceHome['history'] | undefined, at: number): string | null {
  let found: string | null = null;
  for (const h of history ?? []) if (h.from <= at) found = h.locationId;
  return found;
}

/** What core records of a sale, as far as storage cares. */
export interface SaleRecord {
  eventId: string;
  deviceId: string;
  timestamp: number;
  revertedAt?: number;
  items: { pid: string; vid?: string | null; qty: number }[];
}

export interface LocationSale {
  at: number;
  qty: number;
}

/**
 * Sales charged to a storage location, per item and location. Only sales at
 * an event with no claim on the item count, made by a device that had picked
 * a location still in use; everything else is Home's (or the claim's).
 */
export function locationSales(
  sales: Iterable<SaleRecord>,
  homes: Map<string, DeviceHome>,
  liveIds: Set<string>,
  hasClaim: (eventId: string, key: string) => boolean,
): Map<string, Map<string, LocationSale[]>> {
  const out = new Map<string, Map<string, LocationSale[]>>();
  for (const tx of sales) {
    if (tx.revertedAt) continue;
    const locationId = locationAt(homes.get(tx.deviceId)?.history, tx.timestamp);
    if (locationId === null || !liveIds.has(locationId)) continue;
    for (const item of tx.items) {
      const key = itemKey(item.pid, item.vid);
      if (!(item.qty > 0) || hasClaim(tx.eventId, key)) continue;
      const forItem = out.get(key) ?? new Map<string, LocationSale[]>();
      const list = forItem.get(locationId) ?? [];
      list.push({ at: tx.timestamp, qty: item.qty });
      forItem.set(locationId, list);
      out.set(key, forItem);
    }
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
  /** Per location id: counted there, minus sold from there since. Missing means none. May be negative. */
  stored: Map<string, number>;
  storedTotal: number;
  /** Everything not in storage or at a store. Negative when more is allocated than exists. */
  home: number;
}

export interface RowInputs {
  remaining(productId: string, variantId: string): number;
  atStores(productId: string, variantId: string): number;
  allocations: Map<string, Map<string, Counted>>;
  /** From locationSales; absent = nothing sold from storage. */
  sales?: Map<string, Map<string, LocationSale[]>>;
}

export function storageRows(entries: StockEntry[], input: RowInputs): StorageRow[] {
  return entries.map((e) => {
    const key = itemKey(e.productId, e.variantId);
    const counted = input.allocations.get(key);
    const sold = input.sales?.get(key);
    const stored = new Map<string, number>();
    for (const id of new Set([...(counted?.keys() ?? []), ...(sold?.keys() ?? [])])) {
      const c = counted?.get(id) ?? { qty: 0, at: 0 };
      const since = (sold?.get(id) ?? []).reduce((n, s) => (s.at >= c.at ? n + s.qty : n), 0);
      const qty = c.qty - since;
      if (qty !== 0) stored.set(id, qty);
    }
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
    const have = Math.max(0, row.stored.get(from.id) ?? 0);
    if (qty > have) throw new Error(`Only ${have} there to move.`);
    allocations.set(from.id, have - qty);
  }
  if (from.kind === 'home') {
    const have = Math.max(0, row.home);
    if (qty > have) throw new Error(`Only ${have} at home to move.`);
  }
  if (to.kind === 'location') allocations.set(to.id, Math.max(0, row.stored.get(to.id) ?? 0) + qty);

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
 * Where to fetch what an event needs, trying places in `order` (null = Home;
 * the device's own place first, so nothing to drive to). Only what each
 * place actually holds is planned; the rest is reported short rather than
 * invented.
 */
export function pickPlan(need: number, row: Pick<StorageRow, 'home' | 'stored'>, order: (string | null)[]): { steps: PickStep[]; short: number } {
  let left = Math.max(0, need);
  const steps: PickStep[] = [];
  for (const id of order) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, id === null ? row.home : (row.stored.get(id) ?? 0)));
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

/** The order a device fetches in: its own place, then Home, then the other locations. */
export function pickOrder(own: string | null, locationIds: string[]): (string | null)[] {
  return [own, ...[null, ...locationIds].filter((id) => id !== own)];
}

/** The device's history with a new pick from `at`, or the same object when nothing changes. */
export function withPick(current: DeviceHome | undefined, deviceId: string, locationId: string | null, at: number): DeviceHome {
  const history = current?.history ?? [];
  if (locationAt(history, at) === locationId) {
    return current ?? { deviceId, history: [], updatedAt: at };
  }
  return { deviceId, history: [...history, { locationId, from: at }], updatedAt: at };
}
