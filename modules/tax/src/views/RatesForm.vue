<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { COUNTRIES, TravelRatesSchema, defaultTravelRates, type TravelRates } from '@zollify/shared';
import { api } from '../api';

/**
 * The account's per diem and mileage rates: what the business's own
 * country lets it claim per day away and per kilometre. Started from the
 * defaults for that country (Germany's BMF letter, Belgium's list) and
 * corrected here as the yearly letters change - the app cannot fetch them.
 */
const emit = defineEmits<{ close: [] }>();
const rates = ref<TravelRates>(defaultTravelRates('DE'));
const defaults = ref<string[]>([]);
const rows = ref<{ code: string; full: number; reduced: number }[]>([]);
const newCode = ref('');
const error = ref<string | null>(null);
const ok = ref<string | null>(null);
const busy = ref(false);

function take(r: TravelRates): void {
  rates.value = r;
  rows.value = Object.entries(r.abroad).map(([code, v]) => ({ code, ...v })).sort((a, b) => a.code.localeCompare(b.code));
}
onMounted(async () => {
  try {
    const res = await api.rates();
    take(res.rates);
    defaults.value = res.defaults;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the rates.';
  }
});
const countryName = (code: string): string => COUNTRIES.find((c) => c.code === code)?.name ?? code;
const addable = computed(() => COUNTRIES.filter((c) => c.code !== rates.value.homeCountry && !rows.value.some((r) => r.code === c.code)));
function addRow(): void {
  if (!newCode.value) return;
  rows.value = [...rows.value, { code: newCode.value, full: rates.value.fallback.full, reduced: rates.value.fallback.reduced }].sort((a, b) => a.code.localeCompare(b.code));
  newCode.value = '';
}

async function save(): Promise<void> {
  error.value = ok.value = null;
  const parsed = TravelRatesSchema.safeParse({ ...rates.value, abroad: Object.fromEntries(rows.value.map((r) => [r.code, { full: Number(r.full) || 0, reduced: Number(r.reduced) || 0 }])) });
  if (!parsed.success) {
    error.value = parsed.error.issues[0]?.message ?? 'Check the rates.';
    return;
  }
  busy.value = true;
  try {
    take((await api.saveRates(parsed.data)).rates);
    ok.value = 'Saved.';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the rates.';
  } finally {
    busy.value = false;
  }
}
async function reset(code: string): Promise<void> {
  busy.value = true;
  error.value = ok.value = null;
  try {
    take((await api.resetRates(code)).rates);
    ok.value = `Back to the defaults for ${countryName(code)}.`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not reset the rates.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="card" @submit.prevent="save">
    <div class="formhead">
      <h2>Per diem and mileage rates</h2>
      <button type="button" class="quiet" @click="emit('close')">Close</button>
    </div>
    <p class="hint">What your country lets you claim: per day away (a full day, and the day of arrival or departure) by destination, and per kilometre by car. Check them against the current letter each year; the defaults are a starting point, not advice.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="ok" class="ok" role="status">{{ ok }}</p>
    <div class="grid">
      <label><span>Rules of</span><input v-model="rates.homeCountry" type="text" maxlength="2" /></label>
      <label><span>Year</span><input v-model.number="rates.year" type="number" min="2020" max="2100" /></label>
      <label><span>Currency</span><input v-model="rates.currency" type="text" maxlength="3" /></label>
      <label><span>Per km</span><input v-model.number="rates.mileagePerKm" type="number" min="0" step="0.0001" /></label>
      <label><span>At home, full day</span><input v-model.number="rates.domestic.full" type="number" min="0" step="0.01" /></label>
      <label><span>At home, arrival / departure</span><input v-model.number="rates.domestic.reduced" type="number" min="0" step="0.01" /></label>
      <label><span>Elsewhere, full day</span><input v-model.number="rates.fallback.full" type="number" min="0" step="0.01" /></label>
      <label><span>Elsewhere, arrival / departure</span><input v-model.number="rates.fallback.reduced" type="number" min="0" step="0.01" /></label>
    </div>
    <h3>By destination</h3>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Country</th><th class="num">Full day</th><th class="num">Arrival / departure</th><th></th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.code">
            <td>{{ countryName(r.code) }} <span class="sub">{{ r.code }}</span></td>
            <td class="num"><input v-model.number="r.full" type="number" min="0" step="0.01" class="short" /></td>
            <td class="num"><input v-model.number="r.reduced" type="number" min="0" step="0.01" class="short" /></td>
            <td><button type="button" class="quiet" @click="rows = rows.filter((x) => x.code !== r.code)">Remove</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="add">
      <select v-model="newCode" aria-label="Add a country"><option value="">Add a country…</option><option v-for="c in addable" :key="c.code" :value="c.code">{{ c.name }}</option></select>
      <button type="button" :disabled="!newCode" @click="addRow">Add</button>
    </div>
    <div class="actions">
      <button type="submit" class="primary" :disabled="busy">Save rates</button>
      <button v-for="d in defaults" :key="d" type="button" class="quiet" :disabled="busy" @click="reset(d)">Defaults for {{ countryName(d) }}</button>
    </div>
  </form>
</template>

<style scoped>
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .75rem; }
.formhead { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
h2 { margin: 0; font-size: 1.05rem; }
h3 { margin: .2rem 0 0; font-size: .95rem; }
.hint { margin: 0; font-size: .9rem; color: var(--zfy-muted, #5a6472); max-width: 70ch; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .6rem; }
.grid label { display: flex; flex-direction: column; gap: .2rem; font-size: .8rem; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); font-size: .9rem; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); }
.num { text-align: right; }
.short { width: 6rem; }
.sub { color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.add, .actions { display: flex; gap: .4rem; flex-wrap: wrap; align-items: center; }
</style>
