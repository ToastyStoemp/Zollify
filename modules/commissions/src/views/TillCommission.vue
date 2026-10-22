<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { COMMISSION_REF_KIND, CommissionCreateSchema, DEFAULT_KEEP_CUSTOMER_DAYS, fmtPrice, isClosedStatus, round2 } from '@zollify/shared';
import { api, errorText, pendingPaid, type CommissionView } from '../api';
import { QrCode } from '@zollify/ui';
import { choiceOf, customerFields, duplicatesIn, emptyChoice, quickCustomer, type CustomerChoice, type CustomerContact } from '../customer-form';
import { sdk } from '../runtime';
import CustomerPicker from './CustomerPicker.vue';
import { decideCharge } from '../till-line';

/**
 * Over the till: take a deposit or the final balance for a commission, or
 * start a new one - a title and a price, a name and email if the customer
 * gives them - then turn the screen round so they scan the code to follow it,
 * and take the deposit. The amount goes in the cart as an
 * ordinary free-price sale line pointing at the commission, so the card
 * terminal, receipt, VAT and cash-up all work as for any sale; what is paid is
 * worked out from those sales afterwards, so a refund puts the balance back.
 */
const emit = defineEmits<{ close: [] }>();
/** Set when the till was opened from a commission's page: that commission, picked already. */
const props = defineProps<{ focus?: string }>();

const items = ref<CommissionView[] | null>(null);
const keepDays = ref(DEFAULT_KEEP_CUSTOMER_DAYS);
const emailEnabled = ref(false);
const error = ref<string | null>(null);
const query = ref('');
const event = computed(() => sdk().data.events.active());
const currency = computed(() => event.value?.currency ?? 'EUR');

async function load(): Promise<void> {
  try {
    const res = await api.list();
    items.value = res.commissions.filter((c) => !isClosedStatus(c.status));
    keepDays.value = res.settings.keepCustomerDays;
    emailEnabled.value = res.emailEnabled;
    if (props.focus) {
      const picked = res.commissions.find((c) => c.id === props.focus);
      if (!picked) error.value = 'That commission is no longer there - pick another below.';
      else if (isClosedStatus(picked.status)) error.value = `"${picked.title}" is ${picked.status} - nothing more to take for it.`;
      else choose(picked);
    }
  } catch (err) {
    error.value = errorText(err, 'Could not load commissions - this needs a connection.');
  }
}
onMounted(load);

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return (items.value ?? []).filter((c) => !q || `${c.customerName} ${c.title}`.toLowerCase().includes(q));
});

/** Paid including sales this device has made that the server has not seen yet. */
const paidOf = (c: CommissionView): number => round2(c.paid + pendingPaid(c.id, c.payments));
const owed = (c: CommissionView): number => round2(Math.max(0, c.price - paidOf(c)));

// ── Taking a payment ────────────────────────────────────────────────────────
const target = ref<CommissionView | null>(null);
const kind = ref<'Deposit' | 'Balance' | 'Payment'>('Deposit');
const amount = ref('');

function choose(c: CommissionView): void {
  target.value = c;
  error.value = null;
  // A deposit first; once something is paid, the rest.
  const asked = round2(Math.max(0, c.depositAsked - paidOf(c)));
  if (paidOf(c) === 0 && asked > 0) pick('Deposit', asked);
  else if (owed(c) > 0) pick('Balance', owed(c));
  else pick('Payment', 0);
}
function pick(k: typeof kind.value, value: number): void {
  kind.value = k;
  amount.value = value > 0 ? String(value) : '';
}

const parsed = computed(() => round2(Number(amount.value.replace(',', '.')) || 0));

async function charge(c: CommissionView): Promise<void> {
  error.value = null;
  const key = `commission:${c.id}`;
  const line = { key, name: `${kind.value} · ${c.title}`, qty: 1, unitPrice: parsed.value };
  const there = sdk().till.findLine(key);
  const decision = decideCharge({ amount: parsed.value, commissionCurrency: c.currency, tillCurrency: currency.value, inCart: there ? there.unitPrice : null });
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
    if (!sdk().till.replaceLine(line)) {
      error.value = 'That line is no longer in the sale. Add it again.';
      return;
    }
    emit('close');
    return;
  }
  if (!sdk().till.addLine({ ...line, ref: { kind: COMMISSION_REF_KIND, id: c.id } })) {
    error.value = 'Open the till for an event or store first.';
    return;
  }
  emit('close');
}

// ── A new commission, with its deposit ──────────────────────────────────────
const creating = ref(false);
const busy = ref(false);
const form = reactive({ title: '', price: '', deposit: '', dueDate: '', name: '', email: '' });
/** Someone already on file, found with the search; off, the quick name and email fields. */
const fromFile = ref(false);
const choice = ref<CustomerChoice>(emptyChoice());
const duplicates = ref<CustomerContact[]>([]);
const useDuplicate = (c: CustomerContact): void => {
  choice.value = choiceOf(c);
  duplicates.value = [];
};
/** Just made here: shown as a code for the customer to scan before anything else. */
const made = ref<CommissionView | null>(null);
const emailed = ref(false);
const num = (s: string): number => Math.max(0, Number(s.replace(',', '.')) || 0);

async function create(force = false): Promise<void> {
  const input = CommissionCreateSchema.safeParse({
    ...(fromFile.value ? customerFields(choice.value, force) : quickCustomer(form.name, form.email, force)),
    title: form.title,
    price: num(form.price),
    depositAsked: num(form.deposit),
    dueDate: form.dueDate,
    currency: currency.value,
  });
  if (!input.success) {
    error.value = input.error.issues[0]?.message ?? 'Check the form.';
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    const c = await api.create(input.data);
    creating.value = false;
    items.value = [c, ...(items.value ?? [])];
    made.value = c;
    emailed.value = false;
  } catch (err) {
    // A customer like this one is already on file: offer them instead of adding a second.
    const found = duplicatesIn(err);
    if (found) {
      // The picker shows who matched, with "use this customer" and "add anyway".
      if (!fromFile.value) choice.value = { picked: null, name: form.name.trim(), email: form.email.trim(), phone: '' };
      fromFile.value = true;
      duplicates.value = found;
    } else error.value = errorText(err, 'Could not save the commission.');
  } finally {
    busy.value = false;
  }
}
function startNew(): void {
  Object.assign(form, { title: '', price: '', deposit: '', dueDate: '', name: '', email: '' });
  choice.value = emptyChoice();
  duplicates.value = [];
  fromFile.value = false;
  creating.value = true;
  error.value = null;
}
async function emailLink(c: CommissionView): Promise<void> {
  busy.value = true;
  try {
    emailed.value = (await api.emailLink(c.id)).emailed;
    if (!emailed.value) error.value = 'The email could not be sent.';
  } catch (err) {
    error.value = errorText(err, 'The email could not be sent.');
  } finally {
    busy.value = false;
  }
}
/** On to the payment, with the deposit asked filled in. */
function takePayment(c: CommissionView): void {
  made.value = null;
  choose(c);
}
</script>

<template>
  <div class="till-comm">
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <template v-if="made">
      <div class="scan">
        <p class="big">Scan to follow your commission</p>
        <QrCode :value="made.publicUrl" :size="240" label="QR code for the customer's tracking page" />
        <p class="title">{{ made.title }}</p>
        <p class="hint">Their own page: progress, messages, pictures they want to send. {{ !made.email && emailEnabled ? 'They can leave an email there for updates.' : '' }}</p>
      </div>
      <div class="actions">
        <button v-if="made.depositAsked > 0 || made.price > 0" type="button" class="primary" @click="takePayment(made)">{{ made.depositAsked > 0 ? `Take the deposit · ${fmtPrice(made.depositAsked, made.currency)}` : 'Take a payment' }}</button>
        <button v-if="made.email && emailEnabled" type="button" :disabled="busy || emailed" @click="emailLink(made)">{{ emailed ? 'Link emailed' : 'Email the link too' }}</button>
        <button type="button" @click="emit('close')">Done</button>
      </div>
    </template>

    <template v-else-if="target">
      <header class="head">
        <strong>{{ target.title }}</strong>
        <span class="hint">{{ target.customerName }} · price {{ target.price > 0 ? fmtPrice(target.price, target.currency) : 'not set' }} · paid {{ fmtPrice(paidOf(target), target.currency) }} · balance {{ fmtPrice(owed(target), target.currency) }}</span>
      </header>
      <div class="kinds" role="group" aria-label="What is this payment">
        <button type="button" :class="{ on: kind === 'Deposit' }" @click="pick('Deposit', round2(Math.max(0, target.depositAsked - paidOf(target))))">Deposit</button>
        <button type="button" :class="{ on: kind === 'Balance' }" :disabled="owed(target) <= 0" @click="pick('Balance', owed(target))">Balance {{ owed(target) > 0 ? fmtPrice(owed(target), target.currency) : '' }}</button>
        <button type="button" :class="{ on: kind === 'Payment' }" @click="pick('Payment', 0)">Other amount</button>
      </div>
      <label>Amount ({{ target.currency }}) <input v-model="amount" type="text" inputmode="decimal" autocomplete="off" /></label>
      <div class="actions">
        <button type="button" class="primary" @click="charge(target)">Add to the sale</button>
        <button type="button" @click="target = null">Back</button>
      </div>
    </template>

    <form v-else-if="creating" class="new" @submit.prevent="create()">
      <label>What is it? <input v-model="form.title" type="text" maxlength="120" required placeholder="Short title the customer sees" /></label>
      <div class="two">
        <label>Price ({{ currency }}) <input v-model="form.price" type="text" inputmode="decimal" /></label>
        <label>Deposit ({{ currency }}) <input v-model="form.deposit" type="text" inputmode="decimal" /></label>
      </div>
      <label>Due date <input v-model="form.dueDate" type="date" /></label>
      <CustomerPicker v-if="fromFile" v-model="choice" :keep-days="keepDays" :duplicates="duplicates" @use-duplicate="useDuplicate" @add-anyway="create(true)" />
      <template v-else>
        <div class="two">
          <label>Name <small>optional</small><input v-model="form.name" type="text" maxlength="120" autocomplete="off" /></label>
          <label>Email <small>optional, for updates</small><input v-model="form.email" type="email" maxlength="254" autocomplete="off" /></label>
        </div>
        <p class="hint">No name: filed as a walk-in, to rename later. The customer scans a code next and can leave their email on their page. <button type="button" class="link" @click="fromFile = true">Someone already on file?</button></p>
      </template>
      <div class="actions">
        <button type="submit" class="primary" :disabled="busy">Save and show the code</button>
        <button type="button" @click="creating = false">Back</button>
      </div>
    </form>

    <template v-else>
      <button type="button" class="primary" @click="startNew">New commission</button>
      <input v-model="query" type="search" placeholder="Find an open commission" aria-label="Find a commission" />
      <p v-if="!items && !error" class="hint">Loading…</p>
      <p v-else-if="items && !shown.length" class="hint">No open commissions{{ query ? ' match' : '' }}.</p>
      <button v-for="c in shown" :key="c.id" type="button" class="person" @click="choose(c)">
        <span><strong>{{ c.title }}</strong><br /><span class="hint">{{ c.customerName }}</span></span>
        <span class="amt">{{ c.price > 0 ? (owed(c) > 0 ? `${fmtPrice(owed(c), c.currency)} to pay` : 'Paid') : 'No price' }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.till-comm { display: flex; flex-direction: column; gap: .7rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.head { display: flex; flex-direction: column; gap: .1rem; }
.kinds, .actions { display: flex; gap: .4rem; flex-wrap: wrap; }
.kinds .on { background: var(--zfy-accent, #0e7c66); color: #fff; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .875rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
.new { display: flex; flex-direction: column; gap: .6rem; }
.person { display: flex; justify-content: space-between; align-items: center; gap: .6rem; width: 100%; min-height: 3rem; padding: .4rem .8rem; text-align: left; font-weight: 400; }
.amt { font-weight: 600; white-space: nowrap; }
label small { color: var(--zfy-muted, #5a6472); font-size: .76rem; font-weight: 400; }
.link { background: none; border: 0; padding: 0; min-height: 0; color: var(--zfy-accent-ink, #0a5a4a); text-decoration: underline; font-weight: 600; font-size: inherit; cursor: pointer; }
.scan { display: flex; flex-direction: column; align-items: center; gap: .5rem; text-align: center; padding: .4rem 0; }
.scan .big { margin: 0; font-size: 1.15rem; font-weight: 700; }
.scan .title { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
</style>
