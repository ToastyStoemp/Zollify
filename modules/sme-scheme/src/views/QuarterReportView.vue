<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { COUNTRY_BY_CODE, buildSmeYear, countryCodeOf, fmtRate, receiptDateTime, thresholdRatePairs, thresholdWarnings, type ThresholdWarning } from '@zollify/shared';
import {
  buildSmeReport,
  previousQuarter,
  quarterLabel,
  quarterOf,
  reportCsv,
  schemeApplies,
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
// The quarter to report is usually the one that just ended: its report is the one due next
// (a month after the quarter closes) - unless a link (a tax deadline) names one.
const route = useRoute();
function fromQuery(): QuarterRef | null {
  const y = Number(route.query.year);
  const q = Number(route.query.quarter);
  return Number.isInteger(y) && y > 2000 && [1, 2, 3, 4].includes(q) ? { year: y, quarter: q as Quarter } : null;
}
const selected = ref<QuarterRef>(fromQuery() ?? previousQuarter(now));
/** Shown while the default (last quarter) is up, so an all-zero page is not taken for a broken one. */
const isDueNext = computed(() => selected.value.year === previousQuarter(now).year && selected.value.quarter === previousQuarter(now).quarter);

/**
 * Whether this business has anything to file at all: only once it is on the
 * cross-border scheme (EX number, or exempt in another EU country). A
 * Kleinunternehmer at home alone sees the page but owes no report.
 */
const profile = computed(() => sdk().account()?.profile);
const home = computed(() => countryCodeOf(profile.value?.artist?.countryOfOrigin));
const applies = computed(() => schemeApplies(profile.value, home.value));
watch(() => [route.query.year, route.query.quarter], () => {
  const q = fromQuery();
  if (q) selected.value = q;
});
/** The scheme's due date: the last day of the month after the quarter, filed in the home country. */
const dueBy = computed(() => {
  const { year, quarter: q } = selected.value;
  // Numeric, the way the home country writes it (31/01/2027 in Belgium, 31.01.2027 in Germany): the
  // browser's own locale put US month-first dates here, and a spelled-out month comes out in Dutch.
  return receiptDateTime(new Date(year, q * 3 + 1, 0).getTime(), home.value).date;
});
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
    currency: sdk().account()?.profile.defaultCurrency,
  }),
);
/**
 * Threshold warnings for this calendar year and last: the national ones for
 * each exempt country, and the EU-wide EUR 100,000. A threshold in another
 * currency waits for that rate; without one the country is left out.
 */
const yearNow = new Date().getFullYear();
const yearReports = computed(() => {
  const input = { transactions: transactions.value, eventOf: (id: string) => sdk().data.events.get(id), profile: profile.value, currency: profile.value?.defaultCurrency };
  return { thisYear: buildSmeYear(yearNow, input), lastYear: buildSmeYear(yearNow - 1, input) };
});
const rates = ref(new Map<string, number>());
watch(
  () => thresholdRatePairs([yearReports.value.thisYear, yearReports.value.lastYear], profile.value).map((p) => p.join('>')).join(','),
  async (keys) => {
    for (const key of keys ? keys.split(',') : []) {
      if (rates.value.has(key)) continue;
      const [from, to] = key.split('>') as [string, string];
      const r = await sdk().fx.latest(from, to).catch(() => null);
      if (r) rates.value = new Map(rates.value).set(key, r.rate);
    }
  },
  { immediate: true },
);
const warnings = computed<ThresholdWarning[]>(() =>
  thresholdWarnings({ ...yearReports.value, profile: profile.value, home: home.value, rate: (f, t) => rates.value.get(`${f}>${t}`) ?? null }),
);
const tone = (w: ThresholdWarning): string => (w.level === 'near' || w.level === 'over-year-end' ? 'near' : 'over');

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
  const a = sdk().account();
  const header = { businessName: a?.profile.artist.companyName || a?.profile.artist.fullName || a?.accountName, exNumber: a?.profile.vat?.exNumber };
  await sdk().ui.saveFile(`sme-report-${q.year}-Q${q.quarter}.csv`, reportCsv(report.value, name, header), 'text/csv');
}
</script>

<template>
  <section class="page sme">
    <header>
      <h1>SME report</h1>
      <div class="tools">
        <label class="pick">
          <span>Year</span>
          <select v-model.number="year">
            <option v-for="y in years" :key="y" :value="y">{{ y }}</option>
          </select>
        </label>
        <label class="pick">
          <span>Quarter</span>
          <select v-model.number="quarter">
            <option v-for="q in [1, 2, 3, 4]" :key="q" :value="q">Q{{ q }}</option>
          </select>
        </label>
        <button type="button" :disabled="!report.rows.length" @click="exportCsv">Export CSV</button>
      </div>
    </header>
    <p class="lede">
      What you sold in each country in {{ quarterLabel(selected) }}<template v-if="isDueNext">, the quarter due next</template>:
      exempt sales in full, VAT-charged sales without the VAT. File it in your home country by {{ dueBy }}.
    </p>
    <p v-if="!applies" class="warn" role="note">
      You have no EX number, so there is nothing to file - this report matters once you are exempt in another EU country.
    </p>

    <section v-if="warnings.length" class="thresholds" aria-label="Thresholds">
      <article v-for="w in warnings" :key="`${w.country}-${w.level}`" :class="['tw', tone(w)]" :role="tone(w) === 'over' ? 'alert' : 'note'">
        <strong>{{ w.title }}</strong>
        <div v-if="w.limit" class="bar" aria-hidden="true"><span :style="{ width: `${Math.min(100, w.share * 100)}%` }"></span></div>
        <p>{{ w.text }}</p>
        <p class="src">
          <a :href="w.source" target="_blank" rel="noopener noreferrer">{{ w.country === 'EU' ? 'EU SME scheme rules' : 'Official rules for this country' }}</a>
          <template v-if="w.unverified"> · threshold from published 2026 figures; set your own under Settings → VAT</template>
        </p>
      </article>
    </section>

    <template v-for="t in report.totals" :key="t.currency">
      <h2 v-if="report.totals.length > 1" class="cur">{{ t.currency }}</h2>
      <ul class="stats">
        <li class="lead"><span class="label">To report (EU)</span><strong>{{ fmt(t.euReported, t.currency) }}</strong></li>
        <li><span class="label">To report (all)</span><strong>{{ fmt(t.reported, t.currency) }}</strong></li>
        <li><span class="label">Customers paid</span><strong>{{ fmt(t.gross, t.currency) }}</strong></li>
        <li><span class="label">VAT inside</span><strong>{{ fmt(t.vat, t.currency) }}</strong></li>
        <li><span class="label">Sales</span><strong>{{ t.sales }}</strong></li>
      </ul>
    </template>

    <p v-if="report.estimated" class="warn" role="note">
      {{ report.estimated }} sale{{ report.estimated === 1 ? '' : 's' }} in this quarter {{ report.estimated === 1 ? 'was' : 'were' }}
      made before VAT was recorded on each sale, so {{ report.estimated === 1 ? 'it is' : 'they are' }} judged by the event's
      country and today's VAT settings.
    </p>

    <p v-if="!report.rows.length" class="empty">No sales in {{ quarterLabel(selected) }}.</p>

    <template v-for="group in [{ title: 'EU', rows: eu }, { title: 'Outside the EU', rows: other }]" :key="group.title">
      <div v-if="group.rows.length" class="table-scroll stack">
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
                <td class="wide country"><strong>{{ name(r.country) }}</strong><span v-if="r.country" class="sub"> · {{ r.country }}</span></td>
                <td class="end"><span :class="['tag', r.status]">{{ STATUS[r.status] }}</span></td>
                <td class="num" data-label="Sales">{{ r.sales }}</td>
                <td class="num" data-label="Customers paid">{{ fmt(r.exemptGross + r.chargedGross, r.currency) }}</td>
                <td class="num" data-label="VAT">{{ r.vat ? fmt(r.vat, r.currency) : '-' }}</td>
                <td class="num span reported" data-label="To report"><strong>{{ fmt(r.reported, r.currency) }}</strong></td>
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
h2 { margin: 0 0 .4rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
h2.cur { margin: .4rem 0 -.4rem; }
.warn { color: var(--zfy-warning-ink, #8a5a00); margin: 0; font-size: .875rem; max-width: 64ch; }
.pick { display: flex; flex-direction: column; gap: .2rem; font-size: .75rem; color: var(--zfy-muted, #5a6472); }
th, td { text-align: left; padding: .55rem .75rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); font-size: .9rem; white-space: nowrap; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); }
tbody tr:last-child td { border-bottom: 0; }
tr.row { cursor: pointer; }
tr.row:hover { background: var(--zfy-surface-2, #e9edf1); }
tr.detail td { background: var(--zfy-surface-2, #e9edf1); white-space: normal; }
tr.detail ul { margin: 0; padding-left: 1.1rem; font-size: .85rem; display: flex; flex-direction: column; gap: .15rem; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.sub { color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.tag { font-size: .72rem; padding: .1rem .45rem; border-radius: 4px; background: var(--zfy-surface-2, #e9edf1); white-space: nowrap; }
.tag.exempt { background: var(--zfy-accent-soft, #dff1ec); color: var(--zfy-accent-ink, #0a5a4a); }
.tag.mixed { color: var(--zfy-warning-ink, #8a5a00); }
.thresholds { display: flex; flex-direction: column; gap: .5rem; }
.tw { display: flex; flex-direction: column; gap: .35rem; padding: .7rem .85rem; border-radius: 12px; border: 1px solid var(--zfy-warning, #c08a2e); background: var(--zfy-surface, #fff); }
.tw.over { border-color: var(--zfy-danger, #c6512f); }
.tw strong { font-size: .92rem; color: var(--zfy-warning-ink, #8a5a00); }
.tw.over strong { color: var(--zfy-danger, #c6512f); }
.tw p { margin: 0; font-size: .85rem; }
.tw .src { font-size: .78rem; color: var(--zfy-muted, #5a6472); }
.tw .src a { color: var(--zfy-accent-ink, #0a5a4a); }
.bar { height: 6px; border-radius: 999px; background: var(--zfy-line, #d6dde4); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--zfy-warning, #c08a2e); }
.over .bar span { background: var(--zfy-danger, #c6512f); }
@media (max-width: 720px) {
  /* The selects share a row; Export CSV takes its own underneath, full width. */
  .page > header .tools { flex-basis: 100%; order: 1; }
  .pick { flex: 1; }
  .pick select { width: 100%; }
  .tools > button { flex-basis: 100%; }
  .reported strong { font-size: 1.15rem; }
  tr.row:hover { background: var(--zfy-surface, #fff); }
}
</style>
