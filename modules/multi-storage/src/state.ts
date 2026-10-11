import { computed, ref } from 'vue';
import {
  ALLOCATION_PREFIX,
  DEFAULT_HOME_NAME,
  HOME_KEY,
  LOCATION_PREFIX,
  allocationKey,
  indexAllocations,
  itemKey,
  liveLocations,
  locationKey,
  planMove,
  storageRows,
  type Allocation,
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
export const homeName = ref(DEFAULT_HOME_NAME);
export const loaded = ref(false);

export async function loadStorage(): Promise<void> {
  const settings = sdk().data.settings;
  const [locs, allocs, home] = await Promise.all([
    settings.list<StorageLocation>(LOCATION_PREFIX),
    settings.list<Allocation>(ALLOCATION_PREFIX),
    settings.get<{ name?: string }>(HOME_KEY),
  ]);
  locationRows.value = new Map(Object.entries(locs).filter(([, v]) => v && typeof v === 'object'));
  allocationRows.value = new Map(Object.entries(allocs).filter(([, v]) => v && typeof v === 'object'));
  homeName.value = home?.name?.trim() || DEFAULT_HOME_NAME;
  loaded.value = true;
}

/** Forgets the loaded state, so another account never sees this one's locations. */
export function resetStorage(): void {
  locationRows.value = new Map();
  allocationRows.value = new Map();
  homeName.value = DEFAULT_HOME_NAME;
  loaded.value = false;
}

export const locations = computed(() => liveLocations(locationRows.value.values()));
export const locationName = (id: string | null): string =>
  id === null ? homeName.value : (locationRows.value.get(locationKey(id))?.name ?? 'Removed location');

const allocationIndex = computed(() => indexAllocations(allocationRows.value.values(), new Set(locations.value.map((l) => l.id))));

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

export const rows = computed<StorageRow[]>(() => {
  const atStores = storeHoldings();
  const inventory = sdk().data.inventory;
  return storageRows(stockEntries(), {
    remaining: (pid, vid) => inventory.remaining(pid, vid),
    atStores: (pid, vid) => atStores.get(itemKey(pid, vid)) ?? 0,
    allocations: allocationIndex.value,
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

export async function saveLocation(input: Omit<StorageLocation, 'updatedAt' | 'order'> & { order?: number }): Promise<void> {
  const existing = locationRows.value.get(locationKey(input.id));
  const order = input.order ?? existing?.order ?? Math.max(0, ...locations.value.map((l) => l.order + 1));
  const row: StorageLocation = { ...existing, ...input, order, updatedAt: Date.now() };
  await sdk().data.settings.set(locationKey(row.id), row);
  locationRows.value = new Map(locationRows.value).set(locationKey(row.id), row);
}

/** Removes a location. Refused while it still holds stock, so nothing quietly falls back into Home. */
export async function removeLocation(id: string): Promise<void> {
  const holding = rows.value.reduce((n, r) => n + (r.stored.get(id) ?? 0), 0);
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
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60);
  await sdk().data.settings.set(HOME_KEY, { name: clean });
  homeName.value = clean || DEFAULT_HOME_NAME;
}

/** Records a count at one location. The difference moves to or from Home; the total stays. */
export async function countAt(row: StorageRow, locationId: string, qty: number): Promise<void> {
  if (!Number.isInteger(qty) || qty < 0) throw new Error('Enter a whole number, 0 or more.');
  await putAllocation(locationId, row.productId, row.variantId, qty);
}

export async function move(row: StorageRow, from: Place, to: Place, qty: number): Promise<void> {
  const plan = planMove(row, from, to, qty);
  for (const [locationId, next] of plan.allocations) await putAllocation(locationId, row.productId, row.variantId, next);
  if (plan.pileDelta) {
    // A new count of what is left, so the sales already made stay subtracted.
    const inventory = sdk().data.inventory;
    await inventory.setOnHand(row.productId, row.variantId, Math.max(0, row.remaining) + plan.pileDelta);
  }
}
