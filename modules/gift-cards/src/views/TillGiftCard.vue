<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { GIFT_CARD_LOAD_REF_KIND, GIFT_CARD_REDEEM_REF_KIND, GiftCardSettingsSchema, fmtPrice, formatGiftCardCode, giftCardRefusal, isGiftCardCode, normaliseGiftCardCode, round2 } from '@zollify/shared';
import { api, balanceHere, errorText, type GiftCardView } from '../api';
import { sdk } from '../runtime';
import { decideRedeem, decideSell, suggestedRedeem } from '../till-line';
import { printCard } from '../print';

/**
 * Over the till: take a gift card as payment, sell a new one, or top one up.
 *
 * Spending goes in the cart as a settling line pointing at the card - the
 * till takes it off the total, no VAT, no discount - and selling or topping
 * up as a VAT-free line pointing at it; what is on the card is worked out
 * from those sales afterwards, so a refund puts the money back.
 */
const emit = defineEmits<{ close: [] }>();

const event = computed(() => sdk().data.events.active());
const currency = computed(() => event.value?.currency ?? 'EUR');
const tillTotal = (): number | null => sdk().till.total?.() ?? null;
const error = ref<string | null>(null);
const busy = ref(false);
const maxValue = ref(GiftCardSettingsSchema.parse({}).maxValue);
// With something in the sale the card is most likely being spent; with nothing, sold.
const mode = ref<'redeem' | 'sell'>((tillTotal() ?? 0) > 0 ? 'redeem' : 'sell');
const num = (s: string): number => round2(Number(s.replace(',', '.')) || 0);
const shortName = (c: GiftCardView): string => `Gift card …${normaliseGiftCardCode(c.code).slice(-4)}`;

onMounted(async () => {
  try {
    maxValue.value = (await api.settings()).maxValue;
  } catch {
    /* the server checks the limit too */
  }
});

// ── Spending (and topping up) a card ────────────────────────────────────────
const code = ref('');
const card = ref<GiftCardView | null>(null);
const amount = ref('');
const topUp = ref(false);
const balance = computed(() => (card.value ? balanceHere(card.value) : 0));
const refusal = computed(() => (card.value ? giftCardRefusal(card.value.state) : null));
const inCart = computed(() => (card.value ? sdk().till.findLine(`gift-card:redeem:${card.value.id}`)?.unitPrice ?? null : null));

async function find(): Promise<void> {
  error.value = null;
  if (!isGiftCardCode(code.value)) {
    error.value = 'That is not a gift card code - it starts with ZG and has 16 more characters.';
    return;
  }
  busy.value = true;
  try {
    card.value = await api.lookup(code.value);
    topUp.value = false;
    amount.value = String(suggestedRedeem({ balance: balanceHere(card.value), tillTotal: tillTotal(), inCart: inCart.value }) || '');
  } catch (err) {
    card.value = null;
    error.value = errorText(err, 'Could not look the card up - this needs a connection.');
  } finally {
    busy.value = false;
  }
}

async function redeem(c: GiftCardView): Promise<void> {
  error.value = null;
  const key = `gift-card:redeem:${c.id}`;
  const line = { key, name: shortName(c), qty: 1, unitPrice: num(amount.value) };
  const decision = decideRedeem({ amount: line.unitPrice, balance: balance.value, refusal: refusal.value, cardCurrency: c.currency, tillCurrency: currency.value, tillTotal: tillTotal(), inCart: inCart.value });
  if (decision.kind === 'invalid' || decision.kind === 'blocked') {
    error.value = decision.message;
    return;
  }
  if (decision.kind === 'unchanged') {
    sdk().ui.toast(decision.message);
    emit('close');
    return;
  }
  if (decision.kind === 'replace') {
    if (!(await sdk().ui.confirm(decision.message, decision.title, { confirm: decision.confirm }))) return;
    if (!sdk().till.replaceLine(line)) error.value = 'That line is no longer in the sale. Add it again.';
    else emit('close');
    return;
  }
  if (!sdk().till.addLine({ ...line, settles: true, ref: { kind: GIFT_CARD_REDEEM_REF_KIND, id: c.id } })) {
    error.value = 'Open the till for an event or store first.';
    return;
  }
  emit('close');
}

/** More money on a card the customer already has: a VAT-free line, like selling one. */
function load(c: GiftCardView): void {
  error.value = null;
  if (c.currency !== currency.value) {
    error.value = `This card is in ${c.currency}, but the till is working in ${currency.value}.`;
    return;
  }
  if (c.state === 'void' || c.state === 'expired') {
    error.value = giftCardRefusal(c.state);
    return;
  }
  const value = num(amount.value);
  const decision = decideSell({ amount: value, maxValue: maxValue.value, currency: currency.value });
  if (decision.kind === 'invalid') {
    error.value = decision.message;
    return;
  }
  const key = `gift-card:load:${c.id}`;
  const line = { key, name: `${shortName(c)} top-up`, qty: 1, unitPrice: value, taxFree: true };
  if (sdk().till.findLine(key)) {
    if (!sdk().till.replaceLine(line)) error.value = 'That line is no longer in the sale. Add it again.';
    else emit('close');
    return;
  }
  if (!sdk().till.addLine({ ...line, ref: { kind: GIFT_CARD_LOAD_REF_KIND, id: c.id } })) {
    error.value = 'Open the till for an event or store first.';
    return;
  }
  emit('close');
}

// ── Selling a new card ──────────────────────────────────────────────────────
const value = ref('');
const note = ref('');
const sold = ref<GiftCardView | null>(null);
const QUICK = [10, 20, 25, 50, 100];

async function sell(): Promise<void> {
  error.value = null;
  const v = num(value.value);
  const decision = decideSell({ amount: v, maxValue: maxValue.value, currency: currency.value });
  if (decision.kind === 'invalid') {
    error.value = decision.message;
    return;
  }
  if (!sdk().data.events.active()) {
    error.value = 'Open the till for an event or store first.';
    return;
  }
  busy.value = true;
  try {
    const c = await api.create({ value: v, currency: currency.value, note: note.value, granted: false });
    // Nothing is on the card until this line is paid for and synced.
    if (!sdk().till.addLine({ key: `gift-card:load:${c.id}`, name: shortName(c), qty: 1, unitPrice: v, taxFree: true, ref: { kind: GIFT_CARD_LOAD_REF_KIND, id: c.id } })) {
      error.value = 'The card was issued but the till is not open - open it and sell the card from Gift cards.';
      return;
    }
    sold.value = c;
  } catch (err) {
    error.value = errorText(err, 'Could not issue the card - this needs a connection.');
  } finally {
    busy.value = false;
  }
}

const router = useRouter();
const hasLabelPrinter = computed(() => router.hasRoute('label-printer:index'));
function printLabel(c: GiftCardView): void {
  sdk().events.emit('label:print', { title: 'Gift card', subtitle: fmtPrice(c.value, c.currency), caption: formatGiftCardCode(c.code), barcode: normaliseGiftCardCode(c.code) });
}
async function printSheet(c: GiftCardView): Promise<void> {
  if (!(await printCard(c, sdk().account()?.accountName ?? ''))) sdk().ui.toast('The print window was blocked - allow pop-ups for this site.', { kind: 'warning' });
}
</script>

<template>
  <div class="till-gift">
    <div v-if="!sold" class="kinds" role="tablist" aria-label="What to do">
      <button type="button" role="tab" :class="{ on: mode === 'redeem' }" :aria-selected="mode === 'redeem'" @click="mode = 'redeem'; error = null">Take as payment</button>
      <button type="button" role="tab" :class="{ on: mode === 'sell' }" :aria-selected="mode === 'sell'" @click="mode = 'sell'; error = null">Sell a card</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <template v-if="sold">
      <p class="ok">Card issued for {{ fmtPrice(sold.value, sold.currency) }} - it is in the sale and works once the sale is paid.</p>
      <p class="code" aria-label="Card code">{{ sold.code }}</p>
      <p class="hint">Write the code on the card or print it. The customer needs it to spend the card.</p>
      <div class="actions">
        <button v-if="hasLabelPrinter" type="button" @click="printLabel(sold)">Print label</button>
        <button type="button" @click="printSheet(sold)">Print card</button>
        <button type="button" class="primary" @click="emit('close')">Done</button>
      </div>
    </template>

    <form v-else-if="mode === 'sell'" class="stack" @submit.prevent="sell">
      <div class="quick" role="group" aria-label="Amount">
        <button v-for="q in QUICK" :key="q" type="button" :class="{ on: num(value) === q }" @click="value = String(q)">{{ fmtPrice(q, currency) }}</button>
      </div>
      <label>Amount ({{ currency }}) <input v-model="value" type="text" inputmode="decimal" autocomplete="off" /></label>
      <label>Note (staff only) <input v-model="note" type="text" maxlength="200" placeholder="For whom, an occasion" /></label>
      <p class="hint">Up to {{ fmtPrice(maxValue, currency) }} per card. Sold without VAT - VAT is charged on what it is spent on.</p>
      <div class="actions">
        <button type="submit" class="primary" :disabled="busy">Add to the sale</button>
      </div>
    </form>

    <template v-else>
      <form class="find" @submit.prevent="find">
        <input v-model="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Scan or type the code (ZG-…)" aria-label="Card code" autofocus />
        <button type="submit" :disabled="busy">Look up</button>
      </form>
      <template v-if="card">
        <header class="head">
          <strong>{{ card.code }}</strong>
          <span class="hint">{{ fmtPrice(balance, card.currency) }} on the card<template v-if="card.note"> · {{ card.note }}</template><template v-if="card.expiresAt"> · valid until {{ new Date(card.expiresAt).toLocaleDateString() }}</template></span>
          <span v-if="refusal" class="error">{{ refusal }}</span>
        </header>
        <div class="kinds" role="group" aria-label="Take or top up">
          <button type="button" :class="{ on: !topUp }" :disabled="!!refusal" @click="topUp = false; amount = String(suggestedRedeem({ balance, tillTotal: tillTotal(), inCart }) || '')">Take from card</button>
          <button type="button" :class="{ on: topUp }" @click="topUp = true; amount = ''">Top up</button>
        </div>
        <label>Amount ({{ card.currency }}) <input v-model="amount" type="text" inputmode="decimal" autocomplete="off" /></label>
        <div class="actions">
          <button v-if="topUp" type="button" class="primary" @click="load(card)">Add top-up to the sale</button>
          <button v-else type="button" class="primary" :disabled="!!refusal" @click="redeem(card)">Take from card</button>
          <button type="button" @click="card = null; code = ''">Another card</button>
        </div>
      </template>
      <p v-else class="hint">A handheld scanner types the code and presses Enter. Topping up a card the customer already has is here too.</p>
    </template>
  </div>
</template>

<style scoped>
.till-gift { display: flex; flex-direction: column; gap: .7rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); }
.head { display: flex; flex-direction: column; gap: .15rem; }
.kinds, .actions, .quick { display: flex; gap: .4rem; flex-wrap: wrap; }
.kinds .on, .quick .on { background: var(--zfy-accent, #0e7c66); color: #fff; }
.find { display: flex; gap: .4rem; }
.find input { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em; }
.code { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.3rem; font-weight: 700; letter-spacing: .06em; overflow-wrap: anywhere; user-select: all; }
.stack { display: flex; flex-direction: column; gap: .6rem; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .875rem; }
</style>
