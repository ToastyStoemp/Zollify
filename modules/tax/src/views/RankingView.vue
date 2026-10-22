<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { fmtDayRange, fmtPrice, localIsoDay, type Product } from '@zollify/shared';
import { api } from '../api';
import { sdk } from '../runtime';
import { vatByEvent } from '../ledger-vat';
import { deadStock, editionTables, rankEvents, soldAt, storeRows, toCsv, type EventFigures, type RankRow } from '../ranking';

/**
 * Reports across events. Revenue is what the ledger shows - excluding the VAT
 * the till collected - and costs are the ledger's, so a row here is the
 * ledger's row, only ranked, compared with its earlier editions, broken down
 * by what sold, and read against what is still on the shelf. Nothing to
 * enter: everything comes from sales and events the device already holds,
 * plus the ledger's costs from the server.
 */
const tab = ref<'ranking' | 'editions' | 'sold' | 'dead'>('ranking');
const figures = ref<Map<string, EventFigures>>(new Map());
const error = ref<string | null>(null);
const loaded = ref(false);
const today = localIsoDay();

onMounted(async () => {
  try {
    const { rows } = await api.pnl();
    const vat = vatByEvent(sdk().data.transactions.recent());
    figures.value = new Map(rows.map((r) => [r.eventId, { revenue: r.revenue, vat: vat[r.eventId] ?? 0, expenses: r.expenses, mixed: r.currencies.some((c) => c && c !== (r.currency || 'EUR')) }]));
  } catch (err) {
    // Without the server the costs are missing; sales and events are here, so the report still runs on revenue.
    error.value = `Could not load the ledger costs - ranking on revenue alone. ${err instanceof Error ? err.message : ''}`.trim();
  } finally {
    loaded.value = true;
  }
});

const events = computed(() => sdk().data.events.list());
const transactions = computed(() => sdk().data.transactions.recent());
const products = computed(() => new Map(sdk().data.products.list().map((p) => [p.id, p] as [string, Product])));
const money = (n: number | null, currency: string): string => (n == null ? '-' : fmtPrice(n, currency));
const pct = (f: number | null): string => (f == null ? '' : `${f > 0 ? '+' : ''}${Math.round(f * 100)}%`);
const dates = (r: RankRow): string => fmtDayRange(r.start, r.end) || (r.days ? `${r.days} day${r.days === 1 ? '' : 's'}` : 'undated');

// ── Ranking ────────────────────────────────────────────────────────────────
type SortKey = 'perDay' | 'profit' | 'revenue' | 'units' | 'avgSale' | 'start';
const sortKey = ref<SortKey>('perDay');
const ranked = computed(() => rankEvents(events.value, transactions.value, figures.value, today));
const sorted = computed(() => {
  const k = sortKey.value;
  const val = (r: RankRow): number | string => (k === 'start' ? r.start : (r[k] ?? -Infinity));
  return [...ranked.value].sort((a, b) => (val(b) > val(a) ? 1 : val(b) < val(a) ? -1 : 0));
});
const COLS: { key: SortKey; label: string }[] = [
  { key: 'perDay', label: 'Profit / day' },
  { key: 'profit', label: 'Profit' },
  { key: 'revenue', label: 'Revenue excl. VAT' },
  { key: 'units', label: 'Units' },
  { key: 'avgSale', label: 'Avg sale' },
  { key: 'start', label: 'Date' },
];

// Stores over a period: default the last twelve months.
const periodFrom = ref(localIsoDay(new Date(new Date().getFullYear() - 1, new Date().getMonth(), new Date().getDate() + 1)));
const periodTo = ref(today);
const stores = computed(() => storeRows(events.value, transactions.value, figures.value, periodFrom.value, periodTo.value));

// ── Editions ───────────────────────────────────────────────────────────────
const series = computed(() => editionTables(ranked.value));

// ── What sold where ────────────────────────────────────────────────────────
const soldEvent = ref('');
const soldChoices = computed(() => [...ranked.value].sort((a, b) => b.start.localeCompare(a.start)));
const sold = computed(() => (soldEvent.value ? soldAt(soldEvent.value, transactions.value, products.value) : null));
const soldCurrency = computed(() => events.value.find((e) => e.id === soldEvent.value)?.currency ?? 'EUR');
const TOP = 25;

// ── Dead stock ─────────────────────────────────────────────────────────────
const lastEvents = ref(3);
const months = ref(6);
const dead = computed(() =>
  deadStock(sdk().data.products.list(), events.value, transactions.value, (pid, vid) => sdk().data.inventory.inStock(pid, vid), { lastEvents: Math.max(0, Number(lastEvents.value) || 0), months: Math.max(0, Number(months.value) || 0), today }),
);
const baseCurrency = computed(() => sdk().data.events.active()?.currency ?? events.value[0]?.currency ?? 'EUR');
const deadValue = computed(() => dead.value.reduce((s, r) => s + r.value, 0));

// ── CSV ────────────────────────────────────────────────────────────────────
async function download<T extends object>(name: string, headers: { key: keyof T & string; label: string }[], rows: T[]): Promise<void> {
  await sdk().ui.saveFile(`${name}-${today}.csv`, toCsv(headers, rows), 'text/csv');
}
const RANK_COLS: { key: keyof RankRow & string; label: string }[] = [
  { key: 'name', label: 'Event' }, { key: 'start', label: 'From' }, { key: 'end', label: 'To' }, { key: 'country', label: 'Country' }, { key: 'days', label: 'Days' }, { key: 'currency', label: 'Currency' },
  { key: 'revenue', label: 'Revenue excl. VAT' }, { key: 'expenses', label: 'Costs' }, { key: 'profit', label: 'Profit' }, { key: 'perDay', label: 'Profit per day' }, { key: 'units', label: 'Units' }, { key: 'sales', label: 'Sales' }, { key: 'avgSale', label: 'Average sale' },
];
</script>

<template>
  <section class="rank">
    <header class="top">
      <div>
        <h1>Event ranking</h1>
        <p class="lede">Which events pay off, how a show does year over year, what sold where, and what has stopped selling. Revenue excludes VAT; costs are the ledger's.</p>
      </div>
    </header>
    <div class="chips tabs" role="tablist" aria-label="Report">
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'ranking' }" :aria-selected="tab === 'ranking'" @click="tab = 'ranking'">Ranking</button>
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'editions' }" :aria-selected="tab === 'editions'" @click="tab = 'editions'">Year over year</button>
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'sold' }" :aria-selected="tab === 'sold'" @click="tab = 'sold'">What sold where</button>
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'dead' }" :aria-selected="tab === 'dead'" @click="tab = 'dead'">Dead stock</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!loaded" class="hint">Loading…</p>

    <template v-else-if="tab === 'ranking'">
      <div class="bar">
        <label class="inline">Sort by
          <select v-model="sortKey"><option v-for="c in COLS" :key="c.key" :value="c.key">{{ c.label }}</option></select>
        </label>
        <button type="button" :disabled="!sorted.length" @click="download('event-ranking', RANK_COLS, sorted)">CSV</button>
      </div>
      <p v-if="!sorted.length" class="hint">No past events with sales yet.</p>
      <div v-else class="table-scroll stack">
        <table>
          <thead><tr><th>#</th><th>Event</th><th>When</th><th class="num">Days</th><th class="num">Revenue <small>excl. VAT</small></th><th class="num">Costs</th><th class="num">Profit</th><th class="num">Profit / day</th><th class="num">Units</th><th class="num">Avg sale</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in sorted" :key="r.eventId" class="row">
              <td class="mono">{{ i + 1 }}</td>
              <td><strong>{{ r.name }}</strong><span v-if="r.country" class="sub"> · {{ r.country }}</span></td>
              <td data-label="When" class="sub">{{ dates(r) }}</td>
              <td class="num" data-label="Days">{{ r.days || '-' }}</td>
              <td class="num good" data-label="Revenue">{{ money(r.revenue, r.currency) }}</td>
              <td class="num bad" data-label="Costs">{{ r.expenses ? '−' + money(r.expenses, r.currency) : '-' }}</td>
              <td :class="['num', (r.profit ?? 0) >= 0 ? 'good' : 'bad']" data-label="Profit">{{ r.profit == null ? 'mixed currencies' : money(r.profit, r.currency) }}</td>
              <td class="num" data-label="Profit / day"><strong>{{ money(r.perDay, r.currency) }}</strong></td>
              <td class="num" data-label="Units">{{ r.units }}</td>
              <td class="num" data-label="Avg sale">{{ money(r.avgSale, r.currency) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <template v-if="events.some((e) => e.kind === 'store')">
        <h2>Stores</h2>
        <p class="hint">A store has no end, so it is shown over a period: the days it sold on stand in for event days, and costs are what the ledger holds for it, dated in the period.</p>
        <div class="bar">
          <label class="inline">From <input v-model="periodFrom" type="date" /></label>
          <label class="inline">To <input v-model="periodTo" type="date" /></label>
          <button type="button" :disabled="!stores.length" @click="download('store-ranking', RANK_COLS, stores)">CSV</button>
        </div>
        <div class="table-scroll stack">
          <table>
            <thead><tr><th>Store</th><th class="num">Selling days</th><th class="num">Revenue <small>excl. VAT</small></th><th class="num">Costs</th><th class="num">Profit</th><th class="num">Profit / day</th><th class="num">Units</th><th class="num">Avg sale</th></tr></thead>
            <tbody>
              <tr v-for="r in stores" :key="r.eventId" class="row">
                <td><strong>{{ r.name }}</strong></td>
                <td class="num" data-label="Selling days">{{ r.days }}</td>
                <td class="num good" data-label="Revenue">{{ money(r.revenue, r.currency) }}</td>
                <td class="num bad" data-label="Costs">{{ r.expenses ? '−' + money(r.expenses, r.currency) : '-' }}</td>
                <td :class="['num', (r.profit ?? 0) >= 0 ? 'good' : 'bad']" data-label="Profit">{{ r.profit == null ? 'mixed currencies' : money(r.profit, r.currency) }}</td>
                <td class="num" data-label="Profit / day"><strong>{{ money(r.perDay, r.currency) }}</strong></td>
                <td class="num" data-label="Units">{{ r.units }}</td>
                <td class="num" data-label="Avg sale">{{ money(r.avgSale, r.currency) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>

    <template v-else-if="tab === 'editions'">
      <p v-if="!series.length" class="hint">No show has more than one edition yet. Editions are linked under Events, or matched by name with the year taken out.</p>
      <section v-for="s in series" :key="s.key" class="card">
        <div class="formhead">
          <h2>{{ s.name }}</h2>
          <span class="sub">Average {{ money(s.avgPerDay, s.editions[0]!.currency) }} per day over {{ s.editions.length }} editions</span>
        </div>
        <div class="table-scroll stack">
          <table>
            <thead><tr><th>Edition</th><th>When</th><th class="num">Days</th><th class="num">Revenue <small>excl. VAT</small></th><th class="num">Profit</th><th class="num">Profit / day</th><th class="num">Units</th></tr></thead>
            <tbody>
              <tr v-for="e in s.editions" :key="e.eventId" class="row">
                <td><strong>{{ e.edition || e.name }}</strong></td>
                <td data-label="When" class="sub">{{ dates(e) }}</td>
                <td class="num" data-label="Days">{{ e.days || '-' }}</td>
                <td class="num" data-label="Revenue">{{ money(e.revenue, e.currency) }} <small :class="(e.revenueChange ?? 0) >= 0 ? 'good' : 'bad'">{{ pct(e.revenueChange) }}</small></td>
                <td class="num" data-label="Profit">{{ money(e.profit, e.currency) }} <small :class="(e.profitChange ?? 0) >= 0 ? 'good' : 'bad'">{{ pct(e.profitChange) }}</small></td>
                <td class="num" data-label="Profit / day"><strong>{{ money(e.perDay, e.currency) }}</strong> <small :class="(e.perDayChange ?? 0) >= 0 ? 'good' : 'bad'">{{ pct(e.perDayChange) }}</small></td>
                <td class="num" data-label="Units">{{ e.units }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <template v-else-if="tab === 'sold'">
      <div class="bar">
        <label class="inline">Event
          <select v-model="soldEvent">
            <option value="">Pick an event</option>
            <option v-for="r in soldChoices" :key="r.eventId" :value="r.eventId">{{ r.name }}<template v-if="r.start"> ({{ r.start }})</template></option>
          </select>
        </label>
        <button type="button" :disabled="!sold" @click="download('what-sold', [{ key: 'title', label: 'Item' }, { key: 'type', label: 'Type' }, { key: 'units', label: 'Units' }, { key: 'revenue', label: 'Revenue' }, { key: 'share', label: 'Share' }], sold!.items)">CSV</button>
      </div>
      <p v-if="!sold" class="hint">Pick an event to see what carried it.</p>
      <template v-else>
        <div class="two">
          <section class="card">
            <h2>By type</h2>
            <ul class="bars">
              <li v-for="t in sold.types" :key="t.key">
                <span class="label"><span>{{ t.title }}</span><span>{{ money(t.revenue, soldCurrency) }} · {{ Math.round(t.share * 100) }}%</span></span>
                <span class="track"><span class="fill" :style="{ width: `${Math.round(t.share * 100)}%` }"></span></span>
              </li>
            </ul>
          </section>
          <section class="card">
            <h2>Top items</h2>
            <p v-if="sold.items.length > TOP" class="hint">The top {{ TOP }} of {{ sold.items.length }}; the CSV has them all.</p>
            <ul class="bars">
              <li v-for="t in sold.items.slice(0, TOP)" :key="t.key">
                <span class="label"><span>{{ t.title }} <small class="sub">× {{ t.units }}</small></span><span>{{ money(t.revenue, soldCurrency) }} · {{ Math.round(t.share * 100) }}%</span></span>
                <span class="track"><span class="fill" :style="{ width: `${Math.round(t.share * 100)}%` }"></span></span>
              </li>
            </ul>
          </section>
        </div>
      </template>
    </template>

    <template v-else>
      <p class="lede">Items on hand that sold at none of the last few events and not in the last months: candidates to discount, bundle or retire. Valued at cost where one is known, else at list price.</p>
      <div class="bar">
        <label class="inline">Not sold at the last <input v-model.number="lastEvents" type="number" min="0" max="50" class="short" /> events</label>
        <label class="inline">nor in the last <input v-model.number="months" type="number" min="0" max="60" class="short" /> months</label>
        <button type="button" :disabled="!dead.length" @click="download('dead-stock', [{ key: 'title', label: 'Item' }, { key: 'type', label: 'Type' }, { key: 'inStock', label: 'In stock' }, { key: 'value', label: 'Value' }, { key: 'valuedAt', label: 'Valued at' }, { key: 'lastSold', label: 'Last sold' }], dead)">CSV</button>
      </div>
      <p v-if="!dead.length" class="hint">Nothing on hand has gone unsold that long.</p>
      <template v-else>
        <p class="hint">{{ dead.length }} item{{ dead.length === 1 ? '' : 's' }}, {{ money(deadValue, baseCurrency) }} sitting on the shelf.</p>
        <div class="table-scroll stack">
          <table>
            <thead><tr><th>Item</th><th>Type</th><th class="num">In stock</th><th class="num">Value</th><th>Last sold</th></tr></thead>
            <tbody>
              <tr v-for="r in dead" :key="`${r.productId}:${r.variantId ?? ''}`" class="row">
                <td><strong>{{ r.title }}</strong></td>
                <td data-label="Type" class="sub">{{ r.type || '-' }}</td>
                <td class="num" data-label="In stock">{{ r.inStock }}</td>
                <td class="num" data-label="Value">{{ money(r.value, baseCurrency) }} <small class="sub">at {{ r.valuedAt }}</small></td>
                <td data-label="Last sold" class="sub">{{ r.lastSold || 'never' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.rank { display: flex; flex-direction: column; gap: 1rem; }
.top { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: 1.05rem; }
.lede, .hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .9rem; max-width: 70ch; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.chips { display: flex; gap: .3rem; flex-wrap: wrap; }
.chip { font-size: .78rem; padding: .2rem .6rem; border-radius: 999px; min-height: 0; }
.chip.on { background: var(--zfy-accent, #0e7c66); color: #fff; }
.bar { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; }
.inline { display: flex; align-items: center; gap: .4rem; font-size: .875rem; }
.short { width: 4.5rem; }
.good { color: var(--zfy-accent-ink, #0a5a4a); }
.bad { color: var(--zfy-danger, #c6512f); }
table { width: 100%; border-collapse: collapse; background: var(--zfy-surface, #fff); border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: .55rem .75rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); font-size: .9rem; white-space: nowrap; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); }
th small { font-size: .65rem; text-transform: none; letter-spacing: 0; font-weight: 400; }
tbody tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.mono { font-variant-numeric: tabular-nums; color: var(--zfy-muted, #5a6472); }
.sub { color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .75rem; }
.formhead { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: start; }
.bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.bars li { display: flex; flex-direction: column; gap: .2rem; font-size: .9rem; }
.bars .label { display: flex; justify-content: space-between; gap: .6rem; }
.track { display: block; height: .45rem; border-radius: 999px; background: var(--zfy-surface-2, #e9edf1); overflow: hidden; }
.fill { display: block; height: 100%; background: var(--zfy-accent, #0e7c66); }
@media (max-width: 800px) { .two { grid-template-columns: 1fr; } }
</style>
