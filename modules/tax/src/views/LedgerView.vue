<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type Expense, type InvoiceScan, type PnlRow } from '../api';
import { refreshStatus, status } from '../state';
import { sdk } from '../runtime';
import { Icon } from '@zollify/ui';

/**
 * Ledger: per-event profit and loss. Revenue comes from the till; costs -
 * booth fee, travel, hotel - are entered here, with the invoice attached now
 * or later. An invoice PDF can be scanned to prefill the form and pick the
 * event.
 */

const rows = ref<PnlRow[]>([]);
const categories = ref<{ id: string; label: string }[]>([]);
const expenses = ref<Expense[]>([]);
const current = ref<PnlRow | null>(null);
const error = ref<string | null>(null);
const busy = ref<string | null>(null);
const scan = ref<InvoiceScan | null>(null);
const scanFile = ref<{ base64: string; name: string } | null>(null);

const blank = () => ({ eventId: '', category: 'other', amount: 0, currency: 'EUR', date: new Date().toISOString().slice(0, 10), vendor: '', note: '' });
const form = ref(blank());
const editingId = ref<string | null>(null);

const fmt = (n: number, cur = 'EUR'): string => `${cur} ${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
// Overview totals only make sense in one currency; with a mix, the label
// says so rather than adding francs to euros silently.
const totals = computed(() => {
  const currencies = [...new Set(rows.value.map((r) => r.currency).filter(Boolean))];
  return {
    currency: currencies.length === 1 ? currencies[0]! : 'mixed',
    revenue: rows.value.reduce((s, r) => s + r.revenue, 0),
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
    rows.value = (await api.pnl()).rows;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the ledger.';
  }
}

async function openEvent(row: PnlRow): Promise<void> {
  current.value = row;
  form.value = { ...blank(), eventId: row.eventId, currency: row.currency || 'EUR' };
  editingId.value = null;
  scan.value = null;
  const res = await api.expenses(row.eventId);
  categories.value = res.categories;
  expenses.value = res.expenses;
}

async function back(): Promise<void> {
  current.value = null;
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
    const payload = { ...form.value, amount: Number(form.value.amount) || 0 };
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
  form.value = { eventId: e.eventId, category: e.category, amount: e.amount, currency: e.currency, date: e.date, vendor: e.vendor, note: e.note };
}

async function remove(e: Expense): Promise<void> {
  if (!(await sdk().ui.confirm(`Delete ${e.vendor || 'this expense'} (${fmt(e.amount, e.currency)})?`, 'Delete expense'))) return;
  await api.deleteExpense(e.id);
  expenses.value = expenses.value.filter((x) => x.id !== e.id);
}

async function readFile(file: File | undefined): Promise<{ base64: string; name: string } | null> {
  if (!file) return null;
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { base64: btoa(bin), name: file.name };
}

async function attach(e: Expense, file: File | undefined): Promise<void> {
  const f = await readFile(file);
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
  const f = await readFile(file);
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
        <h1>{{ current ? current.name : 'Ledger' }}</h1>
        <p class="lede">
          <template v-if="current">{{ current.country }}{{ current.start ? ` · ${current.start}` : '' }} - revenue from the till against the costs of doing the event.</template>
          <template v-else>Per-event profit and loss. Revenue is live from your sales; add booth, travel and hotel costs and attach the invoices.</template>
        </p>
      </div>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!-- ── P&L overview ───────────────────────────────────────────────────── -->
    <template v-if="!current">
      <ul class="totals">
        <li><span class="label">Revenue</span><strong class="good">{{ fmt(totals.revenue, totals.currency) }}</strong></li>
        <li><span class="label">Expenses</span><strong class="bad">−{{ fmt(totals.expenses, totals.currency) }}</strong></li>
        <li><span class="label">Margin</span><strong :class="totals.margin >= 0 ? 'good' : 'bad'">{{ fmt(totals.margin, totals.currency) }}</strong></li>
      </ul>
      <p v-if="!rows.length" class="empty">No events yet.</p>
      <div v-else class="table-scroll">
        <table>
          <thead>
            <tr><th>Event</th><th>When</th><th class="num">Revenue</th><th class="num">Expenses</th><th class="num">Margin</th><th>Costs</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.eventId" class="row" role="button" tabindex="0" @click="openEvent(r)" @keydown.enter="openEvent(r)" @keydown.space.prevent="openEvent(r)">
              <td><strong>{{ r.name }}</strong><span v-if="r.country" class="sub"> · {{ r.country }}</span></td>
              <td class="mono">{{ r.start || '-' }}</td>
              <td class="num good">{{ fmt(r.revenue, r.currency) }}</td>
              <td class="num bad">{{ r.expenses ? '−' + fmt(r.expenses, r.currency) : '-' }}</td>
              <td :class="['num', r.margin >= 0 ? 'good' : 'bad']">{{ fmt(r.margin, r.currency) }}</td>
              <td class="sub">{{ r.expenseCount }} item{{ r.expenseCount === 1 ? '' : 's' }}{{ r.unbooked ? ` · ${r.unbooked} unbooked` : '' }}{{ r.currencies.length > 1 ? ' · mixed currencies' : '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ── One event ──────────────────────────────────────────────────────── -->
    <template v-else>
      <ul class="totals">
        <li><span class="label">Revenue</span><strong class="good">{{ fmt(current.revenue, current.currency) }}</strong></li>
        <li><span class="label">Expenses</span><strong class="bad">{{ expensesMixed ? 'mixed currencies' : '−' + fmt(expenseTotal, current.currency) }}</strong></li>
        <li><span class="label">Margin</span><strong :class="expensesMixed ? '' : (current.revenue - expenseTotal >= 0 ? 'good' : 'bad')">{{ expensesMixed ? '—' : fmt(current.revenue - expenseTotal, current.currency) }}</strong></li>
      </ul>

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
              <td>{{ e.vendor || '-' }}<span v-if="e.note" class="sub"> · {{ e.note }}</span></td>
              <td>{{ categories.find((c) => c.id === e.category)?.label ?? e.category }}</td>
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
.scan, .attach { display: inline-flex; align-items: center; gap: .35rem; min-height: 2.5rem; padding: .45rem .95rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; cursor: pointer; font-size: .875rem; }
.attach { min-height: 2.2rem; padding: .2rem .6rem; font-size: .8rem; }
.scan input, .attach input { display: none; }
.link { color: var(--zfy-accent-ink, #0a5a4a); min-height: 2.2rem; padding: .2rem .5rem; text-decoration: underline; }
</style>
