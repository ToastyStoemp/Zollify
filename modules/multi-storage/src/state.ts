import { computed, ref } from 'vue';
import { roleAtLeast } from '@zollify/sdk';
import {
  ALLOCATION_PREFIX,
  DEFAULT_HOME_NAME,
  DEVICE_PREFIX,
  HOME_KEY,
  LOCATION_PREFIX,
  allocationKey,
  deviceKey,
  indexAllocations,
  itemKey,
  liveLocations,
  locationAt,
  locationKey,
  locationSales,
  planMove,
  storageRows,
  withPick,
  type Allocation,
  type DeviceHome,
  type Place,
  type StockEntry,
  type StorageLocation,
  type StorageRow,
} from './engine/storage';
import { sdk } from './runtime';

/**
 * The module's synced state, read back through `sdk.data.settings`. Kept in
 * refs so every tab sees the same figures, and reloaded after each sync so a
 * move made on another device shows up here.
 */

const locationRows = ref<Map<string, StorageLocation>>(new Map());
const allocationRows = ref<Map<string, Allocation>>(new Map());
/** Keyed by device id. */
const deviceHomes = ref<Map<string, DeviceHome>>(new Map());
export const homeName = ref(DEFAULT_HOME_NAME);
export const thisDeviceId = ref<string | null>(null);
export const loaded = ref(false);

const isObject = (v: unknown): boolean => !!v && typeof v === 'object';

export async function loadStorage(): Promise<void> {
  const settings = sdk().data.settings;
  const [locs, allocs, devices, home, deviceId] = await Promise.all([
    settings.list<StorageLocation>(LOCATION_PREFIX),
    settings.list<Allocation>(ALLOCATION_PREFIX),
    settings.list<DeviceHome>(DEVICE_PREFIX),
    settings.get<{ name?: string }>(HOME_KEY),
    sdk().realtime.deviceId(),
  ]);
  locationRows.value = new Map(Object.entries(locs).filter(([, v]) => isObject(v)));
  allocationRows.value = new Map(Object.entries(allocs).filter(([, v]) => isObject(v)));
  deviceHomes.value = new Map(
    Object.values(devices)
      .filter((v) => isObject(v) && typeof v.deviceId === 'string' && Array.isArray(v.history))
      .map((v) => [v.deviceId, v]),
  );
  homeName.value = home?.name?.trim() || DEFAULT_HOME_NAME;
  thisDeviceId.value = deviceId;
  loaded.value = true;
}

/** Forgets the loaded state, so another account never sees this one's locations. */
export function resetStorage(): void {
  locationRows.value = new Map();
  allocationRows.value = new Map();
  deviceHomes.value = new Map();
  homeName.value = DEFAULT_HOME_NAME;
  thisDeviceId.value = null;
  loaded.value = false;
}

/** Admins manage the locations themselves and the counted total; staff move and count stock. */
export const isAdmin = (): boolean => roleAtLeast(sdk().account()?.role ?? 'member', 'admin');

export const locations = computed(() => liveLocations(locationRows.value.values()));
const liveIds = computed(() => new Set(locations.value.map((l) => l.id)));
export const locationName = (id: string | null): string =>
  id === null ? homeName.value : (locationRows.value.get(locationKey(id))?.name ?? 'Removed location');

/** Where a device sells from now; null = Home (also when its location was removed). */
export function sellsFrom(deviceId: string | null): string | null {
  if (!deviceId) return null;
  const id = locationAt(deviceHomes.value.get(deviceId)?.history, Date.now());
  return id !== null && liveIds.value.has(id) ? id : null;
}
export const ownLocation = computed(() => sellsFrom(thisDeviceId.value));

/** Every device that has picked a location at some point, with where it sells from now. */
export const devicePicks = computed(() =>
  [...deviceHomes.value.values()].map((d) => ({ deviceId: d.deviceId, locationId: sellsFrom(d.deviceId) })),
);

/** Every item in the catalogue, one entry per variant. */
export function stockEntries(): StockEntry[] {
  const out: StockEntry[] = [];
  for (const p of sdk().data.products.list()) {
    if (p.variants?.length) {
      for (const v of p.variants) out.push({ productId: p.id, variantId: v.id, label: `${p.title} · ${v.name}`, type: p.type });
    } else {
      out.push({ productId: p.id, variantId: '', label: p.title, type: p.type });
    }
  }
  return out;
}

/** Stock the stores hold on their claims and have not sold, per item. */
function storeHoldings(): Map<string, number> {
  const out = new Map<string, number>();
  for (const store of sdk().data.events.list()) {
    if (store.kind !== 'store' || store.deletedAt) continue;
    for (const a of sdk().data.inventory.availability(store.id)) {
      if (a.source !== 'claim' || a.available <= 0) continue;
      const key = itemKey(a.productId, a.variantId);
      out.set(key, (out.get(key) ?? 0) + a.available);
    }
  }
  return out;
}

/** Sales charged to storage locations: unclaimed sales by devices that sell from one. */
const soldFromLocations = computed(() => {
  const claims = new Map<string, Map<string, number>>();
  // What each event's claim covers: its claim less what it handed on to another event.
  const claimOf = (eventId: string, key: string): number | null => {
    let keys = claims.get(eventId);
    if (!keys) {
      keys = new Map(
        sdk()
          .data.inventory.availability(eventId)
          .filter((a) => a.claimed !== null)
          .map((a) => [itemKey(a.productId, a.variantId), a.source === 'claim' ? a.available + a.soldHere : a.claimed!]),
      );
      claims.set(eventId, keys);
    }
    return keys.get(key) ?? null;
  };
  return locationSales(sdk().data.transactions.recent(), deviceHomes.value, liveIds.value, claimOf);
});

export const rows = computed<StorageRow[]>(() => {
  const atStores = storeHoldings();
  const inventory = sdk().data.inventory;
  return storageRows(stockEntries(), {
    remaining: (pid, vid) => inventory.remaining(pid, vid),
    atStores: (pid, vid) => atStores.get(itemKey(pid, vid)) ?? 0,
    allocations: indexAllocations(allocationRows.value.values(), liveIds.value),
    sales: soldFromLocations.value,
  });
});

export const hasStores = computed(() => sdk().data.events.list().some((e) => e.kind === 'store' && !e.deletedAt));

// ── Writes ──────────────────────────────────────────────────────────────────

async function putAllocation(locationId: string, productId: string, variantId: string, qty: number): Promise<void> {
  const key = allocationKey(locationId, productId, variantId);
  const row: Allocation = { locationId, productId, variantId, qty: Math.max(0, Math.floor(qty)), updatedAt: Date.now() };
  await sdk().data.settings.set(key, row);
  allocationRows.value = new Map(allocationRows.value).set(key, row);
}

function requireAdmin(what: string): void {
  if (!isAdmin()) throw new Error(`Only an admin can ${what}.`);
}

export async function saveLocation(input: Omit<StorageLocation, 'updatedAt' | 'order'> & { order?: number }): Promise<void> {
  requireAdmin('change the locations');
  const existing = locationRows.value.get(locationKey(input.id));
  const order = input.order ?? existing?.order ?? Math.max(0, ...locations.value.map((l) => l.order + 1));
  const row: StorageLocation = { ...existing, ...input, order, updatedAt: Date.now() };
  await sdk().data.settings.set(locationKey(row.id), row);
  locationRows.value = new Map(locationRows.value).set(locationKey(row.id), row);
}

/** Removes a location. Refused while it still holds stock, so nothing quietly falls back into Home. */
export async function removeLocation(id: string): Promise<void> {
  const holding = rows.value.reduce((n, r) => n + Math.max(0, r.stored.get(id) ?? 0), 0);
  if (holding > 0) throw new Error(`It still holds ${holding} item${holding === 1 ? '' : 's'}. Move them out first.`);
  const existing = locationRows.value.get(locationKey(id));
  if (!existing) return;
  await saveLocation({ ...existing, deletedAt: Date.now() });
}

export async function swapOrder(a: StorageLocation, b: StorageLocation): Promise<void> {
  const [oa, ob] = a.order === b.order ? [a.order, a.order + 1] : [a.order, b.order];
  await saveLocation({ ...a, order: ob });
  await saveLocation({ ...b, order: oa });
}

export async function setHomeName(name: string): Promise<void> {
  requireAdmin('rename Home');
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60);
  await sdk().data.settings.set(HOME_KEY, { name: clean });
  homeName.value = clean || DEFAULT_HOME_NAME;
}

/** Picks where this device sells from, from now on. Earlier sales keep the place they were made from. */
export async function setOwnLocation(locationId: string | null): Promise<void> {
  const deviceId = thisDeviceId.value ?? (await sdk().realtime.deviceId());
  if (locationId !== null && !liveIds.value.has(locationId)) throw new Error('That location was removed.');
  const current = deviceHomes.value.get(deviceId);
  const next = withPick(current, deviceId, locationId, Date.now());
  if (next === current) return;
  await sdk().data.settings.set(deviceKey(deviceId), next);
  deviceHomes.value = new Map(deviceHomes.value).set(deviceId, next);
}

/** Records a count at one location. The difference moves to or from Home; the total stays. */
export async function countAt(row: StorageRow, locationId: string, qty: number): Promise<void> {
  if (!Number.isInteger(qty) || qty < 0) throw new Error('Enter a whole number, 0 or more.');
  await putAllocation(locationId, row.productId, row.variantId, qty);
}

export async function move(row: StorageRow, from: Place, to: Place, qty: number): Promise<void> {
  const plan = planMove(row, from, to, qty);
  if (plan.pileDelta) requireAdmin('add new stock or write stock off');
  for (const [locationId, next] of plan.allocations) await putAllocation(locationId, row.productId, row.variantId, next);
  if (plan.pileDelta) {
    // A new count of what is left, so the sales already made stay subtracted.
    const inventory = sdk().data.inventory;
    await inventory.setOnHand(row.productId, row.variantId, Math.max(0, row.remaining) + plan.pileDelta);
  }
}
