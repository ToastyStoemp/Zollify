<script setup lang="ts">
import { computed, ref } from 'vue';
import { COUNTRY_BY_CODE, fmtRate } from '@zollify/shared';
import {
  buildSmeReport,
  previousQuarter,
  quarterLabel,
  quarterOf,
  reportCsv,
  type CountryRow,
  type Quarter,
  type QuarterRef,
} from '../engine/report';
import { sdk } from '../runtime';

/**
 * One quarter's sales per country, as the SME scheme wants them reported:
 * exempt sales in full, VAT-charged sales without their VAT.
 */

const now = quarterOf(Date.now());
// The quarter to report is usually the one that just ended.
const selected = ref<QuarterRef>(previousQuarter(now));
const year = computed({
  get: () => selected.value.year,
  set: (y: number) => (selected.value = { ...selected.value, year: y }),
});
const quarter = computed({
  get: () => selected.value.quarter,
  set: (q: Quarter) => (selected.value = { ...selected.value, quarter: q }),
});

const transactions = computed(() => sdk().data.transactions.recent());
const years = computed(() => {
  const ys = new Set<number>([now.year]);
  for (const tx of transactions.value) ys.add(new Date(tx.timestamp).getFullYear());
  return [...ys].sort((a, b) => b - a);
});

const report = computed(() =>
  buildSmeReport({
    quarter: selected.value,
    transactions: transactions.value,
    eventOf: (id) => sdk().data.events.get(id),
    profile: sdk().account()?.profile,
  }),
);
const eu = computed(() => report.value.rows.filter((r) => r.eu));
const other = computed(() => report.value.rows.filter((r) => !r.eu));
const open = ref<Set<string>>(new Set());
const keyOf = (r: CountryRow): string => `${r.country}|${r.currency}`;
function toggle(r: CountryRow): void {
  const next = new Set(open.value);
  if (!next.delete(keyOf(r))) next.add(keyOf(r));
  open.value = next;
}

const name = (code: string): string => (code ? COUNTRY_BY_CODE[code] ?? code : 'Unknown country');
const fmt = (n: number, cur = 'EUR'): string => `${cur} ${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const STATUS: Record<CountryRow['status'], string> = { exempt: 'Exempt', charged: 'VAT charged', mixed: 'Partly exempt' };

async function exportCsv(): Promise<void> {
  const q = selected.value;
  await sdk().ui.saveFile(`sme-report-${q.year}-Q${q.quarter}.csv`, reportCsv(report.value, name), 'text/csv');
}
</script>

<template>
  <section class="sme">
    <header class="top">
      <div>
        <h1>SME report</h1>
        <p class="lede">
          Sales per country for {{ quarterLabel(selected) }}. Exempt sales count in full; where VAT was charged, the
          amount without VAT.
        </p>
      </div>
      <div class="pick">
        <label>
          <span>Year</span>
          <select v-model.number="year">
            <option v-for="y in years" :key="y" :value="y">{{ y }}</option>
          </select>
        </label>
        <label>
          <span>Quarter</span>
          <select v-model.number="quarter">
            <option v-for="q in [1, 2, 3, 4]" :key="q" :value="q">Q{{ q }}</option>
          </select>
        </label>
        <button type="button" :disabled="!report.rows.length" @click="exportCsv">Export CSV</button>
      </div>
    </header>

    <ul v-for="t in report.totals" :key="t.currency" class="totals">
      <li><span class="label">To report (EU)</span><strong>{{ fmt(t.euReported, t.currency) }}</strong></li>
      <li><span class="label">To report (all)</span><strong>{{ fmt(t.reported, t.currency) }}</strong></li>
      <li><span class="label">Customers paid</span><strong>{{ fmt(t.gross, t.currency) }}</strong></li>
      <li><span class="label">VAT inside</span><strong>{{ fmt(t.vat, t.currency) }}</strong></li>
      <li><span class="label">Sales</span><strong>{{ t.sales }}</strong></li>
    </ul>

    <p v-if="report.estimated" class="warn" role="note">
      {{ report.estimated }} sale{{ report.estimated === 1 ? '' : 's' }} in this quarter {{ report.estimated === 1 ? 'was' : 'were' }}
      made before VAT was recorded on each sale, so {{ report.estimated === 1 ? 'it is' : 'they are' }} judged by the event's
      country and today's VAT settings.
    </p>

    <p v-if="!report.rows.length" class="empty">No sales in {{ quarterLabel(selected) }}.</p>

    <template v-for="group in [{ title: 'EU', rows: eu }, { title: 'Outside the EU', rows: other }]" :key="group.title">
      <div v-if="group.rows.length" class="table-scroll">
        <h2>{{ group.title }}</h2>
        <table>
          <thead>
            <tr>
              <th>Country</th><th>Status</th><th class="num">Sales</th><th class="num">Customers paid</th><th class="num">VAT</th><th class="num">To report</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="r in group.rows" :key="keyOf(r)">
              <tr class="row" role="button" tabindex="0" :aria-expanded="open.has(keyOf(r))" @click="toggle(r)" @keydown.enter="toggle(r)" @keydown.space.prevent="toggle(r)">
                <td><strong>{{ name(r.country) }}</strong><span v-if="r.country" class="sub"> · {{ r.country }}</span></td>
                <td><span :class="['tag', r.status]">{{ STATUS[r.status] }}</span></td>
                <td class="num">{{ r.sales }}</td>
                <td class="num">{{ fmt(r.exemptGross + r.chargedGross, r.currency) }}</td>
                <td class="num">{{ r.vat ? fmt(r.vat, r.currency) : '-' }}</td>
                <td class="num"><strong>{{ fmt(r.reported, r.currency) }}</strong></td>
              </tr>
              <tr v-if="open.has(keyOf(r))" class="detail">
                <td colspan="6">
                  <ul>
                    <li v-if="r.exemptGross">Exempt: {{ fmt(r.exemptGross, r.currency) }}, counted in full</li>
                    <li v-for="l in r.rates" :key="l.rate">
                      At {{ fmtRate(l.rate) }}: {{ fmt(l.gross, r.currency) }} paid, {{ fmt(l.vat, r.currency) }} VAT, {{ fmt(l.net, r.currency) }} without VAT
                    </li>
                    <li v-if="r.unrated">No VAT rate recorded: {{ fmt(r.unrated, r.currency) }}, counted in full</li>
                  </ul>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>

    <p v-if="report.reverted" class="hint">{{ report.reverted }} reverted sale{{ report.reverted === 1 ? '' : 's' }} left out.</p>
  </section>
</template>

<style scoped>
.sme { display: flex; flex-direction: column; gap: 1rem; }
.top { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0 0 .4rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.lede, .hint, .empty { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .9rem; max-width: 64ch; }
.warn { color: var(--zfy-warning-ink, #8a5a00); margin: 0; font-size: .875rem; max-width: 64ch; }
.pick { display: flex; align-items: flex-end; gap: .5rem; flex-wrap: wrap; }
.pick label { display: flex; flex-direction: column; gap: .2rem; font-size: .75rem; color: var(--zfy-muted, #5a6472); }
.totals { list-style: none; margin: 0; padding: 0; display: flex; gap: .6rem; flex-wrap: wrap; }
.totals li { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .5rem .8rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; min-width: 8rem; }
.totals li:first-child { border-color: var(--zfy-accent, #0f7a64); }
.totals .label { font-size: .7rem; letter-spacing: .06em; text-transform: uppercase; color: var(--zfy-muted, #5a6472); }
.totals strong { font-size: 1.1rem; font-variant-numeric: tabular-nums; }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; background: var(--zfy-surface, #fff); border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: .55rem .75rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); font-size: .9rem; white-space: nowrap; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); }
tbody tr:last-child td { border-bottom: 0; }
tr.row { cursor: pointer; }
tr.row:hover { background: var(--zfy-surface-2, #e9edf1); }
tr.detail td { background: var(--zfy-surface-2, #e9edf1); white-space: normal; }
tr.detail ul { margin: 0; padding-left: 1.1rem; font-size: .85rem; display: flex; flex-direction: column; gap: .15rem; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.sub { color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.tag { font-size: .72rem; padding: .1rem .45rem; border-radius: 4px; background: var(--zfy-surface-2, #e9edf1); }
.tag.exempt { background: var(--zfy-accent-soft, #dff1ec); color: var(--zfy-accent-ink, #0a5a4a); }
.tag.mixed { color: var(--zfy-warning-ink, #8a5a00); }
</style>
