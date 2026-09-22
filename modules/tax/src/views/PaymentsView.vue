<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { monthKey, round2, type Cluster } from '../engine/types';
import * as eng from '../engine/clusters';
import { ParseError, fromSourceRow, parseSheet } from '../engine/parse';
import { clusterPdf, download, monthPdf, toBase64 } from '../engine/pdf';
import { api } from '../api';
import { bookings, clusters, config, domesticVat, events, loaded, loadWork, clearWork, refreshEvents, refreshStatus, saveWork, status, tidNames } from '../state';
import { sdk } from '../runtime';
import ClusterCard from './ClusterCard.vue';
import { Icon } from '@zollify/ui';

/**
 * Payments: turn the month's card and online takings into bookings.
 *
 * Import (a file, or a pull from the connected providers) → clusters render,
 * one per convention → match each to an event → verify against myPOS → book
 * revenue per cluster and fees per month into Lexware.
 */

const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const filter = ref('all');
const busy = ref<string | null>(null);
const progress = ref<string[]>([]);

// ── Import ──────────────────────────────────────────────────────────────────
const dragging = ref(false);
const sources = ref<Record<string, boolean>>({ mypos: true, shopify: true, sumup: true });
const myposAccounts = ref<{ account_number: string; currency?: string; name?: string }[]>([]);
const pickedAccounts = ref<Set<string>>(new Set());
const from = ref('');
const to = ref('');

const liveSources = computed(() => {
  const st = status.value;
  if (!st) return [];
  const out: { id: string; label: string }[] = [];
  if (st.enabled.mypos !== false && st.mypos.mode === 'live') out.push({ id: 'mypos', label: 'myPOS' });
  if (st.enabled.shopify !== false && st.shopify.mode === 'live') out.push({ id: 'shopify', label: 'Shopify' });
  if (st.enabled.sumup !== false && st.sumup.mode === 'live') out.push({ id: 'sumup', label: 'SumUp' });
  return out;
});

const iso = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function preset(mode: 'last-month' | 'this-month' | 'last-3-months'): void {
  const now = new Date();
  if (mode === 'this-month') {
    from.value = iso(new Date(now.getFullYear(), now.getMonth(), 1));
    to.value = iso(now);
  } else if (mode === 'last-3-months') {
    from.value = iso(new Date(now.getFullYear(), now.getMonth() - 3, 1));
    to.value = iso(new Date(now.getFullYear(), now.getMonth(), 0));
  } else {
    from.value = iso(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    to.value = iso(new Date(now.getFullYear(), now.getMonth(), 0));
  }
}

onMounted(async () => {
  preset('last-month');
  refreshEvents();
  if (!loaded.value) await loadWork();
  try {
    await refreshStatus();
    if (liveSources.value.some((s) => s.id === 'mypos')) {
      myposAccounts.value = (await api.myposAccounts()).accounts;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not reach the books server half.';
  }
});

async function onFile(file: File | undefined): Promise<void> {
  if (!file) return;
  error.value = null;
  busy.value = 'file';
  try {
    const XLSX = await import('xlsx');
    const isCsv = file.name.toLowerCase().endsWith('.csv');
    const wb = isCsv ? XLSX.read(await file.text(), { type: 'string', raw: true }) : XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]!]!;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: isCsv });
    const { format, txns } = parseSheet(raw, tidNames.value);
    await saveWork(eng.mergeIn(clusters.value, txns));
    notice.value = `Imported ${txns.length} row(s) from a ${format.replace('-', ' ')} file.`;
  } catch (err) {
    error.value = err instanceof ParseError ? err.message : `Could not read that file: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    busy.value = null;
  }
}

function onDrop(e: DragEvent): void {
  dragging.value = false;
  void onFile(e.dataTransfer?.files[0]);
}

async function pull(): Promise<void> {
  error.value = null;
  if (!from.value || !to.value || from.value > to.value) {
    error.value = 'Pick a valid from and to date.';
    return;
  }
  const wanted = liveSources.value.filter((s) => sources.value[s.id]);
  if (!wanted.length) {
    error.value = 'Select at least one source.';
    return;
  }
  busy.value = 'pull';
  progress.value = [];
  const all = [];
  const errs: string[] = [];
  for (const s of wanted) {
    try {
      let rows;
      if (s.id === 'mypos') rows = (await api.myposTransactions(from.value, to.value, [...pickedAccounts.value])).transactions;
      else if (s.id === 'shopify') rows = (await api.shopifyOrders(from.value, to.value)).orders;
      else rows = (await api.sumupTransactions(from.value, to.value)).transactions;
      all.push(...rows.map(fromSourceRow));
      progress.value.push(`${s.label}: ${rows.length}`);
    } catch (err) {
      errs.push(`${s.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (all.length) await saveWork(eng.mergeIn(clusters.value, all));
  notice.value = (all.length ? `Imported ${all.length} row(s) - ${progress.value.join(', ')}.` : 'No transactions found.') + (errs.length ? ` Problems: ${errs.join('; ')}` : '');
  busy.value = null;
}

async function reset(): Promise<void> {
  if (!(await sdk().ui.confirm('Clear every imported transaction and cluster from this device?', 'Start fresh'))) return;
  await clearWork();
  notice.value = null;
}

// ── Derived ─────────────────────────────────────────────────────────────────
const devices = computed(() => [...new Set(clusters.value.map((c) => c.device))].sort());
const visible = computed(() => (filter.value === 'all' ? clusters.value : clusters.value.filter((c) => c.device === filter.value)));
const totals = computed(() => {
  const pay = round2(visible.value.reduce((s, c) => s + c.totalPay, 0));
  const cash = round2(visible.value.reduce((s, c) => s + (c.cashAmount || 0), 0));
  const fee = round2(visible.value.reduce((s, c) => s + c.totalFee, 0));
  return { pay, cash, fee, net: round2(pay + cash - fee), txns: visible.value.reduce((s, c) => s + c.payments.length, 0) };
});
const months = computed(() => {
  const map = new Map<string, Cluster[]>();
  for (const c of visible.value) (map.get(monthKey(c.start)) ?? map.set(monthKey(c.start), []).get(monthKey(c.start))!).push(c);
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([key, list]) => ({
    key,
    label: new Date(Number(key.slice(0, 4)), Number(key.slice(5)) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    list,
    pay: round2(list.reduce((s, c) => s + c.totalPay, 0)),
    cash: round2(list.reduce((s, c) => s + (c.cashAmount || 0), 0)),
    fee: round2(list.reduce((s, c) => s + c.totalFee, 0)),
    feesBooked: bookings.value.get(`PN_${key}_F`) ?? null,
  }));
});
const readyCount = computed(() => clusters.value.filter((c) => !bookings.value.has(`${c.clusterID}_P`) && eng.ready(c)).length);
const matchedCount = computed(() => clusters.value.filter((c) => c.matchedEvent && !c.isOnlineCluster).length);
const canBook = computed(() => Boolean(status.value?.lexware.configured));
const fmt = (n: number): string => eng.fmtAmt(n);

// ── Bulk actions ────────────────────────────────────────────────────────────
async function autoMatch(): Promise<void> {
  refreshEvents();
  if (!events.value.length) {
    error.value = 'No dated events to match against - add dates to your events first.';
    return;
  }
  busy.value = 'match';
  try {
    const r = eng.autoMergeAndMatch(clusters.value, events.value);
    await saveWork(r.clusters);
    notice.value = `Auto merge & match: ${r.matched} matched, ${r.merged} merged across terminals, ${r.ambiguous} left for review (overlapping events).`;
  } finally {
    busy.value = null;
  }
}

async function setAllCash(): Promise<void> {
  const matched = clusters.value.filter((c) => c.matchedEvent && !c.isOnlineCluster);
  if (!matched.length) {
    error.value = 'No clusters are matched to an event yet.';
    return;
  }
  const manual = matched.filter((c) => (c.cashAmount || 0) > 0 && !c.cashLoaded).length;
  if (manual && !(await sdk().ui.confirm(`This overwrites cash you entered by hand on ${manual} cluster(s).`, 'Set cash from sales'))) return;
  busy.value = 'cash';
  let next = clusters.value;
  let total = 0;
  for (const c of matched) {
    try {
      const d = await api.eventCash(c.matchedEvent!.id);
      total += d.cash;
      next = eng.replace(next, { ...next.find((x) => x.uid === c.uid)!, cashAmount: d.cash, cashNote: 'Cash from sales', cashLoaded: true });
    } catch {
      /* leave it */
    }
  }
  await saveWork(next);
  busy.value = null;
  notice.value = `Cash set on ${matched.length} cluster(s) - ${fmt(total)} added.`;
}

async function book(uid: string): Promise<void> {
  const c = clusters.value.find((x) => x.uid === uid);
  if (!c) return;
  if (!c.isOnlineCluster && !c.customName.trim() && !c.matchedEvent) {
    error.value = `Give ${c.clusterID} a name or match it to an event first (Edit cluster).`;
    return;
  }
  const payload = eng.revenuePayload(c, config.value, domesticVat.value);
  if (!payload) return;
  busy.value = 'book';
  try {
    await api.book({ ...payload, dryRun: true });
    if (!(await sdk().ui.confirm(`Book ${fmt(payload.totalGrossAmount)} as ${payload.voucherNumber} into Lexware?`, 'Book revenue'))) return;
    const pdf = clusterPdf(c, 'payments');
    const res = await api.book({ ...payload, pdfBase64: toBase64(pdf.bytes), filename: pdf.filename, dryRun: false });
    await refreshStatus();
    notice.value = `Booked ${payload.voucherNumber}. ${res.permalink ?? ''}`;
  } catch (err) {
    error.value = `Lexware: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    busy.value = null;
  }
}

async function bookAllReady(): Promise<void> {
  const ready = clusters.value.filter((c) => !bookings.value.has(`${c.clusterID}_P`) && eng.ready(c));
  if (!ready.length) return;
  const total = round2(ready.reduce((s, c) => s + c.totalPay + (c.cashAmount || 0), 0));
  if (!(await sdk().ui.confirm(`Book ${ready.length} cluster(s) totalling ${fmt(total)} to Lexware? This creates ${ready.length} separate voucher(s).`, 'Book all ready'))) return;
  busy.value = 'book';
  let ok = 0;
  const fails: string[] = [];
  for (const c of ready) {
    const payload = eng.revenuePayload(c, config.value, domesticVat.value);
    if (!payload) {
      fails.push(`${c.clusterID}: needs a name`);
      continue;
    }
    try {
      const pdf = clusterPdf(c, 'payments');
      await api.book({ ...payload, pdfBase64: toBase64(pdf.bytes), filename: pdf.filename, dryRun: false });
      ok++;
    } catch (err) {
      fails.push(`${c.clusterID}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await refreshStatus();
  busy.value = null;
  notice.value = `Booked ${ok}/${ready.length}${fails.length ? ` · failed: ${fails.join('; ')}` : '.'}`;
}

async function bookFees(key: string): Promise<void> {
  const payload = eng.feesPayload(key, clusters.value, config.value);
  if (!payload) {
    error.value = 'No fees in this month.';
    return;
  }
  busy.value = 'book';
  try {
    await api.book({ ...payload, dryRun: true });
    if (!(await sdk().ui.confirm(`Book monthly fees ${fmt(payload.totalGrossAmount)} as ${payload.voucherNumber}?`, 'Book fees'))) return;
    const pdf = monthPdf(key, clusters.value, 'fees')!;
    const res = await api.book({ ...payload, pdfBase64: toBase64(pdf.bytes), filename: pdf.filename, dryRun: false });
    await refreshStatus();
    notice.value = `Fees booked. ${res.permalink ?? ''}`;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    error.value = `Lexware fees: ${m}${/category/i.test(m) ? ' - set the fee category under Settings → Integrations.' : ''}`;
  } finally {
    busy.value = null;
  }
}

function monthReport(key: string, mode: 'payments' | 'fees'): void {
  const out = monthPdf(key, clusters.value, mode);
  if (out) download(out.bytes, out.filename);
}
</script>

<template>
  <section class="payments">
    <header class="top">
      <div>
        <h1>Payments</h1>
        <p class="lede">Card and online takings, clustered per convention, matched to your events and booked into Lexware.</p>
      </div>
      <div v-if="status" class="conn" aria-label="Connections">
        <span :class="{ on: status.mypos.mode === 'live' }" :aria-label="`myPOS: ${status.mypos.mode === 'live' ? 'connected' : 'not connected'}`" :title="status.mypos.mode === 'live' ? 'Connected' : 'Not connected'">myPOS</span>
        <span :class="{ on: status.shopify.mode === 'live' && status.shopify.ready }" :aria-label="`Shopify: ${status.shopify.mode === 'live' && status.shopify.ready ? 'connected' : 'not connected'}`" :title="status.shopify.mode === 'live' && status.shopify.ready ? 'Connected' : 'Not connected'">Shopify</span>
        <span :class="{ on: status.sumup.mode === 'live' }" :aria-label="`SumUp: ${status.sumup.mode === 'live' ? 'connected' : 'not connected'}`" :title="status.sumup.mode === 'live' ? 'Connected' : 'Not connected'">SumUp</span>
        <span :class="{ on: status.lexware.configured }" :aria-label="`Lexware: ${status.lexware.configured ? 'connected' : 'not connected'}`" :title="status.lexware.configured ? 'Connected' : 'Not connected'">Lexware</span>
      </div>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <!-- ── Import ─────────────────────────────────────────────────────────── -->
    <div class="import">
      <label :class="['drop', { dragging }]" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
        <input type="file" accept=".csv,.xlsx,.xls" @change="onFile(($event.target as HTMLInputElement).files?.[0])" />
        <strong>{{ busy === 'file' ? 'Reading…' : 'Drop a file or click to choose' }}</strong>
        <span>myPOS transaction export or monthly statement, Shopify orders CSV, Wise history</span>
      </label>

      <form v-if="liveSources.length" class="pull" @submit.prevent="pull">
        <div class="srcs">
          <label v-for="s in liveSources" :key="s.id" class="inline"><input v-model="sources[s.id]" type="checkbox" /> <span>{{ s.label }}</span></label>
        </div>
        <div v-if="sources.mypos && myposAccounts.length" class="srcs accounts">
          <span class="hint">Accounts:</span>
          <label v-for="a in myposAccounts" :key="a.account_number" class="inline">
            <input type="checkbox" :checked="pickedAccounts.has(a.account_number)" @change="pickedAccounts.has(a.account_number) ? pickedAccounts.delete(a.account_number) : pickedAccounts.add(a.account_number)" />
            <span>{{ a.name || a.account_number }}{{ a.currency ? ` (${a.currency})` : '' }}</span>
          </label>
        </div>
        <div class="range">
          <label><span>From</span><input v-model="from" type="date" /></label>
          <label><span>To</span><input v-model="to" type="date" /></label>
          <button type="button" class="quiet" @click="preset('last-month')">Last month</button>
          <button type="button" class="quiet" @click="preset('this-month')">This month</button>
          <button type="button" class="quiet" @click="preset('last-3-months')">Last 3 months</button>
          <button type="submit" class="primary" :disabled="busy === 'pull'">{{ busy === 'pull' ? 'Pulling…' : 'Pull transactions' }}</button>
        </div>
      </form>
      <p v-else class="hint">Connect myPOS, Shopify or SumUp under Settings → Integrations to pull transactions directly.</p>
    </div>

    <template v-if="clusters.length">
      <ul class="totals">
        <li><span class="label">Card revenue</span><strong class="good">{{ fmt(totals.pay) }}</strong></li>
        <li v-if="totals.cash"><span class="label">Cash</span><strong>{{ fmt(totals.cash) }}</strong></li>
        <li><span class="label">Fees</span><strong class="bad">−{{ fmt(totals.fee) }}</strong></li>
        <li><span class="label">Net</span><strong>{{ fmt(totals.net) }}</strong></li>
        <li><span class="label">Transactions</span><strong>{{ totals.txns }}</strong></li>
        <li><span class="label">Clusters</span><strong>{{ visible.length }}</strong></li>
      </ul>

      <div class="toolbar">
        <div class="pills">
          <button type="button" :class="['pill', { active: filter === 'all' }]" @click="filter = 'all'">All devices</button>
          <button v-for="d in devices" :key="d" type="button" :class="['pill', { active: filter === d }]" @click="filter = d">{{ d }}</button>
        </div>
        <div class="bulk">
          <button type="button" :disabled="!events.length || busy === 'match'" @click="autoMatch"><Icon name="sparkles" :size="14" /> {{ busy === 'match' ? 'Matching…' : 'Auto merge & match' }}</button>
          <button type="button" :disabled="!matchedCount || busy === 'cash'" @click="setAllCash"><Icon name="coins" :size="14" /> Cash from sales ({{ matchedCount }})</button>
          <button v-if="canBook" type="button" class="primary" :disabled="!readyCount || busy === 'book'" @click="bookAllReady"><Icon name="send" :size="14" /> Book all ready{{ readyCount ? ` (${readyCount})` : '' }}</button>
          <button type="button" class="danger" @click="reset">Start fresh</button>
        </div>
      </div>

      <section v-for="m in months" :key="m.key" class="month">
        <header class="mhead">
          <div class="mtitle"><span class="cid">PN_{{ m.key }}</span> {{ m.label }}</div>
          <div class="mstats">
            <span>Revenue <strong class="good">{{ fmt(m.pay) }}</strong></span>
            <span v-if="m.cash">Cash <strong>{{ fmt(m.cash) }}</strong></span>
            <span>Fees <strong class="bad">−{{ fmt(m.fee) }}</strong></span>
            <span>Net <strong>{{ fmt(round2(m.pay + m.cash - m.fee)) }}</strong></span>
          </div>
          <div class="mactions">
            <button type="button" class="quiet" @click="monthReport(m.key, 'payments')">PN_{{ m.key }}_P.pdf</button>
            <button type="button" class="quiet" @click="monthReport(m.key, 'fees')">PN_{{ m.key }}_F.pdf</button>
            <a v-if="m.feesBooked" class="pill good" :href="`https://app.lexware.de/permalink/vouchers/view/${m.feesBooked.voucherId}`" target="_blank" rel="noopener"><Icon name="check" :size="12" /> Fees booked</a>
            <button v-else-if="canBook && m.fee > 0" type="button" :disabled="busy === 'book'" @click="bookFees(m.key)"><Icon name="send" :size="14" /> {{ busy === 'book' ? 'Booking…' : 'Book fees' }}</button>
          </div>
        </header>
        <ClusterCard v-for="c in m.list" :key="c.uid" :cluster="c" :booking="busy === 'book'" @book="book" />
      </section>
    </template>
    <p v-else-if="loaded" class="empty">Nothing imported yet. Drop a payment export above, or pull from a connected provider.</p>
  </section>
</template>

<style scoped>
.payments { display: flex; flex-direction: column; gap: 1rem; }
.top { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
.lede, .hint, .empty { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .9rem; max-width: 60ch; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.notice { color: var(--zfy-accent-ink, #0a5a4a); margin: 0; font-size: .9rem; }
.conn { display: flex; gap: .75rem; font-size: .78rem; color: var(--zfy-muted, #5a6472); }
.conn span::before { content: ''; display: inline-block; width: .5rem; height: .5rem; border-radius: 50%; background: var(--zfy-line, #d6dde4); margin-right: .3rem; }
.conn span.on::before { background: var(--zfy-accent, #0e7c66); }
.import { display: flex; flex-direction: column; gap: .75rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); }
.drop { display: flex; flex-direction: column; align-items: center; gap: .2rem; padding: 1.2rem; border: 2px dashed var(--zfy-line, #d6dde4); border-radius: 10px; cursor: pointer; text-align: center; font-size: .85rem; color: var(--zfy-muted, #5a6472); }
.drop strong { color: var(--zfy-ink, #141a22); }
.drop.dragging { border-color: var(--zfy-accent, #0e7c66); background: var(--zfy-accent-soft, #deeee9); }
.drop input { display: none; }
.pull { display: flex; flex-direction: column; gap: .5rem; }
.srcs { display: flex; gap: 1rem; flex-wrap: wrap; align-items: center; font-size: .875rem; }
.inline { display: inline-flex; align-items: center; gap: .35rem; }
.range { display: flex; align-items: flex-end; gap: .5rem; flex-wrap: wrap; }
.range label { display: flex; flex-direction: column; gap: .2rem; font-size: .8rem; }
.totals { list-style: none; margin: 0; padding: 0; display: flex; gap: .6rem; flex-wrap: wrap; }
.totals li { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .5rem .8rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; min-width: 8rem; }
.totals .label { font-size: .7rem; letter-spacing: .06em; text-transform: uppercase; color: var(--zfy-muted, #5a6472); }
.totals strong { font-size: 1.1rem; font-variant-numeric: tabular-nums; }
.good { color: var(--zfy-accent-ink, #0a5a4a); }
.bad { color: var(--zfy-danger, #c6512f); }
.toolbar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
.pills, .bulk { display: flex; gap: .4rem; flex-wrap: wrap; }
.bulk button, .mactions button { display: inline-flex; align-items: center; gap: .35rem; }
.pill { min-height: 2.2rem; padding: .25rem .8rem; border-radius: 999px; font-size: .8rem; }
.pill.active { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); border-color: var(--zfy-accent, #0e7c66); }
.pill.good { display: inline-flex; align-items: center; gap: .3rem; text-decoration: none; color: var(--zfy-accent-ink, #0a5a4a); background: var(--zfy-accent-soft, #deeee9); border: 1px solid transparent; }
.month { display: flex; flex-direction: column; gap: .5rem; }
.mhead { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; padding: .4rem 0; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
.mtitle { font-weight: 700; }
.cid { font-family: ui-monospace, monospace; font-size: .8rem; color: var(--zfy-muted, #5a6472); margin-right: .4rem; }
.mstats { display: flex; gap: 1rem; font-size: .82rem; color: var(--zfy-muted, #5a6472); font-variant-numeric: tabular-nums; }
.mactions { display: flex; gap: .4rem; flex-wrap: wrap; }
</style>
