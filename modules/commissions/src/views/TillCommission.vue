<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { COMMISSION_REF_KIND, CommissionInputSchema, fmtPrice, isClosedStatus, round2 } from '@zollify/shared';
import { api, errorText, pendingPaid, type CommissionView } from '../api';
import { sdk } from '../runtime';

/**
 * Over the till: take a deposit or the final balance for a commission, or
 * start a new one and take its deposit. The amount goes in the cart as an
 * ordinary free-price sale line pointing at the commission, so the card
 * terminal, receipt, VAT and cash-up all work as for any sale; what is paid is
 * worked out from those sales afterwards, so a refund puts the balance back.
 */
const emit = defineEmits<{ close: [] }>();

const items = ref<CommissionView[] | null>(null);
const error = ref<string | null>(null);
const query = ref('');
const event = computed(() => sdk().data.events.active());
const currency = computed(() => event.value?.currency ?? 'EUR');

async function load(): Promise<void> {
  try {
    items.value = (await api.list()).commissions.filter((c) => !isClosedStatus(c.status));
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

function charge(c: CommissionView): void {
  if (parsed.value <= 0) {
    error.value = 'Enter an amount to charge.';
    return;
  }
  if (c.currency !== currency.value) {
    error.value = `This commission is in ${c.currency} but the till is working in ${currency.value}. Open the till for an event or store in ${c.currency}.`;
    return;
  }
  const added = sdk().till.addLine({
    key: `commission:${c.id}`,
    name: `${kind.value} · ${c.title}`,
    qty: 1,
    unitPrice: parsed.value,
    ref: { kind: COMMISSION_REF_KIND, id: c.id },
  });
  if (!added) {
    error.value = 'Open the till for an event or store first.';
    return;
  }
  emit('close');
}

// ── A new commission, with its deposit ──────────────────────────────────────
const creating = ref(false);
const busy = ref(false);
const form = reactive({ customerName: '', email: '', phone: '', title: '', price: '', deposit: '', dueDate: '' });
const num = (s: string): number => Math.max(0, Number(s.replace(',', '.')) || 0);

async function create(): Promise<void> {
  const input = CommissionInputSchema.safeParse({
    customerName: form.customerName,
    email: form.email,
    phone: form.phone,
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
    const made = await api.create(input.data);
    creating.value = false;
    items.value = [made, ...(items.value ?? [])];
    choose(made);
    sdk().ui.toast('Commission saved. Charge the deposit, or close this to skip it.', { kind: 'success' });
  } catch (err) {
    error.value = errorText(err, 'Could not save the commission.');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="till-comm">
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <template v-if="target">
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

    <form v-else-if="creating" class="new" @submit.prevent="create">
      <label>Customer name <input v-model="form.customerName" type="text" maxlength="120" required autocomplete="off" /></label>
      <div class="two">
        <label>Email <input v-model="form.email" type="email" maxlength="254" autocomplete="off" /></label>
        <label>Phone <input v-model="form.phone" type="tel" maxlength="40" autocomplete="off" /></label>
      </div>
      <label>What is it? <input v-model="form.title" type="text" maxlength="120" required placeholder="Short title the customer sees" /></label>
      <div class="two">
        <label>Price ({{ currency }}) <input v-model="form.price" type="text" inputmode="decimal" /></label>
        <label>Deposit ({{ currency }}) <input v-model="form.deposit" type="text" inputmode="decimal" /></label>
      </div>
      <label>Due date <input v-model="form.dueDate" type="date" /></label>
      <div class="actions">
        <button type="submit" class="primary" :disabled="busy">Save and continue</button>
        <button type="button" @click="creating = false">Back</button>
      </div>
    </form>

    <template v-else>
      <button type="button" class="primary" @click="creating = true; error = null">New commission</button>
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
</style>
