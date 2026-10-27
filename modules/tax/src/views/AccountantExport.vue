<script setup lang="ts">
import { computed, ref } from 'vue';
import { localIsoDay } from '@zollify/shared';
import { api } from '../api';
import { sdk } from '../runtime';

/**
 * A period's books in one download for the accountant: every sale and sale
 * line, the ledger's expenses and the invoices attached to them, as a zip.
 * Pick the period - a year, a quarter, or any two dates - and save the file.
 */
const emit = defineEmits<{ close: [] }>();
const today = localIsoDay();
const thisYear = Number(today.slice(0, 4));
const from = ref(`${thisYear}-01-01`);
const to = ref(today);
const busy = ref(false);
const error = ref<string | null>(null);
const done = ref<{ filename: string; counts: { sales: number; lines: number; expenses: number; invoices: number } } | null>(null);

const presets = computed(() => {
  const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  const lastQ = q === 0 ? { year: thisYear - 1, q: 3 } : { year: thisYear, q: q - 1 };
  const qFrom = `${lastQ.year}-${String(lastQ.q * 3 + 1).padStart(2, '0')}-01`;
  const qTo = localIsoDay(new Date(lastQ.year, lastQ.q * 3 + 3, 0));
  return [
    { label: `This year`, from: `${thisYear}-01-01`, to: today },
    { label: `${thisYear - 1}`, from: `${thisYear - 1}-01-01`, to: `${thisYear - 1}-12-31` },
    { label: `Last quarter`, from: qFrom, to: qTo },
  ];
});
function pick(p: { from: string; to: string }): void {
  from.value = p.from;
  to.value = p.to;
  done.value = null;
}

async function download(): Promise<void> {
  if (!from.value || !to.value || from.value > to.value) return void (error.value = 'Give the period as two dates, first to last.');
  busy.value = true;
  error.value = null;
  try {
    const res = await api.export(from.value, to.value);
    const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
    await sdk().ui.saveFile(res.filename, new Blob([bytes as unknown as BlobPart], { type: 'application/zip' }), 'application/zip');
    done.value = { filename: res.filename, counts: res.counts };
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not build the export.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="card" @submit.prevent="download">
    <div class="formhead">
      <h2>For the accountant</h2>
      <button type="button" class="quiet" @click="emit('close')">Close</button>
    </div>
    <p class="hint">One zip with the period's sales (one row per sale, one per item, VAT shown), the ledger's expenses and every invoice attached to them, plus a README that says what each file is.</p>
    <div class="chips">
      <button v-for="p in presets" :key="p.label" type="button" class="chip" :class="{ on: from === p.from && to === p.to }" @click="pick(p)">{{ p.label }}</button>
    </div>
    <div class="dates">
      <label><span>From</span><input v-model="from" type="date" required @input="done = null" /></label>
      <label><span>To</span><input v-model="to" type="date" required @input="done = null" /></label>
      <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Building…' : 'Download zip' }}</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-else-if="done" class="ok">Saved {{ done.filename }}: {{ done.counts.sales }} sale{{ done.counts.sales === 1 ? '' : 's' }}, {{ done.counts.expenses }} expense{{ done.counts.expenses === 1 ? '' : 's' }}, {{ done.counts.invoices }} invoice{{ done.counts.invoices === 1 ? '' : 's' }}.</p>
  </form>
</template>

<style scoped>
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .75rem; }
.formhead { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
h2 { margin: 0; font-size: 1.05rem; }
.hint { margin: 0; font-size: .9rem; color: var(--zfy-muted, #5a6472); max-width: 70ch; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
.chips { display: flex; gap: .3rem; flex-wrap: wrap; }
.chip { font-size: .78rem; padding: .2rem .6rem; border-radius: 999px; min-height: 0; }
.chip.on { background: var(--zfy-accent, #0e7c66); color: #fff; }
.dates { display: flex; gap: .6rem; align-items: flex-end; flex-wrap: wrap; }
.dates label { display: flex; flex-direction: column; gap: .2rem; font-size: .8rem; }
</style>
