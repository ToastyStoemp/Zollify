import { computed, ref } from 'vue';
import type Dexie from 'dexie';
import { sdk } from './runtime';
import { api, type Booking, type TaxStatus } from './api';
import type { Cluster, MatchedEvent } from './engine/types';
import type { TidNames } from './engine/parse';

/**
 * The working set: clusters being reconciled, saved in this module's own
 * database so a reload — or a week between the pull and the booking — loses
 * nothing. ZollTax kept this in page memory; a closed tab meant starting
 * over, which at month-end was the most annoying thing about it.
 */

interface ClusterRow {
  key: string;
  clusters: Cluster[];
  tidNames: TidNames;
  updatedAt: number;
}

let db: (Dexie & { work: Dexie.Table<ClusterRow, string> }) | null = null;
const WORK_KEY = 'current';

function store() {
  return (db ??= sdk().db({ work: 'key' }, 1) as Dexie & { work: Dexie.Table<ClusterRow, string> });
}

export const clusters = ref<Cluster[]>([]);
export const tidNames = ref<TidNames>({});
export const status = ref<TaxStatus | null>(null);
export const events = ref<MatchedEvent[]>([]);
export const loaded = ref(false);

export const config = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(status.value?.values ?? {})) if (typeof v === 'string') out[k] = v;
  return out;
});

export const domesticVat = computed(() => {
  const dv = Number(config.value.LEXWARE_DOMESTIC_VAT);
  return Number.isFinite(dv) && dv >= 0 ? dv : 19;
});

export const bookings = computed<Map<string, Booking>>(() => new Map((status.value?.bookings ?? []).map((b) => [b.voucherNumber, b])));

export async function loadWork(): Promise<void> {
  const row = await store().work.get(WORK_KEY);
  clusters.value = row?.clusters ?? [];
  tidNames.value = row?.tidNames ?? {};
  loaded.value = true;
}

export async function saveWork(next: Cluster[]): Promise<void> {
  clusters.value = next;
  await store().work.put({ key: WORK_KEY, clusters: JSON.parse(JSON.stringify(next)), tidNames: { ...tidNames.value }, updatedAt: Date.now() });
}

export async function clearWork(): Promise<void> {
  clusters.value = [];
  tidNames.value = {};
  await store().work.delete(WORK_KEY);
}

export async function refreshStatus(): Promise<void> {
  status.value = await api.status();
}

/** Events with dates, from core, in the shape the engine matches against. */
export function refreshEvents(): void {
  events.value = sdk()
    .data.events.list()
    .filter((e) => e.dateStart && e.dateEnd)
    .map((e) => ({ id: e.id, name: e.name, dateStart: e.dateStart!, dateEnd: e.dateEnd!, country: e.venue?.country ?? '' }));
}

export function resetState(): void {
  db = null;
  clusters.value = [];
  tidNames.value = {};
  status.value = null;
  events.value = [];
  loaded.value = false;
}
