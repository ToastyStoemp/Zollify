<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { checkPickedFile } from '@zollify/shared';
import { api, type Expense, type InvoiceScan, type PaidFrom, type PnlRow } from '../api';
import { refreshStatus, status } from '../state';
import { sdk } from '../runtime';
import { Icon } from '@zollify/ui';
import { localIsoDay } from '@zollify/shared';
import { vatByEvent } from '../ledger-vat';
import ComputedCostForm from './ComputedCostForm.vue';
import SharedCostForm from './SharedCostForm.vue';
import RatesForm from './RatesForm.vue';
import AccountantExport from './AccountantExport.vue';

/**
 * Ledger: per-event profit and loss. Revenue comes from the till; costs -
 * booth fee, travel, hotel - are entered here, with the invoice attached now
 * or later. An invoice PDF can be scanned to prefill the form and pick the
 * event.
 */

const serverRows = ref<PnlRow[]>([]);
/**
 * Revenue without the VAT the till collected: VAT is the tax office's money,
 * so a Copenhagen event at 25% must not look more profitable than it was.
 * The server sends what customers paid; the VAT comes off here from the
 * sales core holds, so rows carry `vat` and a net revenue and margin.
 */
const rows = computed<(PnlRow & { vat: number })[]>(() => {
  const vat = vatByEvent(sdk().data.transactions.recent());
  return serverRows.value.map((r) => {
    const v = vat[r.eventId] ?? 0;
    const revenue = Math.round((r.revenue - v) * 100) / 100;
    return { ...r, vat: v, revenue, margin: Math.round((revenue - r.expenses) * 100) / 100 };
  });
});
/** Only a configured Lexware connection makes "not yet in Lexware" mean anything; without it the count is noise. */
const lexware = computed(() => Boolean(status.value?.lexware.configured));
const categories = ref<{ id: string; label: string }[]>([]);
const expenses = ref<Expense[]>([]);
const current = ref<(PnlRow & { vat: number }) | null>(null);
const error = ref<string | null>(null);
const busy = ref<string | null>(null);
const scan = ref<InvoiceScan | null>(null);
const scanFile = ref<{ base64: string; name: string } | null>(null);

/** How it was paid: '' until someone says - such an expense is not taken off what cash up expects. */
const blank = () => ({ eventId: '', category: 'other', amount: 0, currency: 'EUR', date: localIsoDay(), vendor: '', note: '', paidFrom: '' as PaidFrom | '' });
/** Which helper is open: per diems or mileage on an event, a shared cost or the rates on the overview. */
const helper = ref<'perdiem' | 'mileage' | 'shared' | 'rates' | 'export' | null>(null);
/** The event's dates and country for the per diem helper: a day either side of the event for travel. */
const tripOf = computed(() => {
  const e = current.value ? sdk().data.events.get(current.value.eventId) : undefined;
  const shift = (day: string | undefined, by: number): string => {
    if (!day) return '';
    const d = new Date(`${day}T12:00:00`);
    d.setDate(d.getDate() + by);
    return localIsoDay(d);
  };
  return { country: e?.venue?.country ?? current.value?.country ?? '', start: shift(e?.dateStart, -1), end: shift(e?.dateEnd ?? e?.dateStart, 1) };
});
function computedSaved(e: Expense): void {
  expenses.value = [e, ...expenses.value];
  helper.value = null;
}
async function sharedSaved(): Promise<void> {
  helper.value = null;
  await loadPnl();
}
/** Categories for the shared-cost form before any event was opened. */
async function openShared(): Promise<void> {
  if (!categories.value.length) categories.value = (await api.expenses()).categories;
  helper.value = 'shared';
}
const form = ref(blank());
const editingId = ref<string | null>(null);

const fmt = (n: number, cur = 'EUR'): string => `${cur} ${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
// Overview totals only make sense in one currency; with a mix, the label
// says so rather than adding francs to euros silently.
/** An expense in another currency than the event's: the row's expenses and margin cannot be one sum (same rule as the event's own page). */
const rowMixed = (r: { currency: string; currencies: string[] }): boolean => r.currencies.some((c) => c && c !== (r.currency || 'EUR'));
const totals = computed(() => {
  const currencies = [...new Set(rows.value.map((r) => r.currency).filter(Boolean))];
  return {
    currency: currencies.length === 1 ? currencies[0]! : 'mixed',
    expensesMixed: rows.value.some(rowMixed),
    revenue: rows.value.reduce((s, r) => s + r.revenue, 0),
    vat: rows.value.reduce((s, r) => s + r.vat, 0),
    expenses: rows.value.reduce((s, r) => s + r.expenses, 0),
    margin: rows.value.reduce((s, r) => s + r.margin, 0),
  };
});
const canScan = computed(() => Boolean(status.value?.ai.configured));
// Expenses can each carry their own currency (the form allows it); only sum
// and show a total when they all agree with the event's currency, same as
// the overview - otherwise adding e.g. USD to EUR would silently mislead.
const expenseTotal = computed(() => expenses.value.reduce((s, e) => s + e.amount, 0));
const expensesMixed = computed(() => expenses.value.some((e) => e.currency && e.currency !== (current.value?.currency || 'EUR')));

async function loadPnl(): Promise<void> {
  error.value = null;
  try {
    serverRows.value = (await api.pnl()).rows;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the ledger.';
  }
}

async function openEvent(row: PnlRow & { vat: number }): Promise<void> {
  current.value = row;
  helper.value = null;
  form.value = { ...blank(), eventId: row.eventId, currency: row.currency || 'EUR' };
  editingId.value = null;
  scan.value = null;
  const res = await api.expenses(row.eventId);
  categories.value = res.categories;
  expenses.value = res.expenses;
}

async function back(): Promise<void> {
  current.value = null;
  helper.value = null;
  await loadPnl();
}

onMounted(async () => {
  if (!status.value) await refreshStatus().catch(() => {});
  await loadPnl();
});

async function save(): Promise<void> {
  error.value = null;
  busy.value = 'save';
  try {
    const payload = { ...form.value, amount: Number(form.value.amount) || 0, paidFrom: (form.value.paidFrom || null) as PaidFrom | null };
    let saved: Expense;
    if (editingId.value) saved = (await api.updateExpense(editingId.value, payload)).expense;
    else saved = (await api.addExpense(payload)).expense;
    if (scanFile.value && !editingId.value) {
      saved = (await api.attachInvoice(saved.id, scanFile.value.base64, scanFile.value.name)).expense;
    }
    expenses.value = editingId.value ? expenses.value.map((e) => (e.id === saved.id ? saved : e)) : [saved, ...expenses.value];
    form.value = { ...blank(), eventId: current.value!.eventId, currency: current.value!.currency || 'EUR' };
    editingId.value = null;
    scan.value = null;
    scanFile.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the expense.';
  } finally {
    busy.value = null;
  }
}

function edit(e: Expense): void {
  editingId.value = e.id;
  form.value = { eventId: e.eventId, category: e.category, amount: e.amount, currency: e.currency, date: e.date, vendor: e.vendor, note: e.note, paidFrom: e.paidFrom ?? '' };
}

/** Who added it, when that was someone else than you - a helper's quick expense at the event, say. */
const addedBy = (e: Expense): string | null => (e.createdBy && e.createdBy.userId !== sdk().account()?.userId ? (e.createdBy.email ?? 'a removed user').split('@')[0]! : null);

async function remove(e: Expense): Promise<void> {
  if (!(await sdk().ui.confirm(`Delete ${e.vendor || 'this expense'} (${fmt(e.amount, e.currency)})?`, 'Delete expense'))) return;
  await api.deleteExpense(e.id);
  expenses.value = expenses.value.filter((x) => x.id !== e.id);
}

async function readFile(file: File | undefined, purpose: 'invoice' | 'invoiceScan'): Promise<{ base64: string; name: string } | null> {
  if (!file) return null;
  // The same check the server makes, so a wrong or oversized file is refused before it is read.
  const problem = await checkPickedFile(purpose, file);
  if (problem) {
    error.value = problem;
    return null;
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { base64: btoa(bin), name: file.name };
}

async function attach(e: Expense, file: File | undefined): Promise<void> {
  const f = await readFile(file, 'invoice');
  if (!f) return;
  try {
    const saved = (await api.attachInvoice(e.id, f.base64, f.name)).expense;
    expenses.value = expenses.value.map((x) => (x.id === saved.id ? saved : x));
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not attach the invoice.';
  }
}

/** Reads the PDF with Claude and fills the form; the file is kept to attach on save. */
async function scanInvoice(file: File | undefined): Promise<void> {
  const f = await readFile(file, 'invoiceScan');
  if (!f) return;
  scanFile.value = f;
  busy.value = 'scan';
  error.value = null;
  try {
    const r = await api.scanInvoice(f.base64);
    scan.value = r;
    form.value = {
      ...form.value,
      vendor: r.fields.vendor || form.value.vendor,
      category: r.fields.category,
      amount: r.fields.amount || form.value.amount,
      currency: r.fields.currency || form.value.currency,
      date: r.fields.date || form.value.date,
      note: r.fields.stayStart ? `Stay ${r.fields.stayStart} → ${r.fields.stayEnd || r.fields.stayStart}` : form.value.note,
    };
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'The scan failed.';
  } finally {
    busy.value = null;
  }
}

async function openInvoice(e: Expense): Promise<void> {
  try {
    const { base64, filename } = await api.invoice(e.id);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    await sdk().ui.saveFile(filename, new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }), 'application/pdf');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not open the invoice.';
  }
}
</script>

<template>
  <section class="ledger">
    <header class="top">
      <div>
        <button v-if="current" type="button" class="quiet back" @click="back"><Icon name="arrow-left" :size="14" /> All events</button>
        <h1>{{ current ? current.name : 'Event profit' }}</h1>
        <p class="lede">
          <template v-if="current">{{ current.country }}{{ current.start ? ` · ${current.start}` : '' }} - revenue from the till against the costs of doing the event.</template>
          <template v-else>Per-event profit and loss. Revenue is live from your sales; add booth, travel and hotel costs and attach the invoices.</template>
        </p>
      </div>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!-- ── P&L overview ───────────────────────────────────────────────────── -->
    <template v-if="!current">
      <div class="helpers">
        <button type="button" :class="{ on: helper === 'shared' }" @click="helper === 'shared' ? (helper = null) : openShared()">A cost over several events</button>
        <button type="button" :class="{ on: helper === 'rates' }" @click="helper = helper === 'rates' ? null : 'rates'">Rates</button>
        <button type="button" :class="{ on: helper === 'export' }" @click="helper = helper === 'export' ? null : 'export'">For the accountant</button>
      </div>
      <SharedCostForm v-if="helper === 'shared'" :categories="categories" :currency="totals.currency === 'mixed' ? 'EUR' : totals.currency" @saved="sharedSaved" @close="helper = null" />
      <RatesForm v-if="helper === 'rates'" @close="helper = null" />
      <AccountantExport v-if="helper === 'export'" @close="helper = null" />
      <ul class="totals">
        <li><span class="label">Revenue <small>excl. VAT</small></span><strong class="good">{{ fmt(totals.revenue, totals.currency) }}</strong></li>
        <li><span class="label">Expenses</span><strong class="bad">{{ totals.expensesMixed ? 'mixed currencies' : '−' + fmt(totals.expenses, totals.currency) }}</strong></li>
        <li><span class="label">Margin</span><strong :class="totals.margin >= 0 ? 'good' : 'bad'">{{ totals.expensesMixed ? '-' : fmt(totals.margin, totals.currency) }}</strong></li>
      </ul>
      <p v-if="totals.vat" class="hint">Revenue is what customers paid without the VAT charged ({{ fmt(totals.vat, totals.currency) }} in all), since that goes to the tax office. Exempt sales count in full.</p>
      <p v-if="!rows.length" class="empty">No events yet.</p>
      <div v-else class="table-scroll stack">
        <table>
          <thead>
            <tr><th>Event</th><th>When</th><th class="num">Revenue <small>excl. VAT</small></th><th class="num">Expenses</th><th class="num">Margin</th><th>Items</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.eventId" class="row" role="button" tabindex="0" @click="openEvent(r)" @keydown.enter="openEvent(r)" @keydown.space.prevent="openEvent(r)">
              <td class="wide"><strong>{{ r.name }}</strong><span v-if="r.country" class="sub"> · {{ r.country }}</span></td>
              <td class="mono end">{{ r.start || '-' }}</td>
              <td class="num good" data-label="Revenue excl. VAT">{{ fmt(r.revenue, r.currency) }}</td>
              <td class="num bad" data-label="Expenses">{{ rowMixed(r) ? 'mixed currencies' : r.expenses ? '−' + fmt(r.expenses, r.currency) : '-' }}</td>
              <td :class="['num', r.margin >= 0 ? 'good' : 'bad']" data-label="Margin">{{ rowMixed(r) ? '-' : fmt(r.margin, r.currency) }}</td>
              <td class="sub span">{{ r.expenseCount }} expense{{ r.expenseCount === 1 ? '' : 's' }}{{ lexware && r.unbooked ? ` · ${r.unbooked} not yet in Lexware` : '' }}{{ rowMixed(r) ? ' · mixed currencies' : '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ── One event ──────────────────────────────────────────────────────── -->
    <template v-else>
      <ul class="totals">
        <li><span class="label">Revenue <small>excl. VAT</small></span><strong class="good">{{ fmt(current.revenue, current.currency) }}</strong></li>
        <li><span class="label">Expenses</span><strong class="bad">{{ expensesMixed ? 'mixed currencies' : '−' + fmt(expenseTotal, current.currency) }}</strong></li>
        <li><span class="label">Margin</span><strong :class="expensesMixed ? '' : (current.revenue - expenseTotal >= 0 ? 'good' : 'bad')">{{ expensesMixed ? '—' : fmt(current.revenue - expenseTotal, current.currency) }}</strong></li>
      </ul>
      <p v-if="current.vat" class="hint">{{ fmt(current.vat, current.currency) }} VAT was charged on top and goes to the tax office, so it is not counted as revenue.</p>

      <div class="helpers">
        <button type="button" :class="{ on: helper === 'perdiem' }" @click="helper = helper === 'perdiem' ? null : 'perdiem'">Per diems from the dates</button>
        <button type="button" :class="{ on: helper === 'mileage' }" @click="helper = helper === 'mileage' ? null : 'mileage'">Mileage</button>
      </div>
      <ComputedCostForm
        v-if="helper === 'perdiem' || helper === 'mileage'"
        :key="helper"
        :kind="helper"
        :event-id="current.eventId"
        :currency="current.currency || 'EUR'"
        :country="tripOf.country"
        :start="tripOf.start"
        :end="tripOf.end"
        @saved="computedSaved"
        @close="helper = null"
      />

      <form class="card" @submit.prevent="save">
        <div class="formhead">
          <h2>{{ editingId ? 'Edit expense' : 'Add an expense' }}</h2>
          <label v-if="canScan && !editingId" class="scan">
            <input type="file" accept="application/pdf" @change="scanInvoice(($event.target as HTMLInputElement).files?.[0])" />
            <Icon name="scan" :size="14" /><span>{{ busy === 'scan' ? 'Reading…' : 'Scan an invoice PDF' }}</span>
          </label>
        </div>
        <p v-if="scan" class="hint">
          Read with {{ Math.round(scan.fields.confidence * 100) }}% confidence{{ scan.match ? ` · matches ${scan.match.name}` : '' }} · {{ scan.remainingToday }} scans left today. The PDF is attached on save.
        </p>
        <div class="grid">
          <label><span>Vendor</span><input v-model="form.vendor" type="text" placeholder="Hotel Ibis" /></label>
          <label>
            <span>Category</span>
            <select v-model="form.category">
              <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.label }}</option>
            </select>
          </label>
          <label><span>Amount</span><input v-model.number="form.amount" type="number" min="0" step="0.01" inputmode="decimal" required /></label>
          <label><span>Currency</span><input v-model="form.currency" type="text" maxlength="3" /></label>
          <label><span>Date</span><input v-model="form.date" type="date" /></label>
          <label>
            <span>Paid with</span>
            <select v-model="form.paidFrom">
              <option value="">Not said</option>
              <option value="card">Card</option>
              <option value="cash">Cash from the till</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label class="wide"><span>Note</span><input v-model="form.note" type="text" /></label>
        </div>
        <div class="actions">
          <button type="submit" class="primary" :disabled="busy === 'save'">{{ editingId ? 'Save changes' : 'Add expense' }}</button>
          <button v-if="editingId" type="button" class="quiet" @click="editingId = null; form = { ...blank(), eventId: current!.eventId, currency: current!.currency }">Cancel</button>
        </div>
      </form>

      <p v-if="!expenses.length" class="empty">No costs recorded for this event yet.</p>
      <div v-else class="table-scroll">
        <table>
          <thead><tr><th>Date</th><th>Vendor</th><th>Category</th><th class="num">Amount</th><th>Invoice</th><th></th></tr></thead>
          <tbody>
            <tr v-for="e in expenses" :key="e.id">
              <td class="mono">{{ e.date || '-' }}</td>
              <td>{{ e.vendor || '-' }}<span v-if="e.note" class="sub"> · {{ e.note }}</span><span v-if="addedBy(e)" class="sub by"> · added by {{ addedBy(e) }}</span></td>
              <td>{{ categories.find((c) => c.id === e.category)?.label ?? e.category }}<span v-if="e.detail" class="sub"> · worked out</span><span v-if="e.paidFrom === 'cash'" class="sub"> · paid in cash</span></td>
              <td class="num">{{ fmt(e.amount, e.currency) }}</td>
              <td>
                <button v-if="e.invoice" type="button" class="quiet link" @click="openInvoice(e)">{{ e.invoice.filename }}</button>
                <label v-else class="attach"><input type="file" accept="application/pdf" @change="attach(e, ($event.target as HTMLInputElement).files?.[0])" /><span>Attach PDF</span></label>
              </td>
              <td class="rowactions">
                <button type="button" class="quiet" @click="edit(e)">Edit</button>
                <button type="button" class="danger" @click="remove(e)">Delete</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ledger { display: flex; flex-direction: column; gap: 1rem; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: 1.05rem; }
.back { display: inline-flex; align-items: center; gap: .3rem; margin-bottom: .3rem; padding-left: .3rem; }
.lede, .hint, .empty { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .9rem; max-width: 64ch; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.totals { list-style: none; margin: 0; padding: 0; display: flex; gap: .6rem; flex-wrap: wrap; }
.totals li { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .5rem .8rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; min-width: 9rem; }
.totals .label { font-size: .7rem; letter-spacing: .06em; text-transform: uppercase; color: var(--zfy-muted, #5a6472); }
.totals .label small, th small { font-size: .65rem; text-transform: none; letter-spacing: 0; font-weight: 400; }
.totals strong { font-size: 1.1rem; font-variant-numeric: tabular-nums; }
.good { color: var(--zfy-accent-ink, #0a5a4a); }
.bad { color: var(--zfy-danger, #c6512f); }
table { width: 100%; border-collapse: collapse; background: var(--zfy-surface, #fff); border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: .55rem .75rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); font-size: .9rem; white-space: nowrap; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); }
tbody tr:last-child td { border-bottom: 0; }
tr.row { cursor: pointer; }
tr.row:hover { background: var(--zfy-surface-2, #e9edf1); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.mono { font-variant-numeric: tabular-nums; color: var(--zfy-muted, #5a6472); }
.sub { color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .75rem; }
.formhead { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .6rem; }
.grid label { display: flex; flex-direction: column; gap: .2rem; font-size: .8rem; }
.grid .wide { grid-column: 1 / -1; }
.actions, .rowactions { display: flex; gap: .4rem; }
.helpers { display: flex; gap: .4rem; flex-wrap: wrap; }
.helpers .on { background: var(--zfy-accent, #0e7c66); color: #fff; }
.scan, .attach { display: inline-flex; align-items: center; gap: .35rem; min-height: 2.5rem; padding: .45rem .95rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; cursor: pointer; font-size: .875rem; }
.attach { min-height: 2.2rem; padding: .2rem .6rem; font-size: .8rem; }
.scan input, .attach input { display: none; }
.link { color: var(--zfy-accent-ink, #0a5a4a); min-height: 2.2rem; padding: .2rem .5rem; text-decoration: underline; }
</style>
