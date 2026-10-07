<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { FEE_REASONS, fmtPrice, journalCsv, reportCsv, type ArtistInvoice, type BooksSettings, type FeeReason, type ReportPeriod, type StoreReport } from '@zollify/shared';
import { Icon, ModalShell } from '@zollify/ui';
import { errorText, issueInvoices, loadInvoices, loadReport, loadReports, payReport, paymentFile, saveBooksSettings, today } from '../api';
import { sdk } from '../runtime';

/**
 * The store's report, every two weeks or every month: what sold, what
 * discounts cost, the VAT in it, what cards cost, the store's commission -
 * and what each artist is owed at the end of the period, ready to pay out.
 * When a period closes the owner gets it by email with the spreadsheet.
 */
const emit = defineEmits<{ error: [message: string | null] }>();

const settings = ref<BooksSettings | null>(null);
const periods = ref<ReportPeriod[]>([]);
const from = ref('');
const report = ref<StoreReport | null>(null);
const venues = ref<Record<string, string>>({});
const loading = ref(false);
const invoices = ref<ArtistInvoice[]>([]);

async function loadList(): Promise<void> {
  const res = await loadReports();
  settings.value = res.settings;
  periods.value = res.periods;
  if (!periods.value.some((p) => p.from === from.value)) from.value = periods.value[0]?.from ?? '';
}
async function loadOne(): Promise<void> {
  if (!from.value) return;
  loading.value = true;
  try {
    const res = await loadReport(from.value);
    report.value = res.report;
    venues.value = res.venues;
    picked.value = new Set(res.report.artists.filter((a) => a.balance > 0).map((a) => a.consignorId));
    invoices.value = await loadInvoices(from.value);
  } catch (err) {
    emit('error', errorText(err, 'Could not load the report.'));
  } finally {
    loading.value = false;
  }
}
onMounted(async () => {
  try {
    await loadList();
  } catch (err) {
    emit('error', errorText(err, 'Could not load reports.'));
  }
});
watch(from, loadOne);

const fmtDay = (d: string): string => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const label = (p: ReportPeriod, i: number): string => `${fmtDay(p.from)} - ${fmtDay(p.to)}${i === 0 ? ' (current)' : ''}`;
const isOpen = computed(() => report.value != null && report.value.period.to >= today());
const venueName = (id: string): string => venues.value[id] ?? id;

async function download(): Promise<void> {
  if (!report.value) return;
  await sdk().ui.saveFile(`report-${report.value.period.from}.csv`, reportCsv(report.value, venueName), 'text/csv');
}

// ── Paying out ──────────────────────────────────────────────────────────────
const picked = ref(new Set<string>());
const owed = computed(() => report.value?.artists.filter((a) => a.balance > 0) ?? []);
function toggle(id: string): void {
  const next = new Set(picked.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  picked.value = next;
}
const payDate = ref(today());
async function payOut(): Promise<void> {
  if (!report.value || !picked.value.size) return;
  const rows = owed.value.filter((a) => picked.value.has(a.consignorId));
  const sum = rows.map((a) => fmtPrice(a.balance, a.currency)).join(', ');
  if (!(await sdk().ui.confirm(`Records payouts to ${rows.length} artist${rows.length === 1 ? '' : 's'} (${sum}), dated ${payDate.value}. Move the money however you pay artists.`, 'Record payouts?'))) return;
  try {
    const { payouts } = await payReport(report.value.period.from, payDate.value, [...picked.value]);
    sdk().ui.toast(payouts.length ? `${payouts.length} payout${payouts.length === 1 ? '' : 's'} recorded.` : 'Nothing left to pay - those were paid already.', { kind: 'success' });
    await loadOne();
  } catch (err) {
    emit('error', errorText(err, 'Could not record the payouts.'));
  }
}

// ── Invoices, payment file, bookkeeping ─────────────────────────────────────
async function issue(): Promise<void> {
  if (!report.value) return;
  try {
    invoices.value = await issueInvoices(report.value.period.from);
    sdk().ui.toast(`${invoices.value.length} invoice${invoices.value.length === 1 ? '' : 's'} on record.`, { kind: 'success' });
  } catch (err) {
    emit('error', errorText(err, 'Could not issue the invoices.'));
  }
}
async function downloadJournal(): Promise<void> {
  if (!report.value || !settings.value) return;
  await sdk().ui.saveFile(`journal-${report.value.period.from}.csv`, journalCsv(invoices.value, settings.value.accounting), 'text/csv');
}
async function downloadPayments(): Promise<void> {
  if (!report.value) return;
  try {
    const res = await paymentFile(report.value.period.from, payDate.value, picked.value.size ? [...picked.value] : undefined);
    if (res.xml && res.filename) await sdk().ui.saveFile(res.filename, res.xml, 'application/xml');
    const left = res.skipped.map((s) => `${s.name} (${s.reason})`).join(', ');
    if (!res.xml) emit('error', left ? `No file made. ${left}` : 'Nothing is owed.');
    else if (left) emit('error', `File made without: ${left}`);
    else sdk().ui.toast(`Payment file for ${res.included.length} artist${res.included.length === 1 ? '' : 's'}. Upload it in your bank, then record the payouts here.`, { kind: 'success' });
  } catch (err) {
    emit('error', errorText(err, 'Could not make the payment file.'));
  }
}

// ── Settings ────────────────────────────────────────────────────────────────
const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [deviceZone, 'UTC'];
  } catch {
    return [deviceZone, 'UTC'];
  }
})();
const editing = ref(false);
const form = reactive({
  reportPeriod: 'monthly' as BooksSettings['reportPeriod'],
  biweeklyAnchor: '2024-01-01',
  timeZone: 'UTC',
  emailReport: true,
  cardFeePct: '' as string | number,
  cardFeeFixed: '' as string | number,
  passCardFees: false,
  presets: {} as Record<string, string | number>,
  artistDiscounts: true,
  artistDiscountMaxPct: 30 as string | number,
  accounting: { payerName: '', payerIban: '', payerBic: '', invoicePrefix: 'SB', accountArtistPayable: '', accountCommission: '', accountFees: '', accountRent: '', accountCardCosts: '' } as BooksSettings['accounting'],
});
const formError = ref<string | null>(null);
const reasons = Object.entries(FEE_REASONS) as [FeeReason, string][];
function openSettings(): void {
  const s = settings.value!;
  Object.assign(form, {
    reportPeriod: s.reportPeriod,
    biweeklyAnchor: s.biweeklyAnchor,
    // A store that never set it is almost certainly where its owner is.
    timeZone: s.timeZone === 'UTC' && deviceZone ? deviceZone : s.timeZone,
    emailReport: s.emailReport,
    cardFeePct: s.cardFeePct || '',
    cardFeeFixed: s.cardFeeFixed || '',
    passCardFees: s.passCardFees,
    presets: Object.fromEntries(reasons.map(([id]) => [id, s.feePresets[id] ?? ''])),
    artistDiscounts: s.artistDiscounts,
    artistDiscountMaxPct: s.artistDiscountMaxPct,
    accounting: { ...s.accounting },
  });
  formError.value = null;
  editing.value = true;
}
const num = (v: string | number): number => Math.max(0, Number(v) || 0);
async function saveSettings(): Promise<void> {
  try {
    const presets = Object.fromEntries(Object.entries(form.presets).filter(([, v]) => num(v) > 0).map(([k, v]) => [k, num(v)]));
    const res = await saveBooksSettings({
      reportPeriod: form.reportPeriod,
      biweeklyAnchor: form.biweeklyAnchor,
      timeZone: form.timeZone.trim(),
      emailReport: form.emailReport,
      cardFeePct: num(form.cardFeePct),
      cardFeeFixed: num(form.cardFeeFixed),
      passCardFees: form.passCardFees,
      feePresets: presets,
      artistDiscounts: form.artistDiscounts,
      artistDiscountMaxPct: Math.min(100, Math.max(1, num(form.artistDiscountMaxPct) || 30)),
      accounting: { ...form.accounting },
    });
    settings.value = res.settings;
    editing.value = false;
    await loadList();
    await loadOne();
  } catch (err) {
    formError.value = errorText(err, 'Could not save the settings.');
  }
}
const accountCurrency = computed(() => sdk().account()?.profile.defaultCurrency ?? '');
</script>

<template>
  <div class="tab">
    <div class="bar">
      <label class="period">
        <span class="sr">Period</span>
        <select v-model="from">
          <option v-for="(p, i) in periods" :key="p.from" :value="p.from">{{ label(p, i) }}</option>
        </select>
      </label>
      <span class="hint" v-if="settings">{{ settings.reportPeriod === 'monthly' ? 'Monthly' : 'Every two weeks' }}<template v-if="settings.emailReport"> · emailed when a period closes</template></span>
      <span class="grow" />
      <button type="button" :disabled="!settings" @click="openSettings"><Icon name="settings" :size="14" /> Settings</button>
      <button type="button" :disabled="!report" @click="download"><Icon name="download" :size="14" /> Spreadsheet</button>
    </div>

    <p v-if="!report && loading" class="hint">Loading…</p>
    <template v-if="report">
      <p v-if="isOpen" class="hint">This period is still running - the numbers grow until {{ fmtDay(report.period.to) }}.</p>
      <p v-if="!report.totals.length" class="empty">No sales in this period.</p>

      <section v-for="t in report.totals" :key="t.currency" class="card">
        <h2>Sales<template v-if="report.totals.length > 1"> in {{ t.currency }}</template></h2>
        <div class="tiles">
          <div><span>Sales</span><strong>{{ t.sales }}</strong><small>{{ t.units }} items</small></div>
          <div><span>Takings</span><strong>{{ fmtPrice(t.gross, t.currency) }}</strong><small>VAT included</small></div>
          <div><span>Discounts</span><strong>{{ fmtPrice(t.discounts, t.currency) }}</strong></div>
          <div><span>VAT</span><strong>{{ fmtPrice(t.vat, t.currency) }}</strong><small>net {{ fmtPrice(t.net, t.currency) }}</small></div>
          <div><span>Cash</span><strong>{{ fmtPrice(t.cash, t.currency) }}</strong></div>
          <div><span>Card</span><strong>{{ fmtPrice(t.card, t.currency) }}</strong><small v-if="t.other">other {{ fmtPrice(t.other, t.currency) }}</small></div>
          <div v-if="t.cardFees"><span>Card costs</span><strong>{{ fmtPrice(t.cardFees, t.currency) }}</strong><small v-if="t.cardFeesPassed">{{ fmtPrice(t.cardFeesPassed, t.currency) }} on artists</small></div>
          <div><span>Artists' work</span><strong>{{ fmtPrice(t.consigned, t.currency) }}</strong><small>theirs {{ fmtPrice(t.artistShare, t.currency) }}</small></div>
          <div class="keep"><span>Commission</span><strong>{{ fmtPrice(t.commission, t.currency) }}</strong></div>
          <div><span>Own stock</span><strong>{{ fmtPrice(t.own, t.currency) }}</strong></div>
        </div>
        <p v-if="!t.cardFees && t.card" class="hint">Card costs are not counted - set your terminal's rate under Settings.</p>
      </section>

      <section v-if="report.artists.length" class="card">
        <div class="head">
          <h2>Artists</h2>
          <span class="grow" />
          <template v-if="owed.length">
            <label class="inline"><span>Paid on</span><input v-model="payDate" type="date" /></label>
            <button type="button" class="primary" :disabled="!picked.size" @click="payOut"><Icon name="banknote" :size="14" /> Record {{ picked.size }} payout{{ picked.size === 1 ? '' : 's' }}</button>
          </template>
        </div>
        <div class="scroll">
          <table class="artists">
            <thead>
              <tr>
                <th></th><th>Artist</th><th class="num">Sold</th><th class="num">Commission</th><th class="num">Share</th>
                <th class="num">Card</th><th class="num">Rent</th><th class="num">Fees</th><th class="num">Earned</th><th class="num">Paid</th><th class="num">Owed</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in report.artists" :key="`${a.consignorId}|${a.currency}`">
                <td><input v-if="a.balance > 0" type="checkbox" :checked="picked.has(a.consignorId)" :aria-label="`Pay ${a.name}`" @change="toggle(a.consignorId)" /></td>
                <td class="who">{{ a.name }}<small v-if="a.units">{{ a.units }} item{{ a.units === 1 ? '' : 's' }}</small></td>
                <td class="num">{{ fmtPrice(a.gross, a.currency) }}</td>
                <td class="num">{{ fmtPrice(a.commission, a.currency) }}</td>
                <td class="num">{{ fmtPrice(a.artistShare, a.currency) }}</td>
                <td class="num">{{ a.cardFees ? fmtPrice(a.cardFees, a.currency) : '-' }}</td>
                <td class="num">{{ a.rent ? fmtPrice(a.rent, a.currency) : '-' }}</td>
                <td class="num">{{ a.fees ? fmtPrice(a.fees, a.currency) : '-' }}</td>
                <td class="num">{{ fmtPrice(a.earned, a.currency) }}</td>
                <td class="num">{{ a.paid ? fmtPrice(a.paid, a.currency) : '-' }}</td>
                <td :class="['num', 'bal', { due: a.balance > 0, neg: a.balance < 0 }]">{{ fmtPrice(a.balance, a.currency) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="head">
          <h2>Bookkeeping</h2>
          <span class="grow" />
          <button type="button" :disabled="isOpen" :title="isOpen ? 'Invoice a period once it has closed' : ''" @click="issue"><Icon name="file-text" :size="14" /> Issue invoices</button>
          <button type="button" :disabled="!invoices.length" @click="downloadJournal"><Icon name="download" :size="14" /> Journal CSV</button>
          <button type="button" :disabled="!owed.length" @click="downloadPayments"><Icon name="banknote" :size="14" /> Bank payment file</button>
        </div>
        <p v-if="invoices.length" class="hint">{{ invoices.length }} invoice{{ invoices.length === 1 ? '' : 's' }} issued: {{ invoices[0]!.number }}<template v-if="invoices.length > 1"> to {{ invoices[invoices.length - 1]!.number }}</template>. Issued invoices never change. The payment file (ISO 20022 pain.001) uses the invoice number as each transfer's reference, so the bank statement matches back to it.</p>
        <p class="hint">Earned is the period's share less card costs, rent and fees. Owed is everything unpaid as of {{ fmtDay(report.period.to) }} - what a payout settles. Paying never pays the same money twice.</p>
      </section>

      <div class="cols">
        <section v-if="report.byStore.length > 1" class="card">
          <h2>By store</h2>
          <table>
            <thead><tr><th>Store</th><th class="num">Sales</th><th class="num">Takings</th><th class="num">Commission</th><th class="num">Own stock</th></tr></thead>
            <tbody>
              <tr v-for="s in report.byStore" :key="`${s.storeId}|${s.currency}`">
                <td>{{ venueName(s.storeId) }}</td><td class="num">{{ s.sales }}</td><td class="num">{{ fmtPrice(s.gross, s.currency) }}</td><td class="num">{{ fmtPrice(s.commission, s.currency) }}</td><td class="num">{{ fmtPrice(s.own, s.currency) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section v-if="report.vat.length" class="card">
          <h2>VAT</h2>
          <table>
            <thead><tr><th>Rate</th><th class="num">Gross</th><th class="num">Net</th><th class="num">VAT</th></tr></thead>
            <tbody>
              <tr v-for="v in report.vat" :key="`${v.currency}|${v.rate}`">
                <td>{{ v.rate }}%</td><td class="num">{{ fmtPrice(v.gross, v.currency) }}</td><td class="num">{{ fmtPrice(v.net, v.currency) }}</td><td class="num">{{ fmtPrice(v.vat, v.currency) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section v-if="report.discountsByName.length" class="card">
          <h2>Discounts</h2>
          <table>
            <tbody>
              <tr v-for="d in report.discountsByName" :key="`${d.name}|${d.currency}`">
                <td>{{ d.name }}</td><td class="num hint">{{ d.sales }} sale{{ d.sales === 1 ? '' : 's' }}</td><td class="num">{{ fmtPrice(d.amount, d.currency) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </template>

    <ModalShell v-if="editing" title="Reports, fees and discounts" @close="editing = false">
      <div class="form">
        <p v-if="formError" class="error" role="alert">{{ formError }}</p>
        <fieldset>
          <legend>Report</legend>
          <div class="two">
            <label>
              <span>Every</span>
              <select v-model="form.reportPeriod"><option value="monthly">Month</option><option value="biweekly">Two weeks</option></select>
            </label>
            <label v-if="form.reportPeriod === 'biweekly'"><span>Starting</span><input v-model="form.biweeklyAnchor" type="date" /></label>
          </div>
          <label><span>Time zone</span><input v-model="form.timeZone" type="text" list="zfy-zones" /><small class="hint">Decides which day a late sale counts on.</small></label>
          <label class="check"><input v-model="form.emailReport" type="checkbox" /> Email me the report with the spreadsheet when a period closes</label>
        </fieldset>
        <fieldset>
          <legend>Card costs</legend>
          <div class="two">
            <label><span>Percent per card payment</span><input v-model="form.cardFeePct" type="number" min="0" max="20" step="0.01" inputmode="decimal" placeholder="1.5" /></label>
            <label><span>Plus per payment<template v-if="accountCurrency"> ({{ accountCurrency }})</template></span><input v-model="form.cardFeeFixed" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.20" /></label>
          </div>
          <label class="check"><input v-model="form.passCardFees" type="checkbox" /> Artists carry their part of card costs on their own sales</label>
          <small class="hint">Their part follows the split: on a sale where the artist gets 60%, they carry 60% of what the card cost.</small>
        </fieldset>
        <fieldset>
          <legend>Artists' discounts</legend>
          <label class="check"><input v-model="form.artistDiscounts" type="checkbox" /> Linked artists may put their own work on discount</label>
          <label v-if="form.artistDiscounts"><span>At most (% off)</span><input v-model="form.artistDiscountMaxPct" type="number" min="1" max="100" inputmode="decimal" /></label>
          <small class="hint">Their discounts show under Discounts, where you can end one. Switching this off ends the ones running.</small>
        </fieldset>
        <fieldset>
          <legend>Bookkeeping and payments</legend>
          <div class="two">
            <label><span>Pay from - account name</span><input v-model="form.accounting.payerName" type="text" /></label>
            <label><span>Invoice prefix</span><input v-model="form.accounting.invoicePrefix" type="text" maxlength="8" /></label>
          </div>
          <div class="two">
            <label><span>Pay from - IBAN</span><input v-model="form.accounting.payerIban" type="text" autocomplete="off" /></label>
            <label><span>BIC</span><input v-model="form.accounting.payerBic" type="text" autocomplete="off" placeholder="Optional" /></label>
          </div>
          <div class="two">
            <label><span>Account: owed to artists</span><input v-model="form.accounting.accountArtistPayable" type="text" /></label>
            <label><span>Account: commission</span><input v-model="form.accounting.accountCommission" type="text" /></label>
          </div>
          <div class="two">
            <label><span>Account: fees</span><input v-model="form.accounting.accountFees" type="text" /></label>
            <label><span>Account: rent</span><input v-model="form.accounting.accountRent" type="text" /></label>
          </div>
          <label><span>Account: card costs</span><input v-model="form.accounting.accountCardCosts" type="text" /></label>
          <small class="hint">Account numbers are the ones in your bookkeeping package's chart (e-conomic and the like); they fill the journal CSV's Account columns.</small>
        </fieldset>
        <fieldset>
          <legend>Usual fees</legend>
          <small class="hint">Filled in when you charge a fee for that reason; you can still change it each time.</small>
          <div class="presets">
            <label v-for="[id, text] in reasons" :key="id"><span>{{ text }}</span><input v-model="form.presets[id]" type="number" min="0" step="0.5" inputmode="decimal" placeholder="-" /></label>
          </div>
        </fieldset>
      </div>
      <template #footer>
        <div class="footer">
          <button type="button" @click="editing = false">Cancel</button>
          <button type="button" class="primary" @click="saveSettings">Save</button>
        </div>
      </template>
    </ModalShell>
    <datalist id="zfy-zones"><option v-for="z in zones" :key="z" :value="z" /></datalist>
  </div>
</template>

<style scoped>
.tab { display: flex; flex-direction: column; gap: .8rem; }
.bar, .head { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.bar button, .head button { min-height: 2.2rem; display: inline-flex; align-items: center; gap: .35rem; font-size: .8rem; }
.period select { min-height: 2.2rem; }
.grow { flex: 1; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .82rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.card { display: flex; flex-direction: column; gap: .6rem; padding: .9rem 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); min-width: 0; }
h2 { margin: 0; font-size: 1rem; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: .5rem; }
.tiles div { display: flex; flex-direction: column; gap: .1rem; padding: .5rem .65rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); }
.tiles span { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.tiles strong { font-variant-numeric: tabular-nums; font-size: 1.02rem; }
.tiles small { font-size: .74rem; color: var(--zfy-muted, #5a6472); }
.tiles .keep { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: .8rem; align-items: start; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .84rem; }
th, td { padding: .35rem .5rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); text-align: left; }
th { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); font-weight: 600; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.artists th, .artists td { padding: .35rem .35rem; }
.artists td { font-size: .8rem; }
.who { min-width: 7rem; }
.who small { display: block; font-size: .72rem; color: var(--zfy-muted, #5a6472); }
.bal { font-weight: 600; }
.bal.due { color: var(--zfy-accent-ink, #0a5a4a); }
.bal.neg { color: var(--zfy-danger, #c6512f); }
.inline { display: flex; align-items: center; gap: .4rem; font-size: .82rem; }
.form { display: flex; flex-direction: column; gap: .8rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem .8rem; display: flex; flex-direction: column; gap: .55rem; margin: 0; }
legend { font-size: .78rem; font-weight: 600; padding: 0 .3rem; }
.form label { display: flex; flex-direction: column; gap: .25rem; font-size: .86rem; }
.form label.check { flex-direction: row; align-items: center; gap: .45rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.presets { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .5rem; }
.footer { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
