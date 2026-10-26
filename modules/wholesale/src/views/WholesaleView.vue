<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { TradeCustomer, TradeDetails, WholesaleOrder } from '@zollify/shared';
import { api, errorText } from '../api';
import { syncClaims } from '../stock';
import OrdersTab from './OrdersTab.vue';
import CustomersTab from './CustomersTab.vue';
import ProductsTab from './ProductsTab.vue';
import CatalogueTab from './CatalogueTab.vue';

/**
 * Wholesale: orders from draft to paid, the trade customers, what each
 * product is to the trade, and the catalogue. One load, shared by the tabs.
 */
const tab = ref<'orders' | 'customers' | 'products' | 'catalogue'>('orders');
const orders = ref<WholesaleOrder[]>([]);
const customers = ref<TradeCustomer[]>([]);
const details = ref<Record<string, TradeDetails>>({});
const loaded = ref(false);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  error.value = null;
  try {
    const [o, c, d] = await Promise.all([api.orders(), api.customers(), api.details()]);
    orders.value = o.orders;
    customers.value = c.customers;
    details.value = d.details;
    // Open orders keep their units set aside on the Wholesale store.
    await syncClaims(orders.value).catch(() => {});
  } catch (err) {
    error.value = errorText(err, 'Could not load - this needs a connection.');
  } finally {
    loaded.value = true;
  }
}
onMounted(load);
</script>

<template>
  <div class="wholesale">
    <header class="top">
      <div>
        <h1>Wholesale</h1>
        <p class="lede">Shops that buy outright. An open order sets its units aside on the Wholesale store; shipping records it as a sale there.</p>
      </div>
    </header>
    <div class="chips tabs" role="tablist" aria-label="View">
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'orders' }" :aria-selected="tab === 'orders'" @click="tab = 'orders'">Orders <small>{{ orders.filter((o) => o.status !== 'paid' && o.status !== 'cancelled').length }}</small></button>
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'customers' }" :aria-selected="tab === 'customers'" @click="tab = 'customers'">Customers <small>{{ customers.filter((c) => !c.archived).length }}</small></button>
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'products' }" :aria-selected="tab === 'products'" @click="tab = 'products'">Trade prices</button>
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'catalogue' }" :aria-selected="tab === 'catalogue'" @click="tab = 'catalogue'">Catalogue</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!loaded" class="hint">Loading…</p>
    <OrdersTab v-else-if="tab === 'orders'" :orders="orders" :customers="customers" :details="details" @changed="load" />
    <CustomersTab v-else-if="tab === 'customers'" :customers="customers" :orders="orders" @changed="load" />
    <ProductsTab v-else-if="tab === 'products'" :details="details" @changed="load" />
    <CatalogueTab v-else :details="details" :customers="customers" />
  </div>
</template>

<style scoped>
.wholesale { display: flex; flex-direction: column; gap: .8rem; }
.top { display: flex; align-items: center; justify-content: space-between; gap: .6rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
.lede, .hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .9rem; max-width: 70ch; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.chips { display: flex; gap: .3rem; flex-wrap: wrap; }
.chip { font-size: .78rem; padding: .2rem .6rem; border-radius: 999px; min-height: 0; }
.chip.on { background: var(--zfy-accent, #0e7c66); color: #fff; }
.chip small { opacity: .7; }
</style>
