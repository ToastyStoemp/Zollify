<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { TradeCustomerSchema, fmtPrice, orderTotals, type TradeCustomer, type TradeCustomerInput, type WholesaleOrder } from '@zollify/shared';
import { CountryPicker } from '@zollify/ui';
import { api, errorText } from '../api';

/** The shops that buy: who they are, their terms and discount, and what they ordered. */
const props = defineProps<{ customers: TradeCustomer[]; orders: WholesaleOrder[] }>();
const emit = defineEmits<{ changed: [] }>();

const showArchived = ref(false);
const shown = computed(() => props.customers.filter((c) => showArchived.value || !c.archived));
const editing = ref<TradeCustomer | 'new' | null>(null);
const form = reactive<TradeCustomerInput>(TradeCustomerSchema.parse({ company: '-' }));
const error = ref<string | null>(null);
const busy = ref(false);

function start(c: TradeCustomer | 'new'): void {
  editing.value = c;
  Object.assign(form, c === 'new' ? TradeCustomerSchema.parse({ company: '-' }) : c);
  if (c === 'new') form.company = '';
  error.value = null;
}
async function save(): Promise<void> {
  const parsed = TradeCustomerSchema.safeParse({ ...form, discountPct: Number(form.discountPct) });
  if (!parsed.success) {
    error.value = parsed.error.issues[0]?.message ?? 'Check the customer.';
    return;
  }
  busy.value = true;
  try {
    if (editing.value === 'new') await api.addCustomer(parsed.data);
    else if (editing.value) await api.saveCustomer(editing.value.id, parsed.data);
    editing.value = null;
    emit('changed');
  } catch (err) {
    error.value = errorText(err, 'Could not save.');
  } finally {
    busy.value = false;
  }
}
const spent = (c: TradeCustomer): string => {
  const mine = props.orders.filter((o) => o.customerId === c.id && (o.status === 'shipped' || o.status === 'invoiced' || o.status === 'paid'));
  if (!mine.length) return 'no orders shipped';
  const total = mine.reduce((s, o) => s + orderTotals(o.lines).total, 0);
  return `${mine.length} shipped · ${fmtPrice(Math.round(total * 100) / 100, c.currency)}`;
};
</script>

<template>
  <div class="customers">
    <div class="bar">
      <button type="button" class="primary" @click="start('new')">New customer</button>
      <label class="check"><input v-model="showArchived" type="checkbox" /> Show archived</label>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <form v-if="editing" class="card" @submit.prevent="save">
      <div class="formhead"><h2>{{ editing === 'new' ? 'New customer' : editing.company }}</h2><button type="button" class="quiet" @click="editing = null">Close</button></div>
      <div class="grid">
        <label>Shop <input v-model="form.company" type="text" maxlength="160" required /></label>
        <label>Contact <input v-model="form.contact" type="text" maxlength="120" /></label>
        <label>Email <input v-model="form.email" type="email" maxlength="254" /></label>
        <label>Phone <input v-model="form.phone" type="text" maxlength="40" /></label>
        <label>VAT number <input v-model="form.vatNumber" type="text" maxlength="40" /></label>
        <label>Enterprise number <input v-model="form.enterpriseNumber" type="text" maxlength="40" /></label>
        <label class="wide">Address <textarea v-model="form.address" rows="2" maxlength="400"></textarea></label>
        <label>Country <CountryPicker v-model="form.country" store="code" /></label>
        <label>Currency <input v-model="form.currency" type="text" maxlength="3" /></label>
        <label>Terms <input v-model="form.terms" type="text" maxlength="200" placeholder="30 days net" /></label>
        <label>Discount off the tier price (%) <input v-model.number="form.discountPct" type="number" min="0" max="100" step="0.5" /></label>
        <label class="wide">Notes <textarea v-model="form.notes" rows="2" maxlength="2000"></textarea></label>
        <label class="check"><input v-model="form.archived" type="checkbox" /> Archived</label>
      </div>
      <div class="actions"><button type="submit" class="primary" :disabled="busy">Save</button></div>
    </form>

    <p v-if="!shown.length" class="hint">No customers yet.</p>
    <ul v-else class="list">
      <li v-for="c in shown" :key="c.id">
        <button type="button" class="row" :class="{ off: c.archived }" @click="start(c)">
          <span class="main"><strong>{{ c.company }}</strong><span class="hint">{{ [c.contact, c.email, c.country].filter(Boolean).join(' · ') }}</span></span>
          <span class="side"><span>{{ c.discountPct ? `${c.discountPct}% off` : 'tier price' }}{{ c.terms ? ` · ${c.terms}` : '' }}</span><span class="hint">{{ spent(c) }}</span></span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.customers { display: flex; flex-direction: column; gap: .7rem; }
.bar { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; }
.hint { color: var(--zfy-muted, #5a6472); font-size: .84rem; margin: 0; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .6rem; }
.formhead { display: flex; justify-content: space-between; align-items: center; gap: .6rem; }
h2 { margin: 0; font-size: 1.05rem; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .875rem; }
label.check { flex-direction: row; align-items: center; gap: .4rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .6rem; }
.grid .wide { grid-column: 1 / -1; }
.actions { display: flex; gap: .5rem; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.row { display: flex; justify-content: space-between; gap: .6rem; text-align: left; width: 100%; padding: .5rem .7rem; font-weight: 400; min-height: 3rem; }
.row.off { opacity: .6; }
.main, .side { display: flex; flex-direction: column; gap: .1rem; min-width: 0; }
.side { align-items: flex-end; text-align: right; flex: none; font-size: .9rem; }
textarea { font: inherit; }
</style>
