<script setup lang="ts">
import { computed, ref } from 'vue';
import { ModalShell } from '@zollify/ui';
import type { Place, StorageRow } from '../engine/storage';
import { countAt, hasStores, homeName, locations, move, rows } from '../state';
import { sdk } from '../runtime';

const emit = defineEmits<{ manage: [] }>();

const query = ref('');
const onlyStored = ref(false);
const error = ref<string | null>(null);

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return rows.value.filter((r) => {
    if (onlyStored.value && !r.storedTotal) return false;
    if (!q) return true;
    return r.label.toLowerCase().includes(q) || (r.type ?? '').toLowerCase().includes(q);
  });
});

const totals = computed(() => {
  const perLocation = new Map<string, number>();
  let home = 0;
  for (const r of shown.value) {
    home += Math.max(0, r.home);
    for (const [id, qty] of r.stored) perLocation.set(id, (perLocation.get(id) ?? 0) + qty);
  }
  return { home, perLocation };
});

const overAllocated = computed(() => rows.value.filter((r) => r.home < 0).length);

async function recount(row: StorageRow, locationId: string, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const qty = Number(input.value);
  error.value = null;
  try {
    await countAt(row, locationId, qty);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not save the count.';
    input.value = String(row.stored.get(locationId) ?? 0);
  }
}

// ── Moving stock ────────────────────────────────────────────────────────────
type PlaceValue = 'home' | 'new' | 'gone' | `loc:${string}`;
const moving = ref<StorageRow | null>(null);
const from = ref<PlaceValue>('home');
const to = ref<PlaceValue>('home');
const qty = ref(1);
const moveError = ref<string | null>(null);
const busy = ref(false);

function placeOf(v: PlaceValue): Place {
  return v.startsWith('loc:') ? { kind: 'location', id: v.slice(4) } : { kind: v as 'home' | 'new' | 'gone' };
}

function startMove(row: StorageRow): void {
  moving.value = row;
  const firstStored = locations.value.find((l) => (row.stored.get(l.id) ?? 0) > 0);
  from.value = firstStored ? `loc:${firstStored.id}` : 'home';
  to.value = firstStored ? 'home' : locations.value[0] ? `loc:${locations.value[0].id}` : 'home';
  qty.value = 1;
  moveError.value = null;
}

const fromHolds = computed(() => {
  const row = moving.value;
  if (!row) return null;
  if (from.value === 'home') return Math.max(0, row.home);
  if (from.value.startsWith('loc:')) return row.stored.get(from.value.slice(4)) ?? 0;
  return null;
});

async function submitMove(): Promise<void> {
  const row = moving.value;
  if (!row || busy.value) return;
  busy.value = true;
  moveError.value = null;
  try {
    await move(row, placeOf(from.value), placeOf(to.value), Number(qty.value));
    moving.value = null;
    sdk().ui.toast('Moved.', { kind: 'success' });
  } catch (e) {
    moveError.value = e instanceof Error ? e.message : 'Could not move the stock.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="overview">
    <div v-if="!locations.length" class="empty">
      No storage locations yet.
      <button type="button" class="primary" @click="emit('manage')">Add a location</button>
    </div>

    <template v-else>
      <div class="filters">
        <input v-model="query" type="search" placeholder="Search products or types" aria-label="Search" />
        <label class="check"><input v-model="onlyStored" type="checkbox" /> Only items in storage</label>
      </div>
      <p v-if="overAllocated" class="warn" role="status">
        {{ overAllocated }} item{{ overAllocated === 1 ? ' has' : 's have' }} more in storage than is left in total. Recount under Inventory, or correct the storage figure.
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" class="num">{{ homeName }}</th>
              <th v-for="l in locations" :key="l.id" scope="col" class="num">{{ l.name }}</th>
              <th v-if="hasStores" scope="col" class="num" title="Claimed by your stores and not sold yet">At stores</th>
              <th scope="col" class="num" title="Last count minus sales since">Total</th>
              <th scope="col"><span class="sr">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in shown" :key="r.key" :class="{ over: r.home < 0 }">
              <th scope="row">{{ r.label }}<small v-if="r.type">{{ r.type }}</small></th>
              <td class="num home" :title="r.home < 0 ? 'More is allocated than exists' : undefined">{{ r.home }}</td>
              <td v-for="l in locations" :key="l.id" class="num">
                <input
                  type="number"
                  min="0"
                  step="1"
                  inputmode="numeric"
                  :value="r.stored.get(l.id) ?? 0"
                  :aria-label="`${r.label} at ${l.name}`"
                  @change="recount(r, l.id, $event)"
                />
              </td>
              <td v-if="hasStores" class="num">{{ r.atStores }}</td>
              <td class="num total">{{ r.remaining }}</td>
              <td><button type="button" class="quiet" @click="startMove(r)">Move</button></td>
            </tr>
            <tr v-if="!shown.length"><td :colspan="locations.length + (hasStores ? 5 : 4)" class="none">Nothing matches.</td></tr>
          </tbody>
          <tfoot v-if="shown.length">
            <tr>
              <th scope="row">Units</th>
              <td class="num">{{ totals.home }}</td>
              <td v-for="l in locations" :key="l.id" class="num">{{ totals.perLocation.get(l.id) ?? 0 }}</td>
              <td v-if="hasStores" />
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="hint">Typing a number in a location records a count there; the difference comes from or goes back to {{ homeName }}. Use Move for new stock, or stock that is gone.</p>
    </template>

    <ModalShell v-if="moving" :title="`Move · ${moving.label}`" @close="moving = null">
      <div class="form">
        <label>
          <span>From</span>
          <select v-model="from">
            <option value="home">{{ homeName }} ({{ Math.max(0, moving.home) }})</option>
            <option v-for="l in locations" :key="l.id" :value="`loc:${l.id}`">{{ l.name }} ({{ moving.stored.get(l.id) ?? 0 }})</option>
            <option value="new">New stock (adds to the total)</option>
          </select>
        </label>
        <label>
          <span>To</span>
          <select v-model="to">
            <option value="home">{{ homeName }}</option>
            <option v-for="l in locations" :key="l.id" :value="`loc:${l.id}`">{{ l.name }}</option>
            <option value="gone">Gone - damaged, lost, given away (takes it off the total)</option>
          </select>
        </label>
        <label>
          <span>How many</span>
          <input v-model.number="qty" type="number" min="1" step="1" inputmode="numeric" :max="fromHolds ?? undefined" />
        </label>
        <p v-if="moveError" class="error" role="alert">{{ moveError }}</p>
      </div>
      <template #footer>
        <div class="footer">
          <button type="button" @click="moving = null">Cancel</button>
          <button type="button" class="primary" :disabled="busy" @click="submitMove">Move</button>
        </div>
      </template>
    </ModalShell>
  </div>
</template>

<style scoped>
.overview { display: flex; flex-direction: column; gap: .75rem; }
.filters { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; }
.filters input[type='search'] { flex: 1 1 14rem; }
.check { display: flex; align-items: center; gap: .4rem; font-size: .875rem; }
.empty { display: flex; flex-direction: column; align-items: center; gap: .75rem; }
.warn { margin: 0; color: var(--zfy-warning, #a66300); font-size: .875rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
table th, table td { padding: .4rem .6rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); text-align: left; vertical-align: middle; }
thead th { font-size: .78rem; color: var(--zfy-muted, #5a6472); font-weight: 600; white-space: nowrap; }
tbody th { font-weight: 500; }
tbody th small { display: block; color: var(--zfy-muted, #5a6472); font-size: .75rem; font-weight: 400; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
td.num input { width: 5rem; min-height: 2.1rem; text-align: right; }
.home { font-weight: 600; }
.total { color: var(--zfy-muted, #5a6472); }
tr.over .home { color: var(--zfy-danger, #c6512f); }
tfoot th, tfoot td { font-weight: 600; border-bottom: 0; }
.none { text-align: center; color: var(--zfy-muted, #5a6472); }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.form { display: flex; flex-direction: column; gap: .75rem; }
.form label { display: flex; flex-direction: column; gap: .3rem; font-size: .875rem; }
.footer { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
