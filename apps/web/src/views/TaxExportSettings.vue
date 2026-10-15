<script setup lang="ts">
import { ref } from 'vue';
import { authFetch, createShellUi, saveFile } from '@zollify/platform';

const ui = createShellUi('shell');

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

// ── Till register (§ 146a Abs. 4 AO) ────────────────────────────────────────
// Every electronic till and its TSE must be reported to the tax office in Mein
// ELSTER within a month of first use (and again when taken out of use). The
// register lists what to enter, from the synced records of every device.
interface TillTse {
  serial: string;
  algorithm: string;
  test: boolean;
  firstSignedAt: number;
  lastSignedAt: number;
  signatures: number;
}
interface TillRecord {
  till: string;
  deviceIds: string[];
  device: { brand: string; model: string; software: string; version: string } | null;
  firstReceiptAt: number | null;
  lastReceiptAt: number | null;
  receipts: number;
  closings: number;
  tses: TillTse[];
}
const tills = ref<TillRecord[] | null>(null);
const tillsBusy = ref(false);
const day = (ms: number | null): string => (ms == null ? '-' : new Date(ms).toLocaleDateString());
const deviceLabel = (t: TillRecord): string => (t.device ? `${t.device.brand} ${t.device.model} - ${t.device.software} ${t.device.version}` : 'Zollify');
async function loadTills(): Promise<void> {
  tillsBusy.value = true;
  error.value = null;
  try {
    tills.value = ((await authFetch('/m/pos/dsfinvk/tills')) as { tills: TillRecord[] }).tills;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    tillsBusy.value = false;
  }
}
/** The register as text, to paste into the ELSTER form or send to the tax advisor. */
function tillsText(): string {
  const lines: string[] = ['Till register (§ 146a Abs. 4 AO)', ''];
  for (const t of tills.value ?? []) {
    lines.push(`Till serial number: ${t.till}`);
    lines.push(`  Type: computer-based till (software) - ${deviceLabel(t)}`);
    lines.push(`  First receipt: ${day(t.firstReceiptAt)}  Last receipt: ${day(t.lastReceiptAt)}  Receipts: ${t.receipts}`);
    for (const s of t.tses) lines.push(`  TSE: ${s.serial} (${s.algorithm}${s.test ? ', TEST - not to be reported' : ''}) from ${day(s.firstSignedAt)} to ${day(s.lastSignedAt)}`);
    if (!t.tses.length) lines.push('  TSE: none has signed for this till');
    lines.push('');
  }
  return lines.join('\n');
}
async function copyTills(): Promise<void> {
  try {
    await navigator.clipboard.writeText(tillsText());
    ui.toast('Copied.');
  } catch {
    ui.toast('Could not copy - select the table instead.', { kind: 'error' });
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

    <h2>Till register (§ 146a Abs. 4 AO)</h2>
    <p class="hint">
      Every electronic till and its TSE is reported to the tax office in Mein ELSTER ("Mitteilung über die Verwendung elektronischer
      Aufzeichnungssysteme") within a month of its first use, and again when it is taken out of use. This lists what to enter, from every
      device's synced records: the till serial number, the device, the dates and the TSE that signed for it. The TSE's certification
      ID comes from its maker (fiskaly's dashboard, the Swissbit data sheet). See docs/germany-compliance.md.
    </p>
    <div class="row">
      <button type="button" :disabled="tillsBusy" @click="loadTills">{{ tillsBusy ? 'Loading…' : tills ? 'Refresh' : 'Show tills' }}</button>
      <button v-if="tills?.length" type="button" @click="copyTills">Copy as text</button>
    </div>
    <template v-if="tills">
      <p v-if="!tills.length" class="result">No till has taken a receipt yet.</p>
      <table v-else class="tills">
        <thead>
          <tr><th>Till serial number</th><th>Device</th><th>First receipt</th><th>Last receipt</th><th>TSE</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in tills" :key="t.till">
            <td class="mono">{{ t.till }}</td>
            <td>{{ deviceLabel(t) }}<br /><small>{{ t.receipts }} receipt{{ t.receipts === 1 ? '' : 's' }}, {{ t.closings }} closing{{ t.closings === 1 ? '' : 's' }}</small></td>
            <td>{{ day(t.firstReceiptAt) }}</td>
            <td>{{ day(t.lastReceiptAt) }}</td>
            <td>
              <template v-if="!t.tses.length"><span class="warn">none</span></template>
              <div v-for="s in t.tses" :key="s.serial" class="tse">
                <span class="mono">{{ s.serial }}</span>
                <small>{{ s.algorithm }}<template v-if="s.test"> - <span class="warn">test, not reported</span></template> · {{ day(s.firstSignedAt) }} - {{ day(s.lastSignedAt) }}</small>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
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
.tills { width: 100%; border-collapse: collapse; font-size: .82rem; }
.tills th, .tills td { text-align: left; vertical-align: top; padding: .4rem .5rem; border-top: 1px solid var(--zfy-line, #d6dde4); }
.tills th { font-weight: 600; color: var(--zfy-muted, #5a6472); border-top: 0; }
.tills small { color: var(--zfy-muted, #5a6472); display: block; }
.tse { margin-bottom: .3rem; }
.mono { font-family: ui-monospace, monospace; font-size: .78rem; word-break: break-all; }
.warn { color: var(--zfy-warning-ink, #8a5a1e); }
</style>
