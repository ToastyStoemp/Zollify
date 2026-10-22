<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { defaultTravelRates, describeDetail, mileage, perDiem, perDiemRateFor, type ExpenseDetail, type TravelRates } from '@zollify/shared';
import { api, type Expense } from '../api';
import { sdk } from '../runtime';

/**
 * A cost worked out from the event rather than typed in: per diems from
 * its dates and country, mileage from a distance. The rates come from the
 * account's table (Rates, on the ledger's overview); the figure and every
 * input are shown and can be changed before saving, and the expense keeps
 * the calculation so it reads later.
 */
const props = defineProps<{ kind: 'perdiem' | 'mileage'; eventId: string; currency: string; country: string; start: string; end: string }>();
const emit = defineEmits<{ saved: [Expense]; close: [] }>();

const rates = ref<TravelRates>(defaultTravelRates('DE'));
const error = ref<string | null>(null);
const busy = ref(false);
const fmt = (n: number): string => `${n.toFixed(2)} ${props.currency}`;

const pd = reactive({ start: props.start, end: props.end, people: 1, full: 0, reduced: 0 });
const mi = reactive({ km: 0, roundTrip: true, trips: 1, rate: 0 });
const where = ref<'domestic' | 'listed' | 'fallback'>('domestic');

onMounted(async () => {
  try {
    rates.value = (await api.rates()).rates;
  } catch {
    rates.value = defaultTravelRates(sdk().account()?.profile.artist.countryOfOrigin || 'DE');
  }
  const picked = perDiemRateFor(rates.value, props.country);
  where.value = picked.where;
  pd.full = picked.rate.full;
  pd.reduced = picked.rate.reduced;
  mi.rate = rates.value.mileagePerKm;
});

const perDiemResult = computed(() => perDiem({ start: pd.start, end: pd.end, people: Number(pd.people) || 0, rate: { full: Number(pd.full) || 0, reduced: Number(pd.reduced) || 0 } }));
const mileageResult = computed(() => mileage({ km: Number(mi.km) || 0, roundTrip: mi.roundTrip, trips: Number(mi.trips) || 0, ratePerKm: Number(mi.rate) || 0 }));
const amount = computed(() => (props.kind === 'perdiem' ? perDiemResult.value?.amount ?? 0 : mileageResult.value.amount));
const detail = computed<ExpenseDetail>(() =>
  props.kind === 'perdiem'
    ? { kind: 'perdiem', country: props.country.slice(0, 2).toUpperCase(), start: pd.start, end: pd.end, people: Number(pd.people) || 0, rate: { full: Number(pd.full) || 0, reduced: Number(pd.reduced) || 0 }, year: rates.value.year }
    : { kind: 'mileage', km: Number(mi.km) || 0, roundTrip: mi.roundTrip, trips: Number(mi.trips) || 0, ratePerKm: Number(mi.rate) || 0 },
);
const rateNote = computed(() => {
  if (props.kind !== 'perdiem') return `${rates.value.year} rate for ${rates.value.homeCountry}`;
  if (where.value === 'domestic') return `${rates.value.homeCountry} domestic rate, ${rates.value.year}`;
  if (where.value === 'listed') return `${rates.value.year} rate for ${props.country}`;
  return `${props.country || 'this country'} is not in the rate table - the fallback rate is used. Check it.`;
});

async function save(): Promise<void> {
  error.value = null;
  if (!(amount.value > 0)) {
    error.value = 'Nothing to add - check the inputs.';
    return;
  }
  busy.value = true;
  try {
    const { expense } = await api.addExpense({ eventId: props.eventId, category: props.kind, amount: amount.value, currency: props.currency, date: pd.start || props.start, vendor: '', note: describeDetail(detail.value, props.currency), detail: detail.value });
    emit('saved', expense);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the expense.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="card" @submit.prevent="save">
    <div class="formhead">
      <h2>{{ kind === 'perdiem' ? 'Per diems' : 'Mileage' }}</h2>
      <button type="button" class="quiet" @click="emit('close')">Close</button>
    </div>
    <p class="hint">{{ rateNote }} Rates are the account's own - change them under Rates on the overview as the yearly letters come out.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div v-if="kind === 'perdiem'" class="grid">
      <label><span>Away from</span><input v-model="pd.start" type="date" required /></label>
      <label><span>Back on</span><input v-model="pd.end" type="date" required /></label>
      <label><span>People</span><input v-model.number="pd.people" type="number" min="0" max="100" step="1" /></label>
      <label><span>Full day ({{ currency }})</span><input v-model.number="pd.full" type="number" min="0" step="0.01" /></label>
      <label><span>Arrival / departure day ({{ currency }})</span><input v-model.number="pd.reduced" type="number" min="0" step="0.01" /></label>
    </div>
    <div v-else class="grid">
      <label><span>Distance one way (km)</span><input v-model.number="mi.km" type="number" min="0" step="0.1" required /></label>
      <label class="check"><input v-model="mi.roundTrip" type="checkbox" /> There and back</label>
      <label><span>Trips</span><input v-model.number="mi.trips" type="number" min="0" max="100" step="1" /></label>
      <label><span>Per km ({{ currency }})</span><input v-model.number="mi.rate" type="number" min="0" step="0.0001" /></label>
    </div>

    <p v-if="kind === 'perdiem' && perDiemResult" class="sum">
      {{ perDiemResult.days }} day{{ perDiemResult.days === 1 ? '' : 's' }}: {{ perDiemResult.fullDays }} full × {{ fmt(Number(pd.full) || 0) }} + {{ perDiemResult.reducedDays }} arrival/departure × {{ fmt(Number(pd.reduced) || 0) }} = {{ fmt(perDiemResult.perPerson) }} per person ·
      <strong>{{ fmt(perDiemResult.amount) }}</strong>
    </p>
    <p v-else-if="kind === 'perdiem'" class="error">The trip ends before it starts.</p>
    <p v-else class="sum">{{ mileageResult.km }} km at {{ fmt(Number(mi.rate) || 0) }}/km = <strong>{{ fmt(mileageResult.amount) }}</strong></p>

    <div class="actions">
      <button type="submit" class="primary" :disabled="busy || !(amount > 0)">Add {{ fmt(amount) }}</button>
    </div>
  </form>
</template>

<style scoped>
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .75rem; }
.formhead { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
h2 { margin: 0; font-size: 1.05rem; }
.hint, .sum { margin: 0; font-size: .9rem; color: var(--zfy-muted, #5a6472); }
.sum strong { color: var(--zfy-text, #1c2430); }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .6rem; align-items: end; }
.grid label { display: flex; flex-direction: column; gap: .2rem; font-size: .8rem; }
.grid label.check { flex-direction: row; align-items: center; gap: .4rem; min-height: 2.4rem; }
.actions { display: flex; gap: .4rem; }
</style>
