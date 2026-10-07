<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { COMMISSION_STATUS_LABEL, CustomerInputSchema, fmtPrice } from '@zollify/shared';
import { api, errorText, type CommissionView, type CustomerDetail, type CustomerSummary } from '../api';
import { erasureNote, retentionLine, type CustomerContact } from '../customer-form';
import { sdk } from '../runtime';

/**
 * Customers: everyone on file, what each one ordered and still owes, and when
 * their details will be erased. A new commission can be started for a customer
 * with their details already filled in. Admins can erase a customer whose
 * commissions are all closed, or all such customers, without waiting.
 */
const props = defineProps<{ isAdmin: boolean; currency: string; keepDays: number; focusId?: string | null }>();
const emit = defineEmits<{ 'new-commission': [CustomerContact]; 'open-commission': [CommissionView]; changed: [] }>();

const items = ref<CustomerSummary[]>([]);
const days = ref(props.keepDays);
const loaded = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);
const query = ref('');
let typing: ReturnType<typeof setTimeout> | undefined;

async function load(): Promise<void> {
  error.value = null;
  try {
    const res = await api.customers(query.value.trim());
    items.value = res.customers;
    days.value = res.keepCustomerDays;
  } catch (err) {
    error.value = errorText(err, 'Could not load customers - this needs a connection.');
  } finally {
    loaded.value = true;
  }
}
onMounted(async () => {
  await load();
  if (props.focusId) {
    try {
      detail.value = await api.customer(props.focusId);
    } catch {
      /* erased in the meantime: show the list */
    }
  }
});
function onQuery(): void {
  clearTimeout(typing);
  typing = setTimeout(load, 250);
}

function flash(msg: string): void {
  notice.value = msg;
  setTimeout(() => { if (notice.value === msg) notice.value = null; }, 4000);
}

const detail = ref<CustomerDetail | null>(null);
const editing = ref(false);
const form = reactive({ name: '', email: '', phone: '' });

async function open(c: CustomerSummary): Promise<void> {
  editing.value = false;
  error.value = null;
  try {
    detail.value = await api.customer(c.id);
  } catch (err) {
    error.value = errorText(err, 'Could not open the customer.');
  }
}

async function run(fn: () => Promise<void>, fallback: string): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await fn();
  } catch (err) {
    error.value = errorText(err, fallback);
  } finally {
    busy.value = false;
  }
}

function startEdit(): void {
  if (!detail.value) return;
  Object.assign(form, { name: detail.value.customer.name, email: detail.value.customer.email, phone: detail.value.customer.phone });
  editing.value = true;
}
const saveEdit = (): Promise<void> =>
  run(async () => {
    const d = detail.value;
    const parsed = CustomerInputSchema.safeParse(form);
    if (!d) return;
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Check the details.');
    await api.saveCustomer(d.customer.id, parsed.data);
    editing.value = false;
    detail.value = await api.customer(d.customer.id);
    await load();
    emit('changed');
  }, 'Could not save the customer.');

const erase = (): Promise<void> =>
  run(async () => {
    const d = detail.value;
    if (!d) return;
    const text = `Erase ${d.customer.name}'s name, email and phone, and clear the internal notes, details and customer messages on their ${d.commissions.length} commission${d.commissions.length === 1 ? '' : 's'}? Title, price, payments, dates and status stay in your books. This cannot be undone.`;
    if (!(await sdk().ui.confirm(text, 'Erase customer details?', { confirm: 'Erase now' }))) return;
    await api.eraseCustomer(d.customer.id);
    detail.value = null;
    await load();
    emit('changed');
    flash('Customer details erased.');
  }, 'Could not erase the customer.');

const eraseAll = (): Promise<void> =>
  run(async () => {
    const n = items.value.filter((c) => c.openCount === 0).length;
    if (!n) return flash('No customers with all commissions closed.');
    const text = `Erase the details of ${n} customer${n === 1 ? '' : 's'} whose commissions are all collected or cancelled, now, without waiting for the ${days.value}-day period? Names, emails and phone numbers are deleted, and internal notes, details and customer messages are cleared on their commissions. Title, price, payments, dates and status stay. This cannot be undone.`;
    if (!(await sdk().ui.confirm(text, 'Erase all closed customers?', { confirm: 'Erase now' }))) return;
    const res = await api.eraseClosedCustomers();
    detail.value = null;
    await load();
    emit('changed');
    flash(`Erased ${res.erased} customer${res.erased === 1 ? '' : 's'}.`);
  }, 'Could not erase the customers.');

const money = (n: number, cur: string): string => fmtPrice(n, cur);
const detailCurrency = computed(() => detail.value?.commissions[0]?.currency ?? props.currency);
const canErase = computed(() => !!detail.value && detail.value.customer.openCount === 0);
</script>

<template>
  <div class="layout">
    <section class="list" aria-label="Customers">
      <input v-model="query" type="search" placeholder="Search name, email, phone" aria-label="Search customers" @input="onQuery" />
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" class="ok" role="status">{{ notice }}</p>
      <p v-if="!loaded" class="hint">Loading…</p>
      <p v-else-if="!items.length" class="hint">{{ query ? 'Nobody matches.' : 'No customers on file.' }}</p>
      <button v-for="c in items" :key="c.id" type="button" class="row" :class="{ sel: c.id === detail?.customer.id }" @click="open(c)">
        <span class="main"><strong>{{ c.name }}</strong><span class="hint">{{ [c.email, c.phone].filter(Boolean).join(' · ') || 'No contact details' }}</span></span>
        <span class="side">
          <span class="hint">{{ c.commissionCount }} commission{{ c.commissionCount === 1 ? '' : 's' }}<template v-if="c.openCount"> · {{ c.openCount }} open</template></span>
          <span v-if="c.owed > 0" class="owed">{{ money(c.owed, currency) }} to pay</span>
        </span>
      </button>
      <p class="hint">{{ retentionLine(days) }}</p>
      <button v-if="isAdmin" type="button" class="danger" :disabled="busy" @click="eraseAll">Erase all closed customers now</button>
    </section>

    <section class="detail" aria-live="polite">
      <form v-if="detail && editing" class="card" @submit.prevent="saveEdit">
        <h2>Edit customer</h2>
        <label>Name <input v-model="form.name" type="text" maxlength="120" required autocomplete="off" /></label>
        <div class="two">
          <label>Email <input v-model="form.email" type="email" maxlength="254" autocomplete="off" /></label>
          <label>Phone <input v-model="form.phone" type="tel" maxlength="40" autocomplete="off" /></label>
        </div>
        <div class="actions">
          <button type="submit" class="primary" :disabled="busy">Save</button>
          <button type="button" @click="editing = false">Cancel</button>
        </div>
      </form>

      <article v-else-if="detail" class="card">
        <header class="dh">
          <div>
            <h2>{{ detail.customer.name }}</h2>
            <p class="hint">{{ [detail.customer.email, detail.customer.phone].filter(Boolean).join(' · ') || 'No contact details' }}</p>
          </div>
          <button type="button" class="primary" @click="emit('new-commission', detail.customer)">New commission</button>
        </header>
        <p class="hint">{{ retentionLine(detail.keepCustomerDays) }} {{ erasureNote(detail.customer.erasesAt, detail.customer.openCount) }}</p>
        <dl class="money">
          <dt>Commissions</dt><dd>{{ detail.customer.commissionCount }} ({{ detail.customer.openCount }} open)</dd>
          <dt>Still owed</dt><dd><strong>{{ money(detail.customer.owed, detailCurrency) }}</strong></dd>
        </dl>
        <ul class="orders">
          <li v-for="c in detail.commissions" :key="c.id">
            <button type="button" class="order" @click="emit('open-commission', c)">
              <span class="main"><strong>{{ c.title }}</strong><span class="badge" :class="c.status">{{ COMMISSION_STATUS_LABEL[c.status] }}</span></span>
              <span class="nums hint">Price {{ c.price > 0 ? money(c.price, c.currency) : 'not set' }} · paid {{ money(c.paid, c.currency) }} · balance {{ money(c.balance, c.currency) }}</span>
            </button>
          </li>
        </ul>
        <div class="actions foot">
          <button type="button" @click="startEdit">Edit details</button>
          <span v-if="isAdmin" class="erase">
            <button type="button" class="danger" :disabled="busy || !canErase" @click="erase">Erase now</button>
            <small v-if="!canErase" class="hint">Needed while a commission is open.</small>
          </span>
        </div>
      </article>

      <p v-else class="hint">Pick a customer to see their commissions.</p>
    </section>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: minmax(16rem, 22rem) 1fr; gap: 1rem; align-items: start; }
.list, .detail { display: flex; flex-direction: column; gap: .5rem; min-width: 0; }
h2 { margin: 0; font-size: 1.1rem; overflow-wrap: anywhere; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
.row { display: flex; justify-content: space-between; gap: .6rem; text-align: left; width: 100%; padding: .55rem .7rem; font-weight: 400; min-height: 3rem; }
.row.sel { outline: 2px solid var(--zfy-accent, #0e7c66); }
.main, .side { display: flex; flex-direction: column; gap: .1rem; min-width: 0; }
.main strong { overflow-wrap: anywhere; }
.side { align-items: flex-end; text-align: right; flex: none; }
.owed { color: #9a3412; font-weight: 600; font-size: .8rem; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .6rem; }
.dh { display: flex; justify-content: space-between; gap: .6rem; align-items: flex-start; flex-wrap: wrap; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .875rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.actions { display: flex; gap: .5rem; flex-wrap: wrap; }
.foot { justify-content: space-between; align-items: center; margin-top: .4rem; }
.erase { display: flex; flex-direction: column; align-items: flex-end; gap: .15rem; }
.money { display: grid; grid-template-columns: auto 1fr; gap: .2rem 1rem; margin: 0; font-size: .92rem; }
.money dd { margin: 0; }
.orders { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
.order { width: 100%; text-align: left; font-weight: 400; display: flex; flex-direction: column; gap: .15rem; padding: .5rem .7rem; }
.order .main { flex-direction: row; justify-content: space-between; align-items: center; gap: .5rem; }
.badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; border-radius: 999px; padding: .1rem .55rem; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); white-space: nowrap; }
.badge.cancelled { background: #fee2e2; color: #991b1b; }
.badge.collected { background: #e5e7eb; color: #374151; }
.badge.ready { background: #dbeafe; color: #1e40af; }
@media (max-width: 800px) { .layout { grid-template-columns: 1fr; } .two { grid-template-columns: 1fr; } }
</style>
