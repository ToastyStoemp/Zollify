<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { GIFT_CARD_STATE_LABEL, GiftCardSettingsSchema, fmtPrice, formatGiftCardCode, normaliseGiftCardCode, type GiftCardPeriodRow, type GiftCardSettings, type GiftCardState } from '@zollify/shared';
import { api, balanceHere, errorText, type GiftCardView } from '../api';
import { printCard } from '../print';
import { sdk } from '../runtime';

/**
 * Every card the account issued, what is on each and where the money went;
 * a card can be found by the end of its code or its note. Admins issue a
 * card without a sale, void one, and read the period report the books need.
 */
const cards = ref<GiftCardView[]>([]);
const settings = ref<GiftCardSettings>(GiftCardSettingsSchema.parse({}));
const loaded = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);
const query = ref('');
const tab = ref<'cards' | 'report'>('cards');
const isAdmin = computed(() => sdk().account()?.role !== 'member');
const router = useRouter();
const hasLabelPrinter = computed(() => router.hasRoute('label-printer:index'));
let typing: ReturnType<typeof setTimeout> | undefined;

async function load(): Promise<void> {
  error.value = null;
  try {
    const res = await api.list(query.value.trim());
    cards.value = res.cards;
    settings.value = res.settings;
    if (selected.value) selected.value = cards.value.find((c) => c.id === selected.value!.id) ?? null;
  } catch (err) {
    error.value = errorText(err, 'Could not load gift cards - this needs a connection.');
  } finally {
    loaded.value = true;
  }
}
onMounted(load);
function onQuery(): void {
  clearTimeout(typing);
  typing = setTimeout(load, 250);
}
function flash(msg: string): void {
  notice.value = msg;
  setTimeout(() => { if (notice.value === msg) notice.value = null; }, 4000);
}

// ── List ────────────────────────────────────────────────────────────────────
type Filter = GiftCardState | 'all';
const filter = ref<Filter>('active');
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'unloaded', label: 'Not loaded' },
  { id: 'empty', label: 'Used up' },
  { id: 'expired', label: 'Expired' },
  { id: 'void', label: 'Void' },
  { id: 'all', label: 'All' },
];
const shown = computed(() => cards.value.filter((c) => filter.value === 'all' || c.state === filter.value));
const count = (f: Filter): number => (f === 'all' ? cards.value.length : cards.value.filter((c) => c.state === f).length);
const onCards = computed(() => {
  const by = new Map<string, number>();
  for (const c of cards.value) if (c.state === 'active') by.set(c.currency, (by.get(c.currency) ?? 0) + c.balance);
  return [...by.entries()].map(([currency, amount]) => fmtPrice(amount, currency)).join(' · ');
});
const when = (ms: number): string => new Date(ms).toLocaleDateString();

// ── Detail ──────────────────────────────────────────────────────────────────
const selected = ref<GiftCardView | null>(null);
const noteDraft = ref('');
function select(c: GiftCardView): void {
  selected.value = c;
  noteDraft.value = c.note;
}
async function saveNote(c: GiftCardView): Promise<void> {
  busy.value = true;
  try {
    const next = await api.saveNote(c.id, noteDraft.value);
    cards.value = cards.value.map((x) => (x.id === next.id ? next : x));
    selected.value = next;
    flash('Note saved.');
  } catch (err) {
    error.value = errorText(err, 'Could not save the note.');
  } finally {
    busy.value = false;
  }
}
async function voidCard(c: GiftCardView): Promise<void> {
  const left = balanceHere(c);
  const msg = left > 0 ? `${fmtPrice(left, c.currency)} is still on this card. Voiding it means the holder cannot spend it any more. The sale that sold it stays in the books.` : 'This card will not be usable any more.';
  if (!(await sdk().ui.confirm(msg, 'Void this card?', { confirm: 'Void' }))) return;
  busy.value = true;
  try {
    const next = await api.void(c.id);
    cards.value = cards.value.map((x) => (x.id === next.id ? next : x));
    selected.value = next;
    flash('Card voided.');
  } catch (err) {
    error.value = errorText(err, 'Could not void the card.');
  } finally {
    busy.value = false;
  }
}
function printLabel(c: GiftCardView): void {
  sdk().events.emit('label:print', { title: 'Gift card', subtitle: fmtPrice(c.value, c.currency), caption: formatGiftCardCode(c.code), barcode: normaliseGiftCardCode(c.code) });
}
async function printSheet(c: GiftCardView): Promise<void> {
  if (!(await printCard(c, sdk().account()?.accountName ?? ''))) sdk().ui.toast('The print window was blocked - allow pop-ups for this site.', { kind: 'warning' });
}
/** Only an admin sees whole codes; a masked one cannot be printed. */
const printable = (c: GiftCardView): boolean => !c.code.includes('·');

// ── Issuing without a sale (admins) ─────────────────────────────────────────
const granting = ref(false);
const grant = ref({ value: '', currency: '', note: '' });
const defaultCurrency = computed(() => sdk().data.events.active()?.currency ?? cards.value[0]?.currency ?? 'EUR');
async function doGrant(): Promise<void> {
  error.value = null;
  const value = Number(grant.value.value.replace(',', '.')) || 0;
  if (!(value > 0)) {
    error.value = 'Enter the amount to put on the card.';
    return;
  }
  busy.value = true;
  try {
    const c = await api.grant({ value, currency: (grant.value.currency || defaultCurrency.value).toUpperCase(), note: grant.value.note, granted: true });
    cards.value = [c, ...cards.value];
    granting.value = false;
    grant.value = { value: '', currency: '', note: '' };
    select(c);
    flash(`Card issued with ${fmtPrice(c.value, c.currency)} on it - the code is in the card's details.`);
  } catch (err) {
    error.value = errorText(err, 'Could not issue the card.');
  } finally {
    busy.value = false;
  }
}

// ── Report (admins) ─────────────────────────────────────────────────────────
const iso = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = new Date();
const from = ref(iso(new Date(today.getFullYear(), today.getMonth(), 1)));
const to = ref(iso(today));
const rows = ref<GiftCardPeriodRow[] | null>(null);
const reportError = ref<string | null>(null);
function openReport(): void {
  tab.value = 'report';
  if (!rows.value) void runReport();
}
async function runReport(): Promise<void> {
  reportError.value = null;
  const start = new Date(`${from.value}T00:00:00`).getTime();
  const end = new Date(`${to.value}T00:00:00`).getTime() + 86_400_000;
  if (!(start < end)) {
    reportError.value = 'The period ends before it starts.';
    return;
  }
  try {
    rows.value = (await api.report(start, end)).rows;
  } catch (err) {
    reportError.value = errorText(err, 'Could not run the report.');
  }
}
async function downloadReport(): Promise<void> {
  if (!rows.value) return;
  const csv = ['currency,issued,redeemed,outstanding,lapsed', ...rows.value.map((r) => [r.currency, r.issued, r.redeemed, r.outstanding, r.lapsed].join(','))].join('\n');
  await sdk().ui.saveFile(`gift-cards-${from.value}-${to.value}.csv`, csv, 'text/csv');
}
</script>

<template>
  <div class="gift">
    <header class="top">
      <h1>Gift cards</h1>
      <button v-if="isAdmin" type="button" class="primary" @click="granting = !granting; error = null">Issue without a sale</button>
    </header>
    <div v-if="isAdmin" class="chips tabs" role="tablist" aria-label="View">
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'cards' }" :aria-selected="tab === 'cards'" @click="tab = 'cards'">Cards</button>
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'report' }" :aria-selected="tab === 'report'" @click="openReport">Report</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="ok" role="status">{{ notice }}</p>

    <form v-if="granting && isAdmin" class="card grant" @submit.prevent="doGrant">
      <h2>Issue a card without a sale</h2>
      <p class="hint">For goodwill, a prize, a refund: the value goes on the card right away and no money is taken. It shows in the report as issued.</p>
      <div class="three">
        <label>Amount <input v-model="grant.value" type="text" inputmode="decimal" required /></label>
        <label>Currency <input v-model="grant.currency" type="text" maxlength="3" :placeholder="defaultCurrency" /></label>
        <label>Note (staff only) <input v-model="grant.note" type="text" maxlength="200" /></label>
      </div>
      <div class="actions">
        <button type="submit" class="primary" :disabled="busy">Issue</button>
        <button type="button" @click="granting = false">Cancel</button>
      </div>
    </form>

    <section v-if="tab === 'report'" class="card">
      <h2>What the books need</h2>
      <p class="hint">A card sold is money owed to its holder until it is spent. Issued counts cards sold, topped up and granted in the period; redeemed what was spent; outstanding what is still on cards at the period's end; lapsed what was on cards voided or expired by then.</p>
      <div class="three">
        <label>From <input v-model="from" type="date" /></label>
        <label>To <input v-model="to" type="date" /></label>
        <div class="actions end"><button type="button" class="primary" @click="runReport">Run</button><button type="button" :disabled="!rows?.length" @click="downloadReport">CSV</button></div>
      </div>
      <p v-if="reportError" class="error">{{ reportError }}</p>
      <p v-else-if="rows && !rows.length" class="hint">No gift card movements in this period.</p>
      <table v-else-if="rows" class="table">
        <thead><tr><th>Currency</th><th class="num">Issued</th><th class="num">Redeemed</th><th class="num">Outstanding</th><th class="num">Lapsed</th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.currency">
            <td data-label="Currency">{{ r.currency }}</td>
            <td class="num" data-label="Issued">{{ fmtPrice(r.issued, r.currency) }}</td>
            <td class="num" data-label="Redeemed">{{ fmtPrice(r.redeemed, r.currency) }}</td>
            <td class="num" data-label="Outstanding">{{ fmtPrice(r.outstanding, r.currency) }}</td>
            <td class="num" data-label="Lapsed">{{ fmtPrice(r.lapsed, r.currency) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <div v-else class="layout">
      <section class="list" aria-label="Gift cards">
        <input v-model="query" type="search" placeholder="Last letters of the code, or the note" aria-label="Find a card" @input="onQuery" />
        <div class="chips" role="group" aria-label="Filter by state">
          <button v-for="f in FILTERS" :key="f.id" type="button" class="chip" :class="{ on: filter === f.id }" :aria-pressed="filter === f.id" @click="filter = f.id">{{ f.label }} <small>{{ count(f.id) }}</small></button>
        </div>
        <p v-if="onCards" class="hint">On active cards: {{ onCards }}</p>
        <p v-if="!loaded && !error" class="hint">Loading…</p>
        <p v-else-if="loaded && !shown.length" class="hint">No cards here{{ query ? ' match' : '' }}. Cards are sold from the till - the Gift card button over it.</p>
        <button v-for="c in shown" :key="c.id" type="button" class="row" :class="{ sel: selected?.id === c.id }" @click="select(c)">
          <span class="main"><strong class="mono">{{ c.code }}</strong><span class="hint">{{ c.note || when(c.createdAt) }}</span></span>
          <span class="side"><strong>{{ fmtPrice(balanceHere(c), c.currency) }}</strong><span class="badge" :class="c.state">{{ GIFT_CARD_STATE_LABEL[c.state] }}</span></span>
        </button>
      </section>

      <section v-if="selected" class="detail card" aria-label="Card">
        <div class="dh">
          <div>
            <h2 class="mono">{{ selected.code }}</h2>
            <span class="badge" :class="selected.state">{{ GIFT_CARD_STATE_LABEL[selected.state] }}</span>
          </div>
          <button type="button" class="quiet" @click="selected = null">Close</button>
        </div>
        <dl class="money">
          <dt>On the card</dt><dd><strong>{{ fmtPrice(balanceHere(selected), selected.currency) }}</strong></dd>
          <dt>Loaded</dt><dd>{{ fmtPrice(selected.loaded, selected.currency) }}<template v-if="selected.granted"> ({{ fmtPrice(selected.granted, selected.currency) }} granted)</template></dd>
          <dt>Spent</dt><dd>{{ fmtPrice(selected.redeemed, selected.currency) }}</dd>
          <dt>Issued</dt><dd>{{ when(selected.createdAt) }}</dd>
          <dt>Valid until</dt><dd>{{ selected.expiresAt ? when(selected.expiresAt) : 'no expiry' }}</dd>
          <dt v-if="selected.voidedAt">Voided</dt><dd v-if="selected.voidedAt">{{ when(selected.voidedAt) }}</dd>
        </dl>
        <p v-if="selected.state === 'unloaded'" class="hint">Nothing is on this card yet: the sale that sold it has not reached the server, or was reverted.</p>
        <label>Note (staff only)
          <span class="inline"><input v-model="noteDraft" type="text" maxlength="200" /><button type="button" :disabled="busy || noteDraft === selected.note" @click="saveNote(selected)">Save</button></span>
        </label>
        <h3>Movements</h3>
        <p v-if="!selected.movements.length" class="hint">None yet.</p>
        <ul v-else class="moves">
          <li v-for="m in selected.movements" :key="m.saleId + m.kind">
            <span>{{ when(m.at) }} · {{ m.kind === 'load' ? 'loaded' : 'spent' }}</span>
            <strong :class="{ neg: m.amount < 0 }">{{ fmtPrice(m.amount, selected.currency) }}</strong>
          </li>
        </ul>
        <div class="actions">
          <button v-if="hasLabelPrinter && printable(selected)" type="button" @click="printLabel(selected)">Print label</button>
          <button v-if="printable(selected)" type="button" @click="printSheet(selected)">Print card</button>
          <button v-if="isAdmin && !selected.voidedAt" type="button" class="danger" :disabled="busy" @click="voidCard(selected)">Void card</button>
        </div>
        <p v-if="isAdmin" class="hint">Cards issued now {{ settings.expiryMonths ? `expire after ${settings.expiryMonths} months` : 'never expire' }} and hold at most {{ fmtPrice(settings.maxValue, selected.currency) }} - Settings → Gift cards.</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.gift { display: flex; flex-direction: column; gap: .8rem; }
.top { display: flex; align-items: center; justify-content: space-between; gap: .6rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: 1.1rem; overflow-wrap: anywhere; }
h3 { margin: .4rem 0 0; font-size: .95rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em; }
.layout { display: grid; grid-template-columns: minmax(16rem, 24rem) 1fr; gap: 1rem; align-items: start; }
.list, .detail { display: flex; flex-direction: column; gap: .5rem; min-width: 0; }
.chips { display: flex; gap: .3rem; flex-wrap: wrap; }
.chip { font-size: .78rem; padding: .2rem .6rem; border-radius: 999px; min-height: 0; }
.chip.on { background: var(--zfy-accent, #0e7c66); color: #fff; }
.chip small { opacity: .7; }
.row { display: flex; justify-content: space-between; gap: .6rem; text-align: left; width: 100%; padding: .55rem .7rem; font-weight: 400; min-height: 3rem; }
.row.sel { outline: 2px solid var(--zfy-accent, #0e7c66); }
.main, .side { display: flex; flex-direction: column; gap: .1rem; min-width: 0; }
.main strong { overflow-wrap: anywhere; }
.side { align-items: flex-end; text-align: right; flex: none; }
.badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; border-radius: 999px; padding: .1rem .55rem; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); white-space: nowrap; align-self: flex-start; }
.badge.void, .badge.expired { background: #fee2e2; color: #991b1b; }
.badge.empty { background: #e5e7eb; color: #374151; }
.badge.unloaded { background: #fef3c7; color: #92400e; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .6rem; }
.dh { display: flex; justify-content: space-between; gap: .6rem; align-items: flex-start; }
.dh > div { display: flex; flex-direction: column; gap: .3rem; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .875rem; }
.inline { display: flex; gap: .4rem; }
.inline input { flex: 1; min-width: 0; }
.three { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: .6rem; align-items: end; }
.actions { display: flex; gap: .5rem; flex-wrap: wrap; }
.actions.end { justify-content: flex-start; }
.money { display: grid; grid-template-columns: auto 1fr; gap: .2rem 1rem; margin: 0; font-size: .92rem; }
.money dd { margin: 0; }
.moves { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; font-size: .9rem; }
.moves li { display: flex; justify-content: space-between; gap: .6rem; }
.neg { color: #9a3412; }
.table { width: 100%; border-collapse: collapse; font-size: .92rem; }
.table th, .table td { padding: .4rem .5rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); text-align: left; }
.num { text-align: right; }
.danger { color: var(--zfy-danger, #c6512f); }
@media (max-width: 800px) {
  .layout, .three { grid-template-columns: 1fr; }
  .table thead { display: none; }
  .table tr { display: flex; flex-direction: column; padding: .4rem 0; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
  .table td { display: flex; justify-content: space-between; border: 0; padding: .15rem 0; }
  .table td::before { content: attr(data-label); color: var(--zfy-muted, #5a6472); }
}
</style>
