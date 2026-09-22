<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Transaction, TxDiscount, TxItem } from '@zollify/shared';
import { fmtPrice, round2 } from '@zollify/shared';
import { Icon, ModalShell, typeColor } from '@zollify/ui';
import {
  activeEventId,
  allProducts,
  csvFilename,
  currentAccount,
  getSalesEvent,
  recentTransactions,
  revertTransaction,
  transactionsToCsv,
  visibleEvents,
  saveFile,
} from '@zollify/platform';

/**
 * Sales history - ZollTool's, screen for screen: one event or all, stat
 * tiles, a comparison with another edition, best sellers, revenue per day
 * and per hour, then the sales themselves.
 *
 * Revenue figures are always in the base currency, because two events may
 * charge in different local currencies and base is the only comparable
 * basis. What was physically collected (cash, card) stays in the currency
 * it was collected in.
 */

const account = currentAccount;
const route = useRoute();
const router = useRouter();
const canRevert = computed(() => account.value?.role === 'owner' || account.value?.role === 'admin');
const hasRoute = (name: string): boolean => router.hasRoute(name);
const error = ref<string | null>(null);

// ── Scope ───────────────────────────────────────────────────────────────────
const scope = ref<string>(typeof route.query.event === 'string' ? route.query.event : (activeEventId.value ?? 'all'));
watch(scope, (v) => void router.replace({ query: v === 'all' ? {} : { event: v } }));
const scopeEvent = computed(() => (scope.value === 'all' ? null : (getSalesEvent(scope.value) ?? null)));
const allMode = computed(() => scope.value === 'all');
const baseCurrency = computed(() => scopeEvent.value?.currency ?? account.value?.profile.defaultCurrency ?? 'CHF');
/** What was physically collected. */
const currency = computed(() => scopeEvent.value?.localCurrency || scopeEvent.value?.currency || baseCurrency.value);

const scoped = computed(() => {
  const list = allMode.value ? recentTransactions.value : recentTransactions.value.filter((t) => t.eventId === scope.value);
  return [...list].sort((a, b) => b.timestamp - a.timestamp);
});
const live = computed(() => scoped.value.filter((t) => !t.revertedAt));

const eventName = (id: string): string => (id ? (getSalesEvent(id)?.name ?? 'Removed event') : 'No event');
const amountOf = (tx: Transaction): number => tx.baseTotal ?? tx.total;
const currencyOf = (tx: Transaction): string => tx.baseCurrency ?? tx.currency;
const itemAmountOf = (item: TxItem): number => item.baseLineTotal ?? item.lineTotal;
const discountAmountOf = (d: TxDiscount, tx: Transaction): number => (tx.exchangeRate ? round2(d.amount / tx.exchangeRate) : d.amount);

// ── Filters ─────────────────────────────────────────────────────────────────
const methodFilter = ref('all');
const showReverted = ref(false);
const methodOptions = computed(() => {
  const extras = new Set<string>();
  for (const tx of scoped.value) if (!['cash', 'card', 'split'].includes(tx.method)) extras.add(tx.method);
  return ['all', 'cash', 'card', 'split', ...extras];
});
const visible = computed(() => scoped.value.filter((tx) => (showReverted.value || !tx.revertedAt) && (methodFilter.value === 'all' || tx.method === methodFilter.value)));

// ── Stats ───────────────────────────────────────────────────────────────────
const stats = computed(() => {
  let revenue = 0;
  let items = 0;
  let cash = 0;
  let card = 0;
  for (const t of live.value) {
    revenue += amountOf(t);
    for (const i of t.items) items += i.qty;
    for (const p of t.payments) {
      // Legs are in the charge currency; across events they are shown in base.
      const amount = allMode.value && t.exchangeRate ? p.amount / t.exchangeRate : p.amount;
      if (p.kind === 'cash') cash += amount;
      else card += amount;
    }
  }
  return { count: live.value.length, revenue: round2(revenue), items, cash: round2(cash), card: round2(card) };
});

// ── Compare to another event ────────────────────────────────────────────────
const compareId = ref('');
const comparable = computed(() => visibleEvents.value.filter((e) => e.id !== scope.value));
function eventStats(eventId: string) {
  const txs = recentTransactions.value.filter((t) => t.eventId === eventId && !t.revertedAt);
  const revenue = txs.reduce((s, t) => s + amountOf(t), 0);
  const items = txs.reduce((s, t) => s + t.items.reduce((si, i) => si + i.qty, 0), 0);
  const days = new Set(txs.map((t) => new Date(t.timestamp).toISOString().slice(0, 10))).size || 1;
  return { revenue, count: txs.length, items, days };
}
const deltaPct = (cur: number, other: number): number | null => (other ? Math.round(((cur - other) / other) * 100) : null);
const comparison = computed(() => {
  if (!compareId.value || allMode.value) return null;
  const cur = eventStats(scope.value);
  const other = eventStats(compareId.value);
  const curDay = cur.revenue / cur.days;
  const otherDay = other.revenue / other.days;
  return {
    otherName: eventName(compareId.value),
    curDays: cur.days,
    otherDays: other.days,
    metrics: [
      { label: 'Revenue', cur: cur.revenue, other: other.revenue, delta: deltaPct(cur.revenue, other.revenue), money: true },
      { label: 'Revenue / day', cur: curDay, other: otherDay, delta: deltaPct(curDay, otherDay), money: true },
      { label: 'Sales', cur: cur.count, other: other.count, delta: deltaPct(cur.count, other.count), money: false },
      { label: 'Items sold', cur: cur.items, other: other.items, delta: deltaPct(cur.items, other.items), money: false },
    ],
  };
});

// ── Best sellers ────────────────────────────────────────────────────────────
type BestMode = 'products' | 'types' | 'revenue' | 'revenueByType';
const bestMode = ref<BestMode>('products');
const bestExpanded = ref(false);
const bestModes: { id: BestMode; label: string }[] = [
  { id: 'products', label: 'Products' },
  { id: 'types', label: 'Types' },
  { id: 'revenue', label: 'Revenue' },
  { id: 'revenueByType', label: 'Revenue by type' },
];
const typeByPid = computed(() => new Map(allProducts.value.filter((p) => p.type).map((p) => [p.id, p.type!])));
const bestAll = computed(() => {
  const map = new Map<string, { label: string; type?: string; qty: number; value: number }>();
  const byType = bestMode.value === 'types' || bestMode.value === 'revenueByType';
  const byRevenue = bestMode.value === 'revenue' || bestMode.value === 'revenueByType';
  for (const tx of live.value) {
    for (const item of tx.items) {
      const type = typeByPid.value.get(item.pid);
      const key = byType ? (type ?? '(no type)') : `${item.pid}:${item.vid ?? ''}`;
      const label = byType ? key : item.variantLabel ? `${item.title} · ${item.variantLabel}` : item.title;
      const cur = map.get(key) ?? { label, type: byType ? key : type, qty: 0, value: 0 };
      cur.qty += item.qty;
      cur.value += itemAmountOf(item);
      map.set(key, cur);
    }
  }
  return [...map.values()].sort(byRevenue ? (a, b) => b.value - a.value : (a, b) => b.qty - a.qty);
});
const bestSellers = computed(() => (bestExpanded.value ? bestAll.value : bestAll.value.slice(0, 8)));

// ── Per day / per hour ──────────────────────────────────────────────────────
const compareDaily = ref(false);
const daily = computed(() => {
  const map = new Map<string, number>();
  for (const tx of live.value) {
    const day = new Date(tx.timestamp).toISOString().slice(0, 10);
    map.set(day, (map.get(day) ?? 0) + amountOf(tx));
  }
  const entries = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return entries.map(([day, value], i) => {
    const prev = i > 0 ? entries[i - 1]![1] : null;
    const delta = prev != null ? round2(value - prev) : null;
    return { day, value, pct: (value / max) * 100, delta, deltaPct: prev ? Math.round((delta! / prev) * 100) : null };
  });
});

/**
 * Across all events: what a Monday, a Saturday... is worth on average. Each
 * calendar day with sales is one sample for its weekday; per weekday, days
 * outside 1.5x the interquartile range are dropped as outliers (a one-off
 * blowout or a half-day) before averaging, once there are enough samples for
 * quartiles to mean anything.
 */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const weekday = computed(() => {
  if (!allMode.value) return [];
  const perDay = new Map<string, { dow: number; value: number }>();
  for (const tx of live.value) {
    const d = new Date(tx.timestamp);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const cur = perDay.get(key) ?? { dow: (d.getDay() + 6) % 7, value: 0 };
    cur.value += amountOf(tx);
    perDay.set(key, cur);
  }
  const samples: number[][] = WEEKDAYS.map(() => []);
  for (const { dow, value } of perDay.values()) samples[dow]!.push(value);
  const rows = samples.map((values, dow) => {
    const { avg, dropped } = trimmed(values);
    return { label: WEEKDAYS[dow]!, avg, days: values.length, dropped };
  });
  const seen = rows.filter((r) => r.days > 0);
  const max = Math.max(1, ...seen.map((r) => r.avg));
  return seen.map((r) => ({ ...r, pct: (r.avg / max) * 100 }));
});

/**
 * Mean with outliers trimmed: once there are enough samples for quartiles to
 * mean anything, values outside 1.5x the interquartile range (a one-off
 * blowout, a half-day) are left out. Shared by the weekday and hourly averages.
 */
function trimmed(values: number[]): { avg: number; dropped: number } {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { avg: 0, dropped: 0 };
  const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ?? 0;
  let kept = sorted;
  if (sorted.length >= 4) {
    const iqr = q(0.75) - q(0.25);
    kept = sorted.filter((v) => v >= q(0.25) - 1.5 * iqr && v <= q(0.75) + 1.5 * iqr);
  }
  return { avg: round2(kept.reduce((a, b) => a + b, 0) / kept.length), dropped: sorted.length - kept.length };
}

const compareHourly = ref(false);
const hourly = computed(() => {
  const byDay = new Map<string, number[]>();
  for (const tx of live.value) {
    const d = new Date(tx.timestamp);
    const day = d.toISOString().slice(0, 10);
    const bucket = byDay.get(day) ?? new Array<number>(24).fill(0);
    bucket[d.getHours()] = (bucket[d.getHours()] ?? 0) + amountOf(tx);
    byDay.set(day, bucket);
  }
  const days = [...byDay.keys()].sort();
  if (!days.length) return [];
  let buckets: number[];
  let prev: number[] | null = null;
  if (compareHourly.value && !allMode.value) {
    buckets = byDay.get(days[days.length - 1]!)!;
    prev = days.length > 1 ? byDay.get(days[days.length - 2]!)! : null;
  } else if (allMode.value) {
    // Across events: what an hour is worth on an average selling day, with
    // each day's figure for that hour as one sample and outliers trimmed.
    buckets = new Array<number>(24).fill(0);
    const perDay = [...byDay.values()];
    for (let h = 0; h < 24; h++) buckets[h] = trimmed(perDay.map((b) => b[h] ?? 0)).avg;
  } else {
    buckets = new Array<number>(24).fill(0);
    for (const b of byDay.values()) for (let h = 0; h < 24; h++) buckets[h] = (buckets[h] ?? 0) + (b[h] ?? 0);
  }
  const active = buckets.map((v, h) => ({ h, v })).filter((b) => b.v > 0 || (prev && (prev[b.h] ?? 0) > 0));
  if (!active.length) return [];
  const from = active[0]!.h;
  const to = active[active.length - 1]!.h;
  const max = Math.max(...buckets, ...(prev ?? [0]));
  const span = to - from + 1;
  const labelEvery = span > 16 ? 3 : span > 8 ? 2 : 1;
  return buckets.slice(from, to + 1).map((v, i) => {
    const h = from + i;
    const prevV = prev ? (prev[h] ?? 0) : null;
    return { h, v, pct: Math.round((v / max) * 100), prevPct: prevV != null ? Math.round((prevV / max) * 100) : null, prevV, showLabel: i % labelEvery === 0 };
  });
});

// ── Revert ──────────────────────────────────────────────────────────────────
const revertId = ref<string | null>(null);
async function doRevert(): Promise<void> {
  if (!revertId.value) return;
  error.value = null;
  try {
    await revertTransaction(revertId.value);
    revertId.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not revert that sale.';
  }
}

/** jsPDF is heavy - loaded only when a report is actually asked for. */
async function exportPdf(): Promise<void> {
  if (!scopeEvent.value) return;
  try {
    const { buildSalesReportPdf } = await import('../lib/pdf-report');
    const { bytes, filename } = buildSalesReportPdf(scopeEvent.value, scoped.value);
    await saveFile(filename, new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }), 'application/pdf');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not build the PDF.';
  }
}

function exportCsv(): void {
  void saveFile(csvFilename(scopeEvent.value?.name ?? null), transactionsToCsv(scoped.value), 'text/csv;charset=utf-8');
}

const fmtTime = (ts: number): string => new Date(ts).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const methodIcon = (m: string): string => ({ cash: 'banknote', card: 'credit-card', split: 'zap' })[m] ?? 'smartphone';
const money = (n: number, c: string) => fmtPrice(n, c);
</script>

<template>
  <section class="history">
    <header>
      <router-link v-if="route.query.from === 'pos' && hasRoute('pos:index')" :to="{ name: 'pos:index' }" class="back"><Icon name="arrow-left" :size="16" /> Till</router-link>
      <h1>Sales history</h1>
      <select v-model="scope" aria-label="Event">
        <option value="all">All events</option>
        <option v-for="e in visibleEvents" :key="e.id" :value="e.id">{{ e.name }}{{ e.id === activeEventId ? ' (active)' : '' }}</option>
      </select>
      <span class="spacer"></span>
      <button type="button" :disabled="!scoped.length" @click="exportCsv"><Icon name="download" :size="14" /> Export CSV</button>
      <button v-if="!allMode" type="button" :disabled="!scoped.length" @click="exportPdf"><Icon name="file-text" :size="14" /> PDF report</button>
      <router-link v-if="!allMode && canRevert" :to="{ name: 'cashup' }" class="btn"><Icon name="banknote" :size="14" /> Cash up</router-link>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div class="tiles">
      <div class="tile"><span>Revenue</span><strong>{{ money(stats.revenue, baseCurrency) }}</strong></div>
      <div class="tile"><span>Sales / items</span><strong>{{ stats.count }} / {{ stats.items }}</strong></div>
      <div class="tile"><span>Cash</span><strong>{{ money(stats.cash, currency) }}</strong></div>
      <div class="tile"><span>Card</span><strong>{{ money(stats.card, currency) }}</strong></div>
    </div>

    <article v-if="!allMode" class="card">
      <div class="cardhead">
        <h2>Compare to</h2>
        <select v-model="compareId" aria-label="Compare with">
          <option value="">Pick an event…</option>
          <option v-for="e in comparable" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
      </div>
      <div v-if="comparison" class="table-scroll">
        <table class="compare">
          <thead>
            <tr><th></th><th>This ({{ comparison.curDays }}d)</th><th :title="comparison.otherName">{{ comparison.otherName }} ({{ comparison.otherDays }}d)</th><th>Δ</th></tr>
          </thead>
          <tbody>
            <tr v-for="m in comparison.metrics" :key="m.label">
              <td class="muted">{{ m.label }}</td>
              <td>{{ m.money ? money(m.cur, baseCurrency) : m.cur }}</td>
              <td class="muted">{{ m.money ? money(m.other, baseCurrency) : m.other }}</td>
              <td :class="m.delta == null ? 'muted' : m.delta > 0 ? 'good' : m.delta < 0 ? 'bad' : 'muted'">{{ m.delta == null ? '-' : (m.delta > 0 ? '+' : '') + m.delta + '%' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>

    <div class="two">
      <article class="card">
        <div class="cardhead">
          <h2>Best sellers</h2>
          <div class="seg">
            <button v-for="m in bestModes" :key="m.id" type="button" :class="{ on: bestMode === m.id }" @click="bestMode = m.id">{{ m.label }}</button>
          </div>
        </div>
        <p v-if="!bestSellers.length" class="hint">No sales yet.</p>
        <ol v-else class="best">
          <li v-for="(b, i) in bestSellers" :key="b.label">
            <span class="rank">{{ i + 1 }}.</span>
            <span class="name" :style="b.type ? { color: typeColor(b.type) } : undefined">{{ b.label }}</span>
            <span class="muted">{{ b.qty }}×</span>
            <strong>{{ money(b.value, baseCurrency) }}</strong>
          </li>
        </ol>
        <button v-if="bestAll.length > 8" type="button" class="quiet more" :aria-expanded="bestExpanded" @click="bestExpanded = !bestExpanded">{{ bestExpanded ? 'Show less' : `Show all ${bestAll.length}` }}</button>
      </article>

      <article v-if="allMode" class="card">
        <div class="cardhead">
          <h2>Average revenue per weekday</h2>
        </div>
        <p v-if="!daily.length" class="hint">No sales yet.</p>
        <div v-else class="days">
          <div v-for="w in weekday" :key="w.label" class="dayrow" :title="w.dropped ? `${w.days} days, ${w.dropped} outlier${w.dropped === 1 ? '' : 's'} left out` : `${w.days} day${w.days === 1 ? '' : 's'}`">
            <span class="muted">{{ w.label }}</span>
            <div class="bar"><div :style="{ width: w.pct + '%' }"></div></div>
            <span class="muted small">{{ w.days }}d{{ w.dropped ? ` -${w.dropped}` : '' }}</span>
            <strong>{{ w.days ? money(w.avg, baseCurrency) : '-' }}</strong>
          </div>
        </div>
        <p class="hint">Each day with sales counts once for its weekday; days far outside that weekday's usual range are left out of the average.</p>
      </article>

      <article v-else class="card">
        <div class="cardhead">
          <h2>Revenue per day</h2>
          <button v-if="daily.length > 1" type="button" :class="['toggle', { on: compareDaily }]" @click="compareDaily = !compareDaily">vs. day before</button>
        </div>
        <p v-if="!daily.length" class="hint">No sales yet.</p>
        <div v-else class="days">
          <div v-for="d in daily" :key="d.day" class="dayrow">
            <span class="muted">{{ d.day.slice(5) }}</span>
            <div class="bar"><div :style="{ width: d.pct + '%' }"></div></div>
            <span v-if="compareDaily && d.delta != null" :class="['delta', d.delta > 0 ? 'good' : d.delta < 0 ? 'bad' : 'muted']">{{ d.delta > 0 ? '+' : '' }}{{ d.deltaPct }}%</span>
            <strong>{{ money(d.value, baseCurrency) }}</strong>
          </div>
        </div>
      </article>
    </div>

    <article class="card">
      <div class="cardhead">
        <h2>{{ allMode ? 'Average revenue per hour' : 'Revenue per hour' }}</h2>
        <span v-if="allMode" class="hint">over {{ daily.length }} selling day{{ daily.length === 1 ? '' : 's' }}</span>
        <button v-else-if="daily.length > 1" type="button" :class="['toggle', { on: compareHourly }]" @click="compareHourly = !compareHourly">vs. day before</button>
      </div>
      <p v-if="!hourly.length" class="hint">No sales yet.</p>
      <div v-else class="hours">
        <div v-for="b in hourly" :key="b.h" class="hour">
          <div class="col">
            <div class="fill" :style="{ height: b.pct + '%' }" :title="`${b.h}:00 - ${money(b.v, baseCurrency)}`"></div>
            <div v-if="compareHourly && b.prevPct != null" class="prev" :style="{ bottom: b.prevPct + '%' }" :title="`${b.h}:00 day before - ${money(b.prevV ?? 0, baseCurrency)}`"></div>
          </div>
          <span :class="{ hide: !b.showLabel }">{{ b.h }}</span>
        </div>
      </div>
      <p v-if="compareHourly" class="hint legend"><i></i> day before</p>
    </article>

    <div class="filters">
      <div class="seg">
        <button v-for="m in methodOptions" :key="m" type="button" :class="{ on: methodFilter === m }" @click="methodFilter = m">{{ m }}</button>
      </div>
      <label class="inline"><input v-model="showReverted" type="checkbox" /> <span>Show reverted</span></label>
    </div>

    <p v-if="!visible.length" class="empty">No sales{{ allMode ? '' : ' for this event' }}.</p>
    <ul v-else class="txs">
      <li v-for="tx in visible" :key="tx.id" :class="{ reverted: tx.revertedAt }">
        <div class="txhead">
          <Icon :name="methodIcon(tx.method)" :size="16" />
          <strong>{{ money(amountOf(tx), currencyOf(tx)) }}</strong>
          <span v-if="allMode" class="chip">{{ eventName(tx.eventId) }}</span>
          <span v-if="tx.revertedAt" class="chip bad">reverted</span>
          <span class="spacer"></span>
          <span class="muted time">{{ fmtTime(tx.timestamp) }}</span>
          <router-link v-if="hasRoute('pos:receipt')" :to="{ name: 'pos:receipt', params: { saleId: tx.id } }" class="quiet icon" aria-label="Receipt"><Icon name="printer" :size="16" /></router-link>
          <button v-if="canRevert && !tx.revertedAt" type="button" class="quiet danger" @click="revertId = tx.id">Revert</button>
        </div>
        <ul class="lines">
          <li v-for="(item, i) in tx.items" :key="i"><span>{{ item.qty }}× {{ item.title }}<template v-if="item.variantLabel"> · {{ item.variantLabel }}</template></span><span>{{ money(itemAmountOf(item), currencyOf(tx)) }}</span></li>
          <li v-for="(d, i) in tx.discounts" :key="'d' + i" class="good"><span>{{ d.name }}</span><span>− {{ money(discountAmountOf(d, tx), currencyOf(tx)) }}</span></li>
        </ul>
      </li>
    </ul>

    <ModalShell v-if="revertId" title="Revert sale?" @close="revertId = null">
      <p class="body">The sale is marked as reverted and the items return to stock. The record stays in history - a till record is never deleted.</p>
      <template #footer>
        <div class="footer"><button type="button" @click="revertId = null">Cancel</button><button type="button" class="danger" @click="doRevert">Revert sale</button></div>
      </template>
    </ModalShell>
  </section>
</template>

<style scoped>
.history { display: flex; flex-direction: column; gap: 1rem; max-width: 72rem; }
header { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
header select { max-width: 16rem; }
.spacer { flex: 1; }
header button, .btn { display: inline-flex; align-items: center; gap: .35rem; }
.back { display: inline-flex; align-items: center; gap: .3rem; color: var(--zfy-accent-ink, #0a5a4a); font-weight: 600; text-decoration: none; font-size: .9rem; }
.btn { min-height: 2.4rem; padding: .3rem .9rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; background: var(--zfy-surface, #fff); color: var(--zfy-ink, #1a2230); font-weight: 500; font-size: .875rem; text-decoration: none; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .8rem; }
.muted { color: var(--zfy-muted, #5a6472); }
.good { color: var(--zfy-accent-ink, #0a5a4a); }
.bad { color: var(--zfy-danger, #c6512f); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .6rem; }
.tile { display: flex; flex-direction: column; gap: .15rem; padding: .7rem .9rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); max-width: 16rem; }
.tile span { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.tile strong { font-size: 1.15rem; font-variant-numeric: tabular-nums; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .8rem 1rem; display: flex; flex-direction: column; gap: .6rem; min-width: 0; }
.cardhead { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.cardhead h2 { margin: 0; font-size: .95rem; flex: 1; }
.cardhead select { max-width: 14rem; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); gap: .75rem; }
.toggle { min-height: 2.2rem; padding: .1rem .6rem; font-size: .74rem; }
.toggle.on { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); border-color: var(--zfy-accent, #0e7c66); }
.compare { width: 100%; border-collapse: collapse; font-size: .875rem; font-variant-numeric: tabular-nums; }
.compare th { text-align: right; font-weight: 400; font-size: .72rem; color: var(--zfy-muted, #5a6472); padding: .2rem .4rem; white-space: nowrap; max-width: 12rem; overflow: hidden; text-overflow: ellipsis; }
.compare td { text-align: right; padding: .25rem .4rem; }
.compare td:first-child, .compare th:first-child { text-align: left; }
.best { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; font-size: .875rem; }
.best li { display: flex; align-items: center; gap: .5rem; }
.rank { width: 1.4rem; text-align: right; font-size: .75rem; color: var(--zfy-muted, #5a6472); }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.best strong { min-width: 5.5rem; text-align: right; font-variant-numeric: tabular-nums; }
.more { align-self: flex-start; color: var(--zfy-accent-ink, #0a5a4a); font-size: .78rem; min-height: 2.2rem; padding: 0 .3rem; }
.days { display: flex; flex-direction: column; gap: .35rem; font-size: .78rem; }
.dayrow .small { font-size: .66rem; min-width: 3rem; text-align: right; }
.dayrow { display: flex; align-items: center; gap: .5rem; }
.dayrow > .muted { width: 3rem; flex-shrink: 0; }
.bar { flex: 1; height: 1rem; border-radius: 4px; background: var(--zfy-bg, #f1f4f6); overflow: hidden; }
.bar div { height: 100%; border-radius: 4px; background: var(--zfy-accent, #0e7c66); opacity: .75; }
.delta { width: 3.2rem; text-align: right; flex-shrink: 0; }
.dayrow strong { width: 6rem; text-align: right; font-variant-numeric: tabular-nums; }
.hours { display: flex; align-items: stretch; gap: .25rem; height: 7rem; }
.hour { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: .2rem; }
.col { position: relative; flex: 1; width: 100%; display: flex; align-items: flex-end; }
.fill { width: 100%; border-radius: 4px 4px 0 0; background: var(--zfy-accent, #0e7c66); opacity: .75; }
.prev { position: absolute; left: 0; right: 0; height: 2px; background: var(--zfy-warning, #d9942b); }
.hour span { font-size: .6rem; color: var(--zfy-muted, #5a6472); }
.hour span.hide { visibility: hidden; }
.legend i { display: inline-block; width: .8rem; height: 2px; background: var(--zfy-warning, #d9942b); vertical-align: middle; margin-right: .3rem; }
.filters { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
label.inline { display: flex; align-items: center; gap: .4rem; font-size: .8rem; color: var(--zfy-muted, #5a6472); }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.txs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.txs li.reverted { opacity: .55; }
.txs > li { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .6rem .8rem; display: flex; flex-direction: column; gap: .35rem; }
.txhead { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.txhead strong { font-size: .95rem; }
.chip { font-size: .66rem; padding: .1rem .4rem; border-radius: 4px; background: var(--zfy-bg, #f1f4f6); color: var(--zfy-muted, #5a6472); max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.bad { background: var(--zfy-signal-soft, #f6e5df); color: var(--zfy-danger, #c6512f); font-weight: 600; }
.time { font-size: .75rem; }
.txhead .quiet { min-height: 2.2rem; padding: .1rem .5rem; font-size: .78rem; }
.icon { display: inline-flex; align-items: center; color: var(--zfy-muted, #5a6472); }
.lines { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .15rem; font-size: .78rem; color: var(--zfy-muted, #5a6472); }
.lines li { display: flex; justify-content: space-between; gap: .5rem; }
.body { margin: 0; font-size: .9rem; }
.footer { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
