<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { ConsignmentLine, ConsignorStatement } from '@zollify/shared';
import { fmtPrice } from '@zollify/shared';
import { Icon, ModalShell } from '@zollify/ui';
import { addPayout, deletePayout, errorText, loadStatement, today, type Statement } from '../api';
import { sdk } from '../runtime';

/**
 * What each artist sold, per store, and what is still owed. The balance runs
 * across all stores - one owner pays a shared artist once - and payouts are
 * recorded here; the money itself moves however you pay artists.
 */
const emit = defineEmits<{ error: [message: string | null] }>();

const data = ref<Statement | null>(null);
const showArchived = ref(false);
async function refresh(): Promise<void> {
  emit('error', null);
  try {
    data.value = await loadStatement();
  } catch (err) {
    emit('error', errorText(err, 'Could not load the statement.'));
  }
}
onMounted(refresh);

const venueName = (id: string): string => data.value?.venues.find((v) => v.id === id)?.name ?? 'Removed event';
const consignorName = (id: string): string => data.value?.consignors.find((c) => c.id === id)?.name ?? 'Removed artist';
const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString();

const cards = computed(() => {
  if (!data.value) return [];
  const byId = new Map(data.value.statements.map((s) => [s.consignorId, s]));
  return data.value.consignors
    .filter((c) => showArchived.value || !c.archived)
    .map((c) => ({ consignor: c, statement: byId.get(c.id) ?? ({ consignorId: c.id, byStore: [], totals: [] } as ConsignorStatement) }))
    .sort((a, b) => a.consignor.name.localeCompare(b.consignor.name));
});
const payoutsOf = (id: string) => data.value?.payouts.filter((p) => p.consignorId === id) ?? [];
const linesOf = (id: string): ConsignmentLine[] => data.value?.lines.filter((l) => l.consignorId === id) ?? [];
const open = ref<Record<string, boolean>>({});

// ── Payouts ─────────────────────────────────────────────────────────────────
const paying = ref<string | null>(null);
const payError = ref<string | null>(null);
const pay = reactive({ amount: '', currency: 'CHF', storeId: '', date: today(), note: '' });
function openPay(consignorId: string): void {
  const st = data.value?.statements.find((s) => s.consignorId === consignorId);
  const owed = st?.totals.find((t) => t.balance > 0);
  Object.assign(pay, {
    amount: owed ? owed.balance.toFixed(2) : '',
    currency: owed?.currency ?? sdk().account()?.profile.defaultCurrency ?? 'CHF',
    storeId: '',
    date: today(),
    note: '',
  });
  payError.value = null;
  paying.value = consignorId;
}
async function savePayout(): Promise<void> {
  const amount = parseFloat(pay.amount);
  if (!(amount > 0)) return void (payError.value = 'Enter the amount paid.');
  try {
    await addPayout({ consignorId: paying.value!, amount, currency: pay.currency, storeId: pay.storeId || null, date: pay.date, note: pay.note.trim() });
    paying.value = null;
    await refresh();
  } catch (err) {
    payError.value = errorText(err, 'Could not record the payout.');
  }
}
async function removePayout(id: string): Promise<void> {
  if (!(await sdk().ui.confirm('The payout is removed from the statement and the balance goes back up.', 'Delete payout?'))) return;
  try {
    await deletePayout(id);
    await refresh();
  } catch (err) {
    emit('error', errorText(err, 'Could not delete the payout.'));
  }
}

// ── Export ──────────────────────────────────────────────────────────────────
const csvCell = (v: unknown): string => {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
async function exportCsv(): Promise<void> {
  if (!data.value) return;
  const head = ['Date', 'Artist', 'Sold at', 'Item', 'Qty', 'Currency', 'Gross', 'Commission %', 'Commission', 'Artist share'];
  const rows = data.value.lines.map((l) => [
    new Date(l.at).toISOString().slice(0, 10),
    consignorName(l.consignorId),
    venueName(l.storeId),
    l.variantLabel ? `${l.title} · ${l.variantLabel}` : l.title,
    l.qty,
    l.currency,
    l.gross.toFixed(2),
    l.commissionPct,
    l.commission.toFixed(2),
    l.artistShare.toFixed(2),
  ]);
  const csv = [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  await sdk().ui.saveFile(`consignment-${today()}.csv`, csv, 'text/csv');
}
</script>

<template>
  <div class="tab">
    <div class="bar">
      <p class="hint">Commission is taken from what the customer paid for each item, discounts included. Reverted sales are left out.</p>
      <label class="check"><input v-model="showArchived" type="checkbox" /> Show archived</label>
      <button type="button" @click="refresh"><Icon name="refresh-cw" :size="14" /> Refresh</button>
      <button type="button" :disabled="!data?.lines.length" @click="exportCsv"><Icon name="download" :size="14" /> Export sales</button>
    </div>

    <p v-if="!data" class="hint">Loading…</p>
    <p v-else-if="!cards.length" class="empty">No artists yet.</p>

    <article v-for="{ consignor: c, statement: s } in cards" :key="c.id" class="card">
      <header>
        <strong>{{ c.name }}</strong>
        <span class="grow" />
        <button type="button" class="primary" @click="openPay(c.id)"><Icon name="banknote" :size="14" /> Record payout</button>
      </header>

      <p v-if="!s.totals.length" class="hint">Nothing sold or paid yet.</p>
      <div v-for="t in s.totals" :key="t.currency" class="totals">
        <div><span>Sold</span><strong>{{ t.units }}</strong></div>
        <div><span>Sales</span><strong>{{ fmtPrice(t.gross, t.currency) }}</strong></div>
        <div><span>Commission</span><strong>{{ fmtPrice(t.commission, t.currency) }}</strong></div>
        <div><span>Artist's share</span><strong>{{ fmtPrice(t.artistShare, t.currency) }}</strong></div>
        <div><span>Paid</span><strong>{{ fmtPrice(t.paid, t.currency) }}</strong></div>
        <div :class="['owed', { due: t.balance > 0 }]"><span>{{ t.balance >= 0 ? 'Owed' : 'Paid ahead' }}</span><strong>{{ fmtPrice(Math.abs(t.balance), t.currency) }}</strong></div>
      </div>

      <table v-if="s.byStore.length">
        <thead><tr><th>Sold at</th><th class="num">Units</th><th class="num">Sales</th><th class="num">Commission</th><th class="num">Artist's share</th></tr></thead>
        <tbody>
          <tr v-for="r in s.byStore" :key="`${r.storeId}|${r.currency}`">
            <td>{{ venueName(r.storeId) }}</td>
            <td class="num">{{ r.units }}</td>
            <td class="num">{{ fmtPrice(r.gross, r.currency) }}</td>
            <td class="num">{{ fmtPrice(r.commission, r.currency) }}</td>
            <td class="num">{{ fmtPrice(r.artistShare, r.currency) }}</td>
          </tr>
        </tbody>
      </table>

      <details v-if="payoutsOf(c.id).length">
        <summary>Payouts ({{ payoutsOf(c.id).length }})</summary>
        <ul class="payouts">
          <li v-for="p in payoutsOf(c.id)" :key="p.id">
            <span>{{ p.date }}</span>
            <strong>{{ fmtPrice(p.amount, p.currency) }}</strong>
            <span class="hint">{{ p.storeId ? venueName(p.storeId) : 'All stores' }}<template v-if="p.note"> · {{ p.note }}</template></span>
            <button type="button" class="quiet" :aria-label="`Delete payout of ${p.date}`" @click="removePayout(p.id)"><Icon name="x" :size="14" /></button>
          </li>
        </ul>
      </details>

      <details v-if="linesOf(c.id).length" :open="open[c.id]" @toggle="open[c.id] = ($event.target as HTMLDetailsElement).open">
        <summary>Sales ({{ linesOf(c.id).length }})</summary>
        <table v-if="open[c.id]">
          <tbody>
            <tr v-for="l in linesOf(c.id)" :key="`${l.txId}:${l.productId}:${l.variantId}`">
              <td>{{ fmtDate(l.at) }}</td>
              <td>{{ l.title }}<template v-if="l.variantLabel"> · {{ l.variantLabel }}</template><template v-if="l.qty > 1"> × {{ l.qty }}</template></td>
              <td class="hint">{{ venueName(l.storeId) }}</td>
              <td class="num">{{ fmtPrice(l.gross, l.currency) }}</td>
              <td class="num">{{ fmtPrice(l.artistShare, l.currency) }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </article>

    <ModalShell v-if="paying" :title="`Payout to ${consignorName(paying)}`" @close="paying = null">
      <div class="form">
        <p v-if="payError" class="error" role="alert">{{ payError }}</p>
        <div class="two">
          <label><span>Amount</span><input v-model="pay.amount" type="number" min="0" step="0.01" inputmode="decimal" /></label>
          <label><span>Currency</span><input v-model="pay.currency" type="text" maxlength="3" /></label>
        </div>
        <label><span>Date</span><input v-model="pay.date" type="date" /></label>
        <label>
          <span>For store</span>
          <select v-model="pay.storeId">
            <option value="">All stores</option>
            <option v-for="v in data?.venues.filter((v) => v.kind === 'store') ?? []" :key="v.id" :value="v.id">{{ v.name }}</option>
          </select>
        </label>
        <label><span>Note</span><input v-model="pay.note" type="text" placeholder="Bank transfer, cash…" /></label>
      </div>
      <template #footer>
        <div class="footer">
          <button type="button" @click="paying = null">Cancel</button>
          <button type="button" class="primary" @click="savePayout">Record</button>
        </div>
      </template>
    </ModalShell>
  </div>
</template>

<style scoped>
.tab { display: flex; flex-direction: column; gap: .8rem; }
.bar { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.bar .hint { flex: 1 1 20rem; }
.bar button, header button { min-height: 2.2rem; display: inline-flex; align-items: center; gap: .35rem; font-size: .8rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .82rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
label.check { display: flex; align-items: center; gap: .4rem; font-size: .85rem; }
.card { display: flex; flex-direction: column; gap: .6rem; padding: .9rem 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
.card header { display: flex; align-items: center; gap: .6rem; }
.grow { flex: 1; }
.totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr)); gap: .5rem; }
.totals div { display: flex; flex-direction: column; gap: .1rem; padding: .45rem .6rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); }
.totals span { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.totals strong { font-variant-numeric: tabular-nums; }
.totals .owed.due { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
table { width: 100%; border-collapse: collapse; font-size: .84rem; }
th, td { padding: .35rem .5rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); text-align: left; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); font-weight: 600; }
tbody tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
summary { cursor: pointer; font-size: .85rem; font-weight: 600; }
.payouts { list-style: none; margin: .4rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; }
.payouts li { display: flex; align-items: center; gap: .6rem; font-size: .85rem; flex-wrap: wrap; }
.payouts .hint { flex: 1; }
.form { display: flex; flex-direction: column; gap: .7rem; }
.form label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.two { display: grid; grid-template-columns: 2fr 1fr; gap: .6rem; }
.footer { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
