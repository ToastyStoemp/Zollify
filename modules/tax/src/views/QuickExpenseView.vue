<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { checkPickedFile, fmtPrice, localIsoDay, type SalesEvent } from '@zollify/shared';
import { Icon } from '@zollify/ui';
import { api, type CardPayment, type Expense } from '../api';
import { sdk } from '../runtime';

/**
 * Quick expense - spent something at the event (snacks, parking, tape)?
 * Opens with the amount ready to type, the event already picked (the one
 * being sold at, else the one on today), and puts it in that event's ledger
 * so its profit is right. Reached from the Home card and the Android
 * launcher shortcut "Add expense". Anyone on the team may add one; the
 * expense keeps who did, and only admins change or delete it.
 */

const router = useRouter();
/** Staff add expenses; checking and changing them, and the event's profit, are for admins. */
const isAdmin = sdk().account()?.role !== 'member';
const amountInput = ref<HTMLInputElement | null>(null);
const today = localIsoDay();

/** The event being sold at, else the one running today, else the latest. */
function defaultEvent(list: SalesEvent[]): SalesEvent | null {
  const active = sdk().data.events.active();
  if (active) return active;
  const running = list.filter((e) => e.status !== 'closed' && e.dateStart && e.dateStart <= today && (e.dateEnd || e.dateStart) >= today);
  if (running[0]) return running[0];
  return [...list].filter((e) => e.dateStart && e.dateStart <= today).sort((a, b) => (b.dateStart ?? '').localeCompare(a.dateStart ?? ''))[0] ?? list[0] ?? null;
}

const events = computed(() => sdk().data.events.list().filter((e) => !e.deletedAt));
const eventId = ref('');
const event = computed(() => events.value.find((e) => e.id === eventId.value) ?? null);
/** At an event abroad the money is the local one; both are offered. */
const currencies = computed(() => [...new Set([event.value?.localCurrency, event.value?.currency].filter((c): c is string => !!c))]);
const currency = ref('EUR');

/** The ones bought on the spot most often first; the rest under "More". */
const QUICK = ['food', 'travel', 'furniture', 'marketing', 'shipping', 'other'];
const categories = ref<{ id: string; label: string }[]>([]);
const quick = computed(() => QUICK.map((id) => categories.value.find((c) => c.id === id)).filter((c): c is { id: string; label: string } => !!c));
const category = ref('food');
const amount = ref('');
const what = ref('');
const photo = ref<{ base64: string; name: string } | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const added = ref<Expense[]>([]);
/** Card payments the phone saw, newest first: one tap adds one to this event as an expense. */
const payments = ref<CardPayment[]>([]);
const addingPayment = ref<string | null>(null);

function pickEvent(id: string): void {
  eventId.value = id;
  const e = events.value.find((x) => x.id === id);
  currency.value = e?.localCurrency || e?.currency || sdk().account()?.profile.defaultCurrency || 'EUR';
}

onMounted(async () => {
  const first = defaultEvent(events.value);
  if (first) pickEvent(first.id);
  await nextTick();
  amountInput.value?.focus();
  try {
    categories.value = (await api.categories()).categories;
    if (!categories.value.some((c) => c.id === category.value)) category.value = 'other';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the categories.';
  }
  await loadPayments();
});

async function loadPayments(): Promise<void> {
  try {
    payments.value = (await api.cardPayments()).payments;
  } catch {
    // Without the list the form still works; the card payments simply are not offered.
    payments.value = [];
  }
}

/** Adds a card payment to the event picked here, with the category picked here. */
async function addPayment(p: CardPayment): Promise<void> {
  if (!eventId.value) return void (error.value = 'Pick the event this was for.');
  addingPayment.value = p.id;
  error.value = null;
  try {
    const saved = (await api.addCardPayment(p.id, { eventId: eventId.value, category: category.value })).expense;
    added.value = [saved, ...added.value];
    sdk().ui.toast(`${fmtPrice(p.amount, p.currency)} at ${p.merchant || 'the card'} added to ${event.value?.name ?? 'the event'}.`, { kind: 'success' });
    await loadPayments();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not add that payment.';
  } finally {
    addingPayment.value = null;
  }
}
const dateOf = (t: number) => new Date(t).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });

async function pickPhoto(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const problem = await checkPickedFile('invoice', file);
  if (problem) {
    error.value = problem;
    return;
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  photo.value = { base64: btoa(bin), name: file.name };
}

async function save(): Promise<void> {
  const value = Number(String(amount.value).replace(',', '.'));
  if (!eventId.value) return void (error.value = 'Pick the event this was for.');
  if (!(value > 0)) return void (error.value = 'How much was it?');
  error.value = null;
  busy.value = true;
  try {
    let saved = (await api.addExpense({ eventId: eventId.value, category: category.value, amount: value, currency: currency.value, date: today, vendor: what.value.trim(), note: '' })).expense;
    if (photo.value) saved = (await api.attachInvoice(saved.id, photo.value.base64, photo.value.name)).expense;
    added.value = [saved, ...added.value];
    sdk().ui.toast(`${fmtPrice(value, currency.value)} ${labelOf(category.value).toLowerCase()} added to ${event.value?.name ?? 'the event'}.`, { kind: 'success' });
    amount.value = '';
    what.value = '';
    photo.value = null;
    await nextTick();
    amountInput.value?.focus();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not add the expense.';
  } finally {
    busy.value = false;
  }
}

const labelOf = (id: string) => categories.value.find((c) => c.id === id)?.label ?? id;
const addedTotal = computed(() => {
  const same = added.value.filter((e) => e.currency === currency.value);
  return same.length === added.value.length ? same.reduce((s, e) => s + e.amount, 0) : null;
});
function done(): void {
  if (window.history.state?.back) router.back();
  else void router.push({ name: 'home' });
}
</script>

<template>
  <section class="quick">
    <header>
      <button type="button" class="quiet back" aria-label="Back" @click="done"><Icon name="arrow-left" :size="18" /></button>
      <h1>Add an expense</h1>
    </header>

    <form class="card" @submit.prevent="save">
      <label class="event">
        <span>For</span>
        <select :value="eventId" aria-label="Event" @change="pickEvent(($event.target as HTMLSelectElement).value)">
          <option value="" disabled>Pick an event</option>
          <option v-for="e in events" :key="e.id" :value="e.id">{{ e.name }}{{ e.dateStart ? ` · ${e.dateStart}` : '' }}</option>
        </select>
      </label>

      <div class="amount">
        <input ref="amountInput" v-model="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="Amount" enterkeyhint="done" />
        <div v-if="currencies.length > 1" class="seg" role="group" aria-label="Currency">
          <button v-for="c in currencies" :key="c" type="button" :class="{ on: currency === c }" @click="currency = c">{{ c }}</button>
        </div>
        <span v-else class="cur">{{ currency }}</span>
      </div>

      <input v-model="what" type="text" maxlength="120" placeholder="What was it? (snacks, parking…)" aria-label="What was it" enterkeyhint="done" />

      <div class="chips" role="group" aria-label="Category">
        <button v-for="c in quick" :key="c.id" type="button" :class="['chip', { on: category === c.id }]" @click="category = c.id">{{ c.label }}</button>
        <select v-if="categories.length > quick.length" :value="quick.some((c) => c.id === category) ? '' : category" aria-label="More categories" class="more" @change="category = ($event.target as HTMLSelectElement).value || category">
          <option value="">More…</option>
          <option v-for="c in categories.filter((x) => !QUICK.includes(x.id))" :key="c.id" :value="c.id">{{ c.label }}</option>
        </select>
      </div>

      <label class="photo">
        <input type="file" accept="image/*,application/pdf" capture="environment" @change="pickPhoto" />
        <Icon name="paperclip" :size="16" /> {{ photo ? `Receipt: ${photo.name}` : 'Photo of the receipt (optional)' }}
      </label>

      <p v-if="error" class="error">{{ error }}</p>
      <button type="submit" class="primary save" :disabled="busy">{{ busy ? 'Adding…' : 'Add expense' }}</button>
    </form>

    <article v-if="payments.length" class="card">
      <h2>Card payments</h2>
      <p class="hint">Paid by card on the phone, most recent first. Add one to the event above, with the category picked above.</p>
      <ul class="payments">
        <li v-for="p in payments" :key="p.id">
          <span class="who"><strong>{{ p.merchant || 'Card payment' }}</strong><small>{{ dateOf(p.at) }}<template v-if="p.last4"> · •••• {{ p.last4 }}</template><template v-if="p.addedExpenseId"> · added before</template></small></span>
          <strong>{{ fmtPrice(p.amount, p.currency) }}</strong>
          <button type="button" :disabled="addingPayment === p.id" @click="addPayment(p)">{{ addingPayment === p.id ? '…' : p.addedExpenseId ? 'Add again' : 'Add' }}</button>
        </li>
      </ul>
    </article>

    <article v-if="added.length" class="card">
      <h2>Just added<template v-if="addedTotal !== null"> · {{ fmtPrice(addedTotal, currency) }}</template></h2>
      <ul class="added">
        <li v-for="e in added" :key="e.id"><span>{{ e.vendor || labelOf(e.category) }}</span><span class="muted">{{ labelOf(e.category) }}</span><strong>{{ fmtPrice(e.amount, e.currency) }}</strong></li>
      </ul>
      <router-link v-if="isAdmin" :to="{ name: 'tax:ledger' }" class="ledger">Open the event's profit</router-link>
    </article>
  </section>
</template>

<style scoped>
.quick { display: flex; flex-direction: column; gap: 1rem; max-width: 34rem; }
header { display: flex; align-items: center; gap: .5rem; }
header h1 { margin: 0; font-size: 1.3rem; }
.back { min-height: 2.6rem; }
.card { display: flex; flex-direction: column; gap: .8rem; padding: 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 14px; background: var(--zfy-surface, #fff); }
.card h2 { margin: 0; font-size: .95rem; }
.event { display: flex; flex-direction: column; gap: .25rem; font-size: .8rem; color: var(--zfy-muted, #5a6472); }
.event select { font-size: 1rem; color: var(--zfy-ink, #1a2230); }
.amount { display: flex; align-items: center; gap: .5rem; }
.amount input { flex: 1; min-width: 0; font-size: 2.2rem; font-weight: 700; padding: .4rem .6rem; font-variant-numeric: tabular-nums; }
.cur { font-size: 1.1rem; font-weight: 600; color: var(--zfy-muted, #5a6472); }
.seg { display: flex; gap: .25rem; }
.seg button { min-height: 2.6rem; padding: 0 .7rem; }
.seg button.on { background: var(--zfy-accent, #0e7c66); color: var(--zfy-on-accent, #fff); border-color: var(--zfy-accent, #0e7c66); }
.chips { display: flex; flex-wrap: wrap; gap: .4rem; }
.chip { min-height: 2.4rem; padding: 0 .8rem; border-radius: 999px; font-size: .85rem; }
.chip.on { background: var(--zfy-accent, #0e7c66); color: var(--zfy-on-accent, #fff); border-color: var(--zfy-accent, #0e7c66); }
.more { min-height: 2.4rem; border-radius: 999px; font-size: .85rem; max-width: 12rem; }
.photo { display: flex; align-items: center; gap: .4rem; min-height: 2.6rem; padding: 0 .8rem; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 10px; font-size: .85rem; color: var(--zfy-muted, #5a6472); cursor: pointer; }
.photo input { display: none; }
.save { min-height: 3rem; font-size: 1rem; font-weight: 700; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); font-size: .85rem; }
.added { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; font-size: .875rem; }
.added li { display: grid; grid-template-columns: 1fr auto auto; gap: .6rem; align-items: center; }
.muted { color: var(--zfy-muted, #5a6472); font-size: .78rem; }
.ledger { font-size: .85rem; }
.hint { margin: 0; font-size: .8rem; color: var(--zfy-muted, #5a6472); }
.payments { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.payments li { display: grid; grid-template-columns: 1fr auto auto; gap: .6rem; align-items: center; font-size: .9rem; }
.payments .who { display: flex; flex-direction: column; min-width: 0; }
.payments .who strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.payments small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
.payments button { min-height: 2.4rem; padding: 0 .8rem; }
</style>
