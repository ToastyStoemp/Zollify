<script setup lang="ts">
import { ref } from 'vue';
import { authFetch, saveFile } from '@zollify/platform';

/**
 * The DSFinV-K export: the till records a German tax inspection asks for
 * (Kassennachschau, Außenprüfung), from every device of the account, built
 * on the server from what has synced. Checked first, so what is missing -
 * a day not yet closed, a device that has not synced - shows before the
 * file goes to the tax office.
 */

const today = new Date();
const iso = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const from = ref(iso(new Date(today.getFullYear(), today.getMonth(), 1)));
const to = ref(iso(today));
const all = ref(false);

interface Summary {
  closings: number;
  receipts: number;
  warnings: string[];
}
const summary = ref<Summary | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

const query = (): string => `/m/pos/dsfinvk?from=${from.value}&to=${to.value}${all.value ? '&all=1' : ''}`;

async function check(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    summary.value = (await authFetch(query())) as Summary;
  } catch (err) {
    summary.value = null;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function download(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const zip = (await authFetch(`${query()}&download=1`)) as Blob;
    await saveFile(`dsfinvk_${from.value}_${to.value}.zip`, zip, 'application/zip');
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="tax-export">
    <h2>Tax export (DSFinV-K)</h2>
    <p class="hint">
      What a German tax inspection asks of an electronic till: every closing in the period with its receipts, VAT, payments and
      TSE signatures, in the format the tax office reads (DSFinV-K 2.4). Built from every device's synced sales - let each till
      close its day and sync first.
    </p>
    <div class="range">
      <label><span>From</span><input v-model="from" type="date" @change="summary = null" /></label>
      <label><span>To</span><input v-model="to" type="date" @change="summary = null" /></label>
    </div>
    <label class="check">
      <input v-model="all" type="checkbox" @change="summary = null" />
      <span>Include events outside Germany</span>
    </label>
    <div class="row">
      <button type="button" :disabled="busy || !from || !to" @click="check">{{ busy && !summary ? 'Checking…' : 'Check' }}</button>
      <button type="button" class="primary" :disabled="busy || !summary || summary.closings === 0" @click="download">Download ZIP</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template v-if="summary">
      <p class="result">
        {{ summary.closings }} closing{{ summary.closings === 1 ? '' : 's' }}, {{ summary.receipts }} receipt{{ summary.receipts === 1 ? '' : 's' }}.
        <template v-if="!summary.closings"> Nothing to export in this period.</template>
      </p>
      <ul v-if="summary.warnings.length" class="warnings">
        <li v-for="w in summary.warnings" :key="w">{{ w }}</li>
      </ul>
      <p v-else-if="summary.closings" class="ok">Nothing missing.</p>
    </template>
  </section>
</template>

<style scoped>
.tax-export { display: flex; flex-direction: column; gap: .75rem; max-width: 40rem; }
h2 { margin: 0; font-size: 1.1rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .875rem; }
.range { display: flex; gap: .75rem; flex-wrap: wrap; }
.range label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.check { display: flex; align-items: center; gap: .5rem; font-size: .875rem; }
.row { display: flex; gap: .5rem; flex-wrap: wrap; }
.result { margin: 0; font-size: .9rem; }
.warnings { margin: 0; padding-left: 1.2rem; color: var(--zfy-warning-ink, #8a5a1e); font-size: .875rem; display: flex; flex-direction: column; gap: .25rem; }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); font-size: .875rem; }
</style>
