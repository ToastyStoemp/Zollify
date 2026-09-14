<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Cluster, MatchedEvent } from '../engine/types';
import { isoDay, monthKey, round2 } from '../engine/types';
import * as eng from '../engine/clusters';
import { clusterPdf, download } from '../engine/pdf';
import { api } from '../api';
import { bookings, clusters, events, saveWork, status } from '../state';
import { sdk } from '../runtime';
import { Icon } from '@zollify/ui';

const props = defineProps<{ cluster: Cluster }>();
const emit = defineEmits<{ book: [uid: string] }>();

const open = ref(false);
const editing = ref(false);
const showTxns = ref(false);
const busy = ref<string | null>(null);

const c = computed(() => props.cluster);
const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString('nl-BE', { day: '2-digit', month: 'short', year: 'numeric' });
const fmtDateTime = (ms: number): string => new Date(ms).toLocaleString('nl-BE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmt = (n: number): string => eng.fmtAmt(n, c.value.txns[0]?.currency ?? 'EUR');
const dateRange = computed(() => fmtDate(c.value.start) + (fmtDate(c.value.start) !== fmtDate(c.value.end) ? ' – ' + fmtDate(c.value.end) : ''));
const revenue = computed(() => round2(c.value.totalPay + (c.value.cashAmount || 0)));
const net = computed(() => round2(revenue.value - c.value.totalFee));
const feeRate = computed(() => (c.value.totalPay > 0 ? ((c.value.totalFee / c.value.totalPay) * 100).toFixed(2) : '0.00'));
const sources = computed(() => [...new Set(c.value.txns.map((t) => t.source))]);
const booked = computed(() => bookings.value.get(`${c.value.clusterID}_P`) ?? null);
const isReady = computed(() => eng.ready(c.value));
const suggestion = computed(() => (c.value.matchedEvent ? null : eng.suggestEvent(c.value, events.value)));
const ambiguous = computed(() => (c.value.matchedEvent ? [] : eng.overlappingEvents(c.value, events.value)));
const overlaps = computed(() => eng.overlapping(clusters.value, c.value));
const manual = computed(() => c.value.txns.filter((t) => t.isManual));
const monthOnline = computed(() =>
  c.value.isOnlineCluster ? null : clusters.value.find((x) => x.uid !== c.value.uid && x.isOnlineCluster && monthKey(x.start) === monthKey(c.value.start)) ?? null,
);
const canBook = computed(() => Boolean(status.value?.lexware.configured));
const sorted = computed(() => [...c.value.txns].sort((a, b) => a.at - b.at));

// ── Edit form ───────────────────────────────────────────────────────────────
const name = ref('');
const country = ref('');
const cashAmount = ref('');
const cashNote = ref('');
const splitDate = ref('');
const mergeWith = ref('');
const selected = ref<Set<string>>(new Set());

function startEdit(): void {
  name.value = c.value.customName;
  country.value = c.value.country;
  cashAmount.value = c.value.cashAmount ? String(c.value.cashAmount) : '';
  cashNote.value = c.value.cashNote;
  splitDate.value = '';
  mergeWith.value = '';
  selected.value = new Set();
  editing.value = true;
  open.value = true;
}

async function apply(next: Cluster[] | null, closeEditor = true): Promise<void> {
  if (!next) return;
  await saveWork(next);
  if (closeEditor) editing.value = false;
}

const update = (patch: Partial<Cluster>) => eng.replace(clusters.value, { ...c.value, ...patch });

async function applyName(): Promise<void> {
  await apply(update({ customName: name.value.trim(), country: country.value.trim() }), false);
}
async function applyCash(): Promise<void> {
  const raw = cashAmount.value.trim().replace(',', '.');
  const amt = raw === '' ? 0 : Number(raw);
  if (Number.isNaN(amt)) {
    sdk().ui.toast('Enter a valid amount, e.g. 125.50', { kind: 'error' });
    return;
  }
  await apply(update({ cashAmount: Math.max(0, amt), cashNote: cashNote.value.trim(), cashLoaded: false }), false);
}
async function doSplitAtDate(): Promise<void> {
  if (!splitDate.value) return;
  const next = eng.splitAtDate(clusters.value, c.value.uid, splitDate.value);
  if (!next) sdk().ui.toast('Every transaction falls on one side of that date — pick one inside the range.', { kind: 'error' });
  await apply(next);
}
async function doSplitSelected(): Promise<void> {
  const next = eng.splitSelected(clusters.value, c.value.uid, [...selected.value]);
  if (!next) sdk().ui.toast('Select some, but not all, transactions to split off.', { kind: 'error' });
  await apply(next);
}
function toggleSel(id: string): void {
  const s = new Set(selected.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selected.value = s;
}
async function doMerge(uid: string): Promise<void> {
  if (!uid) return;
  await apply(eng.mergeTwo(clusters.value, c.value.uid, uid));
}
async function doDelete(): Promise<void> {
  if (!(await sdk().ui.confirm('Delete this cluster? Its transactions leave the working set (re-import the file to get them back).', 'Delete cluster'))) return;
  await apply(eng.remove(clusters.value, c.value.uid));
}
async function removeTxn(id: string): Promise<void> {
  await apply(eng.removeTxn(clusters.value, c.value.uid, id), false);
}
async function removeManual(): Promise<void> {
  if (!(await sdk().ui.confirm(`Remove ${manual.value.length} manual payment order(s) from this cluster?`, 'Remove manual orders'))) return;
  await apply(eng.removeManual(clusters.value, c.value.uid), false);
}
async function match(id: string): Promise<void> {
  const ev = events.value.find((e) => e.id === id) ?? null;
  await apply(eng.replace(clusters.value, eng.matchTo(c.value, ev)), false);
}
async function verify(): Promise<void> {
  busy.value = 'verify';
  try {
    const r = await api.myposVerify(isoDay(c.value.start), isoDay(c.value.end));
    const diff = round2(r.summary.gross - c.value.totalPay);
    await apply(update({ verify: { gross: r.summary.gross, fees: r.summary.fees, diff, ok: Math.abs(diff) < 0.01, mode: r.mode } }), false);
  } catch (e) {
    await apply(update({ verify: { error: e instanceof Error ? e.message : String(e) } }), false);
  } finally {
    busy.value = null;
  }
}
async function loadCash(): Promise<void> {
  if (!c.value.matchedEvent) return;
  busy.value = 'cash';
  try {
    const d = await api.eventCash(c.value.matchedEvent.id);
    await apply(update({ cashAmount: d.cash, cashNote: 'Cash from sales', cashLoaded: true }), false);
  } catch (e) {
    sdk().ui.toast(`Cash from sales: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
  } finally {
    busy.value = null;
  }
}
function pdf(mode: 'payments' | 'fees'): void {
  const out = clusterPdf(c.value, mode);
  download(out.bytes, out.filename);
}
</script>

<template>
  <article :class="['cluster', { open, editing, booked: booked }]">
    <header class="head" @click="open = !open">
      <div class="title">
        <span v-if="booked" class="ready booked" title="Booked to Lexware"><Icon name="send" :size="12" /></span>
        <span v-else-if="isReady" class="ready" title="Ready to book"><Icon name="check" :size="12" /></span>
        <span class="cid">{{ c.clusterID }}</span>
        <span class="range">{{ dateRange }}</span>
        <span v-if="c.customName" class="name">{{ c.customName }}</span>
        <span v-if="c.isOnlineCluster" class="badge online">Online</span>
        <span v-for="d in c.devices ?? [c.device]" v-else :key="d" :class="['badge', sources[0] ?? 'mypos']">{{ d }}</span>
        <span v-if="ambiguous.length > 1" class="badge warn" :title="ambiguous.map((e) => e.name).join(', ')"><Icon name="alert-triangle" :size="12" /> {{ ambiguous.length }} events</span>
        <span v-if="manual.length" class="badge warn"><Icon name="hand" :size="12" /> {{ manual.length }} manual</span>
      </div>
      <div class="meta">
        <span class="stat"><small>Revenue{{ c.cashAmount ? ' +cash' : '' }}</small><strong class="good">{{ fmt(revenue) }}</strong></span>
        <span class="stat"><small>Fees</small><strong class="bad">−{{ fmt(c.totalFee) }}</strong></span>
        <span class="stat"><small>Net</small><strong>{{ fmt(net) }}</strong></span>
        <span class="stat"><small>Txns</small><strong>{{ c.payments.length }}</strong></span>
        <Icon class="chev" :name="open ? 'chevron-down' : 'chevron-right'" :size="14" />
      </div>
    </header>

    <div v-if="open" class="body">
      <div v-if="manual.length" class="banner warn">
        <span>
          <strong>{{ manual.length }} manual payment order{{ manual.length !== 1 ? 's' : '' }}</strong> — {{ fmt(manual.reduce((s, t) => s + t.amount, 0)) }}. Likely paid on the card terminal and already in the card data.
          <span class="sub">{{ manual.map((t) => `${t.orderNum} (${fmt(t.amount)})`).join(', ') }}</span>
        </span>
        <button type="button" class="danger" @click="removeManual">Remove from cluster</button>
      </div>
      <div v-for="ov in overlaps" :key="ov.uid" class="banner">
        <span><strong>{{ ov.clusterID }}</strong> ({{ ov.device }}) overlaps these dates — same event?</span>
        <button type="button" @click="doMerge(ov.uid)">Merge clusters</button>
      </div>

      <section v-if="editing" class="editor">
        <div class="row">
          <label><span>Name</span><input v-model="name" type="text" placeholder="e.g. Leipzig Comic Con" /></label>
          <label class="short"><span>Country</span><input v-model="country" type="text" placeholder="Germany" /></label>
          <button type="button" class="primary" @click="applyName">Apply</button>
        </div>
        <div class="row">
          <label class="short"><span>Cash sales</span><input v-model="cashAmount" type="number" min="0" step="0.01" placeholder="0.00" /></label>
          <label><span>Note</span><input v-model="cashNote" type="text" placeholder="optional" /></label>
          <button type="button" @click="applyCash">Save cash</button>
        </div>
        <p class="hint">Cash is added to revenue and the reports; it creates no transactions.</p>

        <div class="row">
          <label class="short"><span>Split at date</span><input v-model="splitDate" type="date" :min="isoDay(c.start)" :max="isoDay(c.end)" /></label>
          <button type="button" @click="doSplitAtDate">Split at date</button>
          <span class="hint">Before the date stays here; from it onward goes to a new cluster.</span>
        </div>

        <p class="eyebrow">Or pick transactions to move into a new cluster</p>
        <div class="picker">
          <label v-for="t in sorted" :key="t.id" class="pick">
            <input type="checkbox" :checked="selected.has(t.id)" @change="toggleSel(t.id)" />
            <span class="when">{{ fmtDateTime(t.at) }}</span>
            <span :class="['type', t.type.toLowerCase()]">{{ t.type }}</span>
            <span :class="['amt', t.type === 'Payment' ? 'good' : 'bad']">{{ t.type === 'Payment' ? '+' : '−' }}{{ fmt(Math.abs(t.amount)) }}</span>
          </label>
        </div>

        <template v-if="!c.isOnlineCluster">
          <p class="eyebrow">Online status</p>
          <div class="row">
            <button type="button" @click="apply(eng.markOnline(clusters, c.uid))">Mark as online</button>
            <span class="hint">
              <template v-if="monthOnline">Folds into <strong>{{ monthOnline.clusterID }}</strong> for this month.</template>
              <template v-else>Becomes this month's online cluster; later online marks merge in.</template>
            </span>
          </div>
        </template>
        <div v-else-if="c.manualOnline && !sources.includes('shopify')" class="row">
          <button type="button" @click="apply(eng.revertOnline(clusters, c.uid))"><Icon name="undo" :size="14" /> Revert to POS cluster</button>
        </div>

        <p class="eyebrow">Merge with another cluster</p>
        <div class="row">
          <select v-model="mergeWith">
            <option value="">— select cluster —</option>
            <option v-for="x in clusters.filter((y) => y.uid !== c.uid)" :key="x.uid" :value="x.uid">
              {{ x.clusterID }}{{ x.customName ? ' · ' + x.customName : '' }} ({{ x.device }})
            </option>
          </select>
          <button type="button" @click="doMerge(mergeWith)">Merge</button>
        </div>

        <div class="row actions">
          <button type="button" @click="doSplitSelected">Split selected into new cluster</button>
          <button type="button" class="danger" @click="doDelete">Delete cluster</button>
          <button type="button" class="quiet" @click="editing = false">Close editor</button>
        </div>
      </section>

      <div class="sections">
        <div class="box">
          <h4>{{ c.isOnlineCluster ? 'Online orders' : 'Payments' }}</h4>
          <div class="big good">{{ fmt(c.totalPay) }}</div>
          <small>{{ c.payments.length }} order{{ c.payments.length !== 1 ? 's' : '' }} · avg {{ c.payments.length ? fmt(c.totalPay / c.payments.length) : '–' }}</small>
        </div>
        <div class="box">
          <h4>Fees</h4>
          <div class="big bad">−{{ fmt(c.totalFee) }}</div>
          <small>{{ c.fees.length }} fee{{ c.fees.length !== 1 ? 's' : '' }} · {{ feeRate }}% of revenue</small>
        </div>
        <div v-if="c.cashAmount" class="box cash">
          <h4>Cash<span v-if="c.cashNote"> · {{ c.cashNote }}</span></h4>
          <div class="big">{{ fmt(c.cashAmount) }}</div>
          <small>total incl. cash {{ fmt(revenue) }}</small>
        </div>
      </div>

      <div class="row actions">
        <button type="button" @click="pdf('payments')">{{ c.clusterID }}_P.pdf</button>
        <button type="button" @click="pdf('fees')">{{ c.clusterID }}_F.pdf</button>
        <button type="button" class="quiet" @click="editing ? (editing = false) : startEdit()">{{ editing ? 'Close editor' : 'Edit cluster' }}</button>
      </div>

      <div class="acct">
        <div class="row">
          <template v-if="c.isOnlineCluster"><span class="hint">Online — books as monthly online sales.</span></template>
          <template v-else>
            <select :value="c.matchedEvent?.id ?? ''" aria-label="Match to an event" @change="match(($event.target as HTMLSelectElement).value)">
              <option value="">— match an event —</option>
              <option v-for="e in events" :key="e.id" :value="e.id">{{ e.name }} ({{ e.dateStart }})</option>
            </select>
            <button v-if="suggestion" type="button" @click="match(suggestion.id)">Match “{{ suggestion.name }}”?</button>
          </template>
        </div>
        <div class="row">
          <button type="button" :disabled="busy === 'verify'" @click="verify">{{ busy === 'verify' ? 'Checking…' : 'Verify vs myPOS' }}</button>
          <span v-if="c.verify && 'error' in c.verify" class="pill bad">verify failed: {{ c.verify.error }}</span>
          <span v-else-if="c.verify?.ok" class="pill good"><Icon name="check" :size="12" /> myPOS matches ({{ c.verify.mode }})</span>
          <span v-else-if="c.verify" class="pill warn">Δ {{ fmt(c.verify.diff) }} vs myPOS ({{ c.verify.mode }})</span>
          <button v-if="c.matchedEvent" type="button" :disabled="busy === 'cash'" @click="loadCash"><Icon name="coins" :size="14" /> Cash from sales</button>
          <span v-if="c.cashLoaded" class="pill good"><Icon name="banknote" :size="12" /> {{ fmt(c.cashAmount) }}</span>
          <template v-if="canBook">
            <a v-if="booked" class="pill good" :href="`https://app.lexware.de/permalink/vouchers/view/${booked.voucherId}`" target="_blank" rel="noopener"><Icon name="check" :size="12" /> Booked — view <Icon name="external-link" :size="12" /></a>
            <button v-else type="button" class="primary" @click="emit('book', c.uid)"><Icon name="send" :size="14" /> Book revenue to Lexware</button>
          </template>
        </div>
      </div>

      <button type="button" class="quiet toggle" @click="showTxns = !showTxns">{{ showTxns ? 'Hide transactions' : 'Show transactions' }} <Icon :name="showTxns ? 'chevron-up' : 'chevron-down'" :size="14" /></button>
      <div v-if="showTxns" class="table-scroll">
        <table>
          <thead><tr><th>Date/Time</th><th>Type</th><th class="num">Amount</th><th>Card / order</th><th></th></tr></thead>
          <tbody>
            <tr v-for="t in sorted" :key="t.id" :class="{ dim: t.isManual }">
              <td>{{ fmtDateTime(t.at) }}</td>
              <td>
                <span :class="['type', t.type.toLowerCase()]">{{ t.type }}</span>
                <span v-if="t.source !== 'mypos'" class="tag">{{ t.source }}</span>
                <span v-if="t.isManual" class="tag">manual</span>
                <span v-if="t.isOnline" class="tag">online</span>
              </td>
              <td :class="['num', t.type === 'Payment' ? 'good' : 'bad']">{{ t.type === 'Payment' ? '+' : '−' }}{{ fmt(Math.abs(t.amount)) }}</td>
              <td>{{ t.source === 'shopify' ? t.orderNum || t.ref : t.card || '–' }}</td>
              <td><button type="button" class="quiet x" :aria-label="`Remove transaction ${t.ref}`" @click="removeTxn(t.id)"><Icon name="x" :size="14" /></button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </article>
</template>

<style scoped>
.cluster { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); overflow: hidden; }
.cluster.booked { border-color: var(--zfy-accent, #0e7c66); }
.head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: .7rem .9rem; cursor: pointer; flex-wrap: wrap; }
.head:hover { background: var(--zfy-surface-2, #e9edf1); }
.title { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; min-width: 0; }
.cid { font-family: ui-monospace, monospace; font-size: .8rem; color: var(--zfy-muted, #5a6472); }
.range { font-weight: 600; }
.name { color: var(--zfy-accent-ink, #0a5a4a); font-weight: 600; }
.ready { display: inline-grid; place-items: center; width: 1.3rem; height: 1.3rem; border-radius: 999px; font-size: .75rem; font-weight: 700; color: var(--zfy-accent-ink, #0a5a4a); background: var(--zfy-accent-soft, #deeee9); }
.ready.booked { color: var(--zfy-on-accent, #fff); background: var(--zfy-accent, #0e7c66); }
.badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; border-radius: 6px; padding: .1rem .45rem; border: 1px solid var(--zfy-line, #d6dde4); color: var(--zfy-muted, #5a6472); }
.badge.online { color: #2f6fb8; border-color: rgba(47,111,184,.4); }
.badge.warn { color: var(--zfy-warning-ink, #8a5a1e); border-color: var(--zfy-warning, #c08a2e); }
.meta { display: flex; align-items: center; gap: 1.2rem; }
.stat { display: flex; flex-direction: column; align-items: flex-end; font-variant-numeric: tabular-nums; }
.stat small { font-size: .65rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.chev { color: var(--zfy-faint, #8a94a2); }
.good { color: var(--zfy-accent-ink, #0a5a4a); }
.bad { color: var(--zfy-danger, #c6512f); }
.body { border-top: 1px solid var(--zfy-line, #d6dde4); padding: .9rem; display: flex; flex-direction: column; gap: .8rem; }
.banner { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: .6rem .8rem; border-radius: 8px; border: 1px solid var(--zfy-accent, #0e7c66); background: var(--zfy-accent-soft, #deeee9); font-size: .875rem; }
.banner.warn { border-color: var(--zfy-warning, #c08a2e); background: var(--zfy-signal-soft, #f6e5df); }
.banner .sub { display: block; font-size: .78rem; color: var(--zfy-muted, #5a6472); }
.editor { border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 10px; padding: .8rem; display: flex; flex-direction: column; gap: .6rem; }
.row { display: flex; align-items: flex-end; gap: .5rem; flex-wrap: wrap; }
.row label { display: flex; flex-direction: column; gap: .2rem; font-size: .8rem; flex: 1; min-width: 10rem; }
.row label.short { flex: 0 0 10rem; }
.row.actions { align-items: center; }
.hint { color: var(--zfy-muted, #5a6472); font-size: .8rem; margin: 0; }
.eyebrow { margin: .3rem 0 0; font-size: .68rem; letter-spacing: .1em; text-transform: uppercase; color: var(--zfy-faint, #8a94a2); }
.picker { max-height: 12rem; overflow: auto; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; padding: .3rem .5rem; display: flex; flex-direction: column; }
.pick { display: flex; align-items: center; gap: .6rem; font-size: .8rem; padding: .2rem 0; }
.pick .when { color: var(--zfy-muted, #5a6472); min-width: 8rem; }
.pick .amt { margin-left: auto; font-variant-numeric: tabular-nums; }
.type { font-size: .68rem; text-transform: uppercase; letter-spacing: .05em; border-radius: 4px; padding: .05rem .35rem; background: var(--zfy-surface-2, #e9edf1); }
.type.fee { color: var(--zfy-danger, #c6512f); }
.tag { font-size: .65rem; margin-left: .3rem; color: var(--zfy-muted, #5a6472); border: 1px solid var(--zfy-line, #d6dde4); border-radius: 4px; padding: 0 .3rem; }
.sections { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .6rem; }
.box { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .7rem .8rem; display: flex; flex-direction: column; gap: .15rem; }
.box h4 { margin: 0; font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); font-weight: 600; }
.box .big { font-size: 1.25rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.box small { color: var(--zfy-muted, #5a6472); font-size: .75rem; }
.box.cash { border-color: rgba(120,80,200,.4); }
.acct { border-top: 1px solid var(--zfy-line, #d6dde4); padding-top: .8rem; display: flex; flex-direction: column; gap: .5rem; }
.pill { display: inline-flex; align-items: center; gap: .3rem; font-size: .78rem; padding: .25rem .6rem; border-radius: 999px; border: 1px solid var(--zfy-line, #d6dde4); text-decoration: none; }
.badge { display: inline-flex; align-items: center; gap: .25rem; }
button { display: inline-flex; align-items: center; justify-content: center; gap: .35rem; }
.pill.good { color: var(--zfy-accent-ink, #0a5a4a); background: var(--zfy-accent-soft, #deeee9); border-color: transparent; }
.pill.bad { color: var(--zfy-danger, #c6512f); }
.pill.warn { color: var(--zfy-warning-ink, #8a5a1e); }
.toggle { align-self: flex-start; font-size: .8rem; }
table { width: 100%; border-collapse: collapse; font-size: .82rem; }
th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); white-space: nowrap; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.dim { opacity: .55; }
.x { min-height: 1.8rem; padding: 0 .4rem; }
</style>
