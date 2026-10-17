<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { compareEvents, eventHasEnded } from '@zollify/shared';
import { itemKey, pickOrder, pickPlan, type Place } from '../engine/storage';
import { locationName, locations, move, ownLocation, rows } from '../state';
import { sdk } from '../runtime';

/**
 * What to fetch from where for one event: its claims, minus what it already
 * sold, taken from this device's own place first, then Home, then the other
 * locations in their order.
 */

const events = computed(() =>
  sdk()
    .data.events.list()
    .filter((e) => e.kind !== 'store' && !e.deletedAt && !eventHasEnded(e))
    .sort(compareEvents()),
);
const eventId = ref<string | null>(null);
watch(
  events,
  (list) => {
    if (eventId.value && list.some((e) => e.id === eventId.value)) return;
    const active = sdk().data.events.active();
    eventId.value = list.find((e) => e.id === active?.id)?.id ?? list[0]?.id ?? null;
  },
  { immediate: true },
);

interface Pick {
  key: string;
  label: string;
  qty: number;
}
interface Stop {
  /** null = Home. */
  locationId: string | null;
  picks: Pick[];
}

const plan = computed(() => {
  if (!eventId.value) return { stops: [] as Stop[], short: [] as Pick[], claimed: 0 };
  const byKey = new Map(rows.value.map((r) => [r.key, r]));
  const order = pickOrder(ownLocation.value, locations.value.map((l) => l.id));
  const stops = new Map<string | null, Pick[]>();
  const short: Pick[] = [];
  let claimed = 0;
  for (const a of sdk().data.inventory.availability(eventId.value)) {
    if (a.claimed === null) continue;
    claimed++;
    // What the event still holds of its claim: less what it sold and what it
    // handed on to another event (Claim leftovers), so the same units are
    // never on two pick lists.
    const need = a.source === 'claim' ? Math.max(0, a.available) : 0;
    const row = byKey.get(itemKey(a.productId, a.variantId));
    if (!need || !row) continue;
    const { steps, short: missing } = pickPlan(need, row, order);
    for (const s of steps) {
      const list = stops.get(s.locationId) ?? [];
      list.push({ key: row.key, label: row.label, qty: s.qty });
      stops.set(s.locationId, list);
    }
    if (missing) short.push({ key: row.key, label: row.label, qty: missing });
  }
  const ordered: Stop[] = order.filter((id) => stops.has(id)).map((id) => ({ locationId: id, picks: stops.get(id)! }));
  return { stops: ordered, short, claimed };
});

const busy = ref(false);
const error = ref<string | null>(null);

const placeOf = (id: string | null): Place => (id === null ? { kind: 'home' } : { kind: 'location', id });

/** Fetched: the units leave that place for the one this device sells from. */
async function fetched(locationId: string | null, picks: Pick[]): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const byKey = new Map(rows.value.map((r) => [r.key, r]));
    for (const p of picks) {
      const row = byKey.get(p.key);
      if (row) await move(row, placeOf(locationId), placeOf(ownLocation.value), p.qty);
    }
    sdk().ui.toast(`Moved to ${locationName(ownLocation.value)}.`, { kind: 'success' });
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not record the pick.';
  } finally {
    busy.value = false;
  }
}

const units = (picks: Pick[]): number => picks.reduce((n, p) => n + p.qty, 0);
</script>

<template>
  <div class="pick">
    <p v-if="!events.length" class="empty">No upcoming events. Pick lists are for events with stock claimed under Inventory.</p>
    <template v-else>
      <label class="event">
        <span>Event</span>
        <select v-model="eventId">
          <option v-for="e in events" :key="e.id" :value="e.id">{{ e.name }}<template v-if="e.dateStart"> · {{ e.dateStart }}</template></option>
        </select>
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <p v-if="!plan.claimed" class="empty">This event has no claimed stock - it sells from whatever is left. Claim stock for it under Inventory to get a pick list.</p>
      <p v-else-if="!plan.stops.length && !plan.short.length" class="empty">Nothing left to fetch: the event has sold everything it claimed.</p>

      <div v-for="stop in plan.stops" :key="stop.locationId ?? '__home'" class="card stop">
        <header>
          <h2>{{ locationName(stop.locationId) }}</h2>
          <span class="meta">{{ units(stop.picks) }} unit{{ units(stop.picks) === 1 ? '' : 's' }}</span>
          <span v-if="stop.locationId === ownLocation" class="meta">this device</span>
          <button
            v-else
            type="button"
            class="primary"
            :disabled="busy"
            @click="fetched(stop.locationId, stop.picks)"
          >Fetched</button>
        </header>
        <ul>
          <li v-for="p in stop.picks" :key="p.key"><span>{{ p.label }}</span><strong>{{ p.qty }}</strong></li>
        </ul>
      </div>

      <div v-if="plan.short.length" class="card stop short">
        <header><h2>Not anywhere</h2><span class="meta">claimed but no place has them</span></header>
        <ul>
          <li v-for="p in plan.short" :key="p.key"><span>{{ p.label }}</span><strong>{{ p.qty }}</strong></li>
        </ul>
      </div>

      <p v-if="plan.stops.length" class="hint">Fetched moves those units to {{ locationName(ownLocation) }}, the place this device sells from.</p>
    </template>
  </div>
</template>

<style scoped>
.pick { display: flex; flex-direction: column; gap: .75rem; max-width: 44rem; }
.event { display: flex; flex-direction: column; gap: .3rem; font-size: .875rem; max-width: 24rem; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .8rem 1rem; }
.stop header { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.stop h2 { margin: 0; font-size: 1rem; }
.stop .meta { color: var(--zfy-muted, #5a6472); font-size: .8rem; margin-right: auto; }
.stop ul { list-style: none; margin: .5rem 0 0; padding: 0; display: flex; flex-direction: column; }
.stop li { display: flex; justify-content: space-between; gap: 1rem; padding: .3rem 0; border-top: 1px solid var(--zfy-line, #d6dde4); }
.stop li strong { font-variant-numeric: tabular-nums; }
.short h2 { color: var(--zfy-danger, #c6512f); }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
</style>
