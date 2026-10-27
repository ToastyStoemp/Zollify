<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { fmtPrice } from '@zollify/shared';
import { Icon } from '@zollify/ui';
import { api, type Expense, type YearMaterials } from '../api';
import { sdk } from '../runtime';
import { yearChange, yearReview, yearsWithData, type YearBlock } from '../year';

/**
 * One page per year: what it came to, which event and which product carried
 * it, where the money went, and what the printing side cost. The same
 * figures the ledger and the ranking show - revenue excluding VAT, the
 * ledger's costs - lined up for a tax return or for picking next year's
 * events. Sales and events are on the device; the costs and the materials
 * come from the server, and without it the page still runs on sales alone.
 */
const expenses = ref<Expense[]>([]);
const categories = ref<Record<string, string>>({});
const materials = ref<YearMaterials | null>(null);
const error = ref<string | null>(null);
const loaded = ref(false);
const transactions = computed(() => sdk().data.transactions.recent());
const events = computed(() => sdk().data.events.list());
const years = computed(() => yearsWithData(transactions.value, expenses.value));
const year = ref(new Date().getFullYear());

onMounted(async () => {
  try {
    const res = await api.expenses();
    expenses.value = res.expenses;
    categories.value = Object.fromEntries(res.categories.map((c) => [c.id, c.label]));
  } catch (err) {
    error.value = `Could not load the ledger costs - the year shows sales alone. ${err instanceof Error ? err.message : ''}`.trim();
  } finally {
    loaded.value = true;
  }
  if (!years.value.includes(year.value)) year.value = years.value[0] ?? year.value;
});
watch(
  year,
  async (y) => {
    materials.value = null;
    try {
      materials.value = await api.year(y);
    } catch {
      // Without the server there is no materials figure; the rest of the page stands.
    }
  },
  { immediate: true },
);

const review = computed(() => yearReview(year.value, events.value, transactions.value, expenses.value));
const last = computed(() => yearReview(year.value - 1, events.value, transactions.value, expenses.value));
const lastOf = (currency: string): YearBlock | undefined => last.value.blocks.find((b) => b.currency === currency);
const empty = computed(() => !review.value.blocks.length);
const defaultCurrency = computed(() => sdk().account()?.profile.defaultCurrency ?? review.value.blocks[0]?.currency ?? 'EUR');

const money = (n: number, currency: string): string => fmtPrice(n, currency);
const pct = (f: number | null): string => (f == null ? '' : `${f > 0 ? '+' : ''}${Math.round(f * 100)}% on ${year.value - 1}`);
const label = (category: string): string => categories.value[category] ?? category;
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthMax = (b: YearBlock): number => Math.max(0, ...b.byMonth);
const bestMonth = (b: YearBlock): number => b.byMonth.indexOf(monthMax(b));
const costRows = (b: YearBlock) => Object.entries(b.byCategory).sort((x, y) => y[1] - x[1]);
const typeRows = computed(() => Object.entries(materials.value?.materials.byType ?? {}).sort((x, y) => y[1] - x[1]));
const print = (): void => window.print();
</script>

<template>
  <section class="year">
    <header class="top">
      <div>
        <h1>Year in review</h1>
        <p class="lede">What the year came to, which event and product carried it, and where the money went. Revenue excludes VAT; costs are the ledger's, by the date paid.</p>
      </div>
      <button type="button" class="quiet noprint" @click="print"><Icon name="printer" :size="14" /> Print</button>
    </header>

    <div class="chips noprint" role="tablist" aria-label="Year">
      <button v-for="y in years" :key="y" type="button" class="chip" role="tab" :class="{ on: y === year }" :aria-selected="y === year" @click="year = y">{{ y }}</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!loaded" class="hint">Loading…</p>
    <p v-else-if="empty" class="empty">Nothing sold or spent in {{ year }} yet.</p>

    <template v-for="b in review.blocks" :key="b.currency">
      <h2 v-if="review.blocks.length > 1" class="currency">In {{ b.currency }}</h2>

      <ul class="tiles">
        <li><span class="label">Revenue <small>excl. VAT</small></span><strong class="good">{{ money(b.revenue, b.currency) }}</strong><small class="delta">{{ pct(yearChange(b.revenue, lastOf(b.currency)?.revenue)) }}</small></li>
        <li><span class="label">Costs</span><strong class="bad">{{ b.expenses ? '−' + money(b.expenses, b.currency) : '-' }}</strong><small class="delta">{{ pct(yearChange(b.expenses, lastOf(b.currency)?.expenses)) }}</small></li>
        <li><span class="label">Profit</span><strong :class="b.profit >= 0 ? 'good' : 'bad'">{{ money(b.profit, b.currency) }}</strong><small class="delta">{{ pct(yearChange(b.profit, lastOf(b.currency)?.profit)) }}</small></li>
        <li><span class="label">Sales</span><strong>{{ b.sales }}</strong><small class="delta">{{ b.units }} unit{{ b.units === 1 ? '' : 's' }}<template v-if="b.givenAway"> · {{ b.givenAway }} given away</template></small></li>
      </ul>

      <div class="two">
        <article class="card">
          <h2>Month by month</h2>
          <p class="hint">{{ monthMax(b) > 0 ? `Best month: ${MONTH_NAMES[bestMonth(b)]}, ${money(monthMax(b), b.currency)}.` : 'No revenue yet this year.' }}</p>
          <ol class="months" aria-label="Revenue per month">
            <li v-for="(v, i) in b.byMonth" :key="i" :title="`${MONTH_NAMES[i]}: ${money(v, b.currency)}`">
              <span class="bar" :style="{ height: `${monthMax(b) > 0 ? Math.max(v > 0 ? 3 : 0, (v / monthMax(b)) * 100) : 0}%` }"></span>
              <span class="m">{{ MONTHS[i] }}</span>
            </li>
          </ol>
        </article>

        <article class="card">
          <h2>Where the money went</h2>
          <p v-if="!costRows(b).length" class="hint">No costs in the ledger for {{ year }}.</p>
          <ul v-else class="bars">
            <li v-for="[c, v] in costRows(b)" :key="c">
              <span class="row"><span>{{ label(c) }}</span><strong>{{ money(v, b.currency) }}</strong></span>
              <span class="track"><span class="fill bad-fill" :style="{ width: `${(v / b.expenses) * 100}%` }"></span></span>
            </li>
          </ul>
        </article>
      </div>

      <div class="two">
        <article class="card">
          <h2>Events</h2>
          <p v-if="b.events[0]" class="hint">Best: <strong>{{ b.events[0].name }}</strong>, {{ money(b.events[0].profit, b.currency) }} profit on {{ money(b.events[0].revenue, b.currency) }}.</p>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Event</th><th class="num">Revenue</th><th class="num">Costs</th><th class="num">Profit</th><th class="num">Units</th></tr></thead>
              <tbody>
                <tr v-for="e in b.events" :key="e.eventId">
                  <td><strong>{{ e.name }}</strong><span v-if="e.kind === 'store'" class="sub"> · store</span></td>
                  <td class="num good">{{ money(e.revenue, b.currency) }}</td>
                  <td class="num bad">{{ e.expenses ? '−' + money(e.expenses, b.currency) : '-' }}</td>
                  <td :class="['num', e.profit >= 0 ? 'good' : 'bad']">{{ money(e.profit, b.currency) }}</td>
                  <td class="num">{{ e.units }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>

        <article class="card">
          <h2>What sold most</h2>
          <p v-if="!b.products.length" class="hint">Nothing sold yet.</p>
          <ol v-else class="products">
            <li v-for="p in b.products" :key="p.key">
              <span class="row"><span>{{ p.title }}</span><span class="sub">{{ p.units }} · {{ money(p.revenue, b.currency) }}</span></span>
              <span class="track"><span class="fill" :style="{ width: `${(p.units / b.products[0]!.units) * 100}%` }"></span></span>
            </li>
          </ol>
        </article>
      </div>
    </template>

    <article v-if="materials && (materials.materials.orders || materials.waste.qty)" class="card">
      <h2>Materials and misprints</h2>
      <p class="hint">What was bought under Sourcing → Materials this year, and what went to waste at the average price paid. In {{ defaultCurrency }}.</p>
      <ul class="tiles small">
        <li><span class="label">Materials bought</span><strong>{{ money(materials.materials.spent, defaultCurrency) }}</strong><small class="delta">{{ materials.materials.orders }} order{{ materials.materials.orders === 1 ? '' : 's' }}<template v-for="[t, v] in typeRows" :key="t"> · {{ t }} {{ money(v, defaultCurrency) }}</template></small></li>
        <li><span class="label">Waste</span><strong class="bad">{{ money(materials.waste.cost, defaultCurrency) }}</strong><small class="delta"><template v-if="materials.waste.byMaterial.length">{{ materials.waste.byMaterial.map((w) => `${w.qty} ${w.unit}${w.qty === 1 ? '' : 's'} ${w.name}`).join(' · ') }}</template><template v-else>no misprints logged</template></small></li>
      </ul>
    </article>
  </section>
</template>

<style scoped>
.year { display: flex; flex-direction: column; gap: 1rem; }
.top { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; align-items: flex-start; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: 1.05rem; }
.currency { font-size: 1.15rem; margin-top: .5rem; }
.lede, .hint, .empty { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .9rem; max-width: 70ch; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.chips { display: flex; gap: .3rem; flex-wrap: wrap; }
.chip { font-size: .78rem; padding: .2rem .6rem; border-radius: 999px; min-height: 0; }
.chip.on { background: var(--zfy-accent, #0e7c66); color: #fff; }
.good { color: var(--zfy-accent-ink, #0a5a4a); }
.bad { color: var(--zfy-danger, #c6512f); }
.tiles { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .6rem; }
.tiles li { display: flex; flex-direction: column; gap: .15rem; padding: .8rem .9rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); min-width: 0; }
.tiles .label { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); }
.tiles .label small { text-transform: none; letter-spacing: 0; }
.tiles strong { font-size: 1.35rem; font-variant-numeric: tabular-nums; }
.tiles.small strong { font-size: 1.15rem; }
.delta { color: var(--zfy-muted, #5a6472); font-size: .78rem; min-height: 1em; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .75rem; min-width: 0; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: start; }
.months { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(12, 1fr); gap: .25rem; height: 8rem; align-items: end; }
.months li { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; gap: .2rem; }
.months .bar { display: block; width: 100%; max-width: 1.6rem; border-radius: 4px 4px 0 0; background: var(--zfy-accent, #0e7c66); min-height: 0; }
.months .m { font-size: .7rem; color: var(--zfy-muted, #5a6472); }
.bars, .products { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.bars li, .products li { display: flex; flex-direction: column; gap: .2rem; font-size: .9rem; }
.row { display: flex; justify-content: space-between; gap: .6rem; }
.row > :first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.track { display: block; height: .45rem; border-radius: 999px; background: var(--zfy-surface-2, #e9edf1); overflow: hidden; }
.fill { display: block; height: 100%; background: var(--zfy-accent, #0e7c66); }
.bad-fill { background: var(--zfy-danger, #c6512f); }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .45rem .5rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); font-size: .9rem; white-space: nowrap; }
td:first-child { white-space: normal; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); }
tbody tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.sub { color: var(--zfy-muted, #5a6472); font-size: .82rem; }
@media (max-width: 800px) { .two { grid-template-columns: 1fr; } }
@media print { .noprint { display: none; } .two { grid-template-columns: 1fr 1fr; } }
</style>
