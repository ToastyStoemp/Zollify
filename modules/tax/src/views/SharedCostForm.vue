<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { eventDays, localIsoDay, splitShared, type SplitMethod } from '@zollify/shared';
import { api, type Expense } from '../api';
import { sdk } from '../runtime';

/**
 * One cost over several events - a year's insurance, a van for two
 * conventions, a trip that took in two shows - split across them by the
 * days each one runs, or evenly. Each event gets its share as its own
 * expense, with a note saying how it was split.
 */
const props = defineProps<{ categories: { id: string; label: string }[]; currency: string }>();
const emit = defineEmits<{ saved: [Expense[]]; close: [] }>();

const events = computed(() => [...sdk().data.events.list()].sort((a, b) => (b.dateStart ?? '').localeCompare(a.dateStart ?? '')));
const form = reactive({ category: 'insurance', amount: 0, currency: props.currency, date: localIsoDay(), vendor: '', note: '', method: 'days' as SplitMethod });
const picked = ref<Set<string>>(new Set());
const error = ref<string | null>(null);
const busy = ref(false);
const toggle = (id: string): void => {
  const next = new Set(picked.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  picked.value = next;
};
const preview = computed(() => {
  const chosen = events.value.filter((e) => picked.value.has(e.id));
  const shares = new Map(splitShared(Number(form.amount) || 0, chosen.map((e) => ({ id: e.id, days: eventDays(e.dateStart, e.dateEnd) })), form.method).map((s) => [s.id, s.amount]));
  return chosen.map((e) => ({ id: e.id, name: e.name, days: eventDays(e.dateStart, e.dateEnd), amount: shares.get(e.id) ?? 0 }));
});

async function save(): Promise<void> {
  error.value = null;
  if (!picked.value.size) {
    error.value = 'Pick the events this cost covers.';
    return;
  }
  if (!(Number(form.amount) > 0)) {
    error.value = 'Enter the amount.';
    return;
  }
  busy.value = true;
  try {
    const { expenses } = await api.addShared({ ...form, amount: Number(form.amount), eventIds: [...picked.value] });
    emit('saved', expenses);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the cost.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="card" @submit.prevent="save">
    <div class="formhead">
      <h2>A cost over several events</h2>
      <button type="button" class="quiet" @click="emit('close')">Close</button>
    </div>
    <p class="hint">A year's insurance, a van for two conventions, one trip to two shows: each event gets its share as its own expense.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="grid">
      <label><span>Vendor</span><input v-model="form.vendor" type="text" /></label>
      <label><span>Category</span><select v-model="form.category"><option v-for="c in categories" :key="c.id" :value="c.id">{{ c.label }}</option></select></label>
      <label><span>Amount</span><input v-model.number="form.amount" type="number" min="0" step="0.01" required /></label>
      <label><span>Currency</span><input v-model="form.currency" type="text" maxlength="3" /></label>
      <label><span>Date</span><input v-model="form.date" type="date" /></label>
      <label><span>Split</span><select v-model="form.method"><option value="days">By the days each event runs</option><option value="even">Evenly</option></select></label>
      <label class="wide"><span>Note</span><input v-model="form.note" type="text" /></label>
    </div>
    <div class="events">
      <label v-for="e in events" :key="e.id" class="pick"><input type="checkbox" :checked="picked.has(e.id)" @change="toggle(e.id)" /> <span>{{ e.name }}</span><small>{{ e.dateStart || 'undated' }}{{ e.kind === 'store' ? ' · store' : '' }}</small></label>
    </div>
    <ul v-if="preview.length" class="preview">
      <li v-for="p in preview" :key="p.id"><span>{{ p.name }} <small>{{ p.days || 1 }} day{{ (p.days || 1) === 1 ? '' : 's' }}</small></span><strong>{{ p.amount.toFixed(2) }} {{ form.currency }}</strong></li>
    </ul>
    <div class="actions"><button type="submit" class="primary" :disabled="busy">Add {{ preview.length }} expense{{ preview.length === 1 ? '' : 's' }}</button></div>
  </form>
</template>

<style scoped>
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .75rem; }
.formhead { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
h2 { margin: 0; font-size: 1.05rem; }
.hint { margin: 0; font-size: .9rem; color: var(--zfy-muted, #5a6472); }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .6rem; }
.grid label { display: flex; flex-direction: column; gap: .2rem; font-size: .8rem; }
.grid .wide { grid-column: 1 / -1; }
.events { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: .3rem .8rem; max-height: 14rem; overflow: auto; }
.pick { display: flex; align-items: center; gap: .4rem; font-size: .875rem; }
.pick small { color: var(--zfy-muted, #5a6472); }
.preview { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .2rem; font-size: .9rem; }
.preview li { display: flex; justify-content: space-between; gap: .6rem; }
.preview small { color: var(--zfy-muted, #5a6472); }
.actions { display: flex; gap: .4rem; }
</style>
