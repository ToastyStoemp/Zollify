<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { addLine, cart, checkout, clear, isEmpty, itemCount, removeLine, setQty, total } from '../cart';
import { sdk } from '../runtime';

const providerId = ref('manual');
const message = ref<string | null>(null);
const failed = ref(false);
const search = ref('');

/**
 * Products come from core through the SDK, never from core's database
 * directly — POS holds no catalogue of its own to drift out of sync.
 */
const products = computed(() => {
  const all = sdk().data.products.forSale();
  const q = search.value.trim().toLowerCase();
  if (!q) return all;
  return all.filter(
    (p) => p.title.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q),
  );
});

const activeEvent = computed(() => sdk().data.events.active());

onMounted(async () => {
  providerId.value = (await sdk().config.get<string>('activeProvider')) ?? 'manual';
  // The till records against whichever event is active; keep the cart in step
  // so a sale can never be filed under the wrong one.
  cart.eventId = activeEvent.value?.id ?? null;
  if (activeEvent.value?.currency) cart.currency = activeEvent.value.currency;
});

function add(productId: string): void {
  const product = sdk().data.products.get(productId);
  if (!product) return;
  addLine({
    productId: product.id,
    sku: product.sku ?? null,
    name: product.title,
    qty: 1,
    unitPrice: product.price,
    taxRate: product.vatRate ?? null,
  });
}

async function take(): Promise<void> {
  message.value = null;
  const outcome = await checkout(providerId.value, crypto.randomUUID());
  failed.value = !outcome.approved;
  message.value = outcome.approved
    ? `Approved — ${outcome.sale?.currency} ${outcome.sale?.total.toFixed(2)}`
    : (outcome.error ?? 'The payment did not complete.');
}
</script>

<template>
  <section class="pos">
    <header>
      <div>
        <h1>Sell</h1>
        <p class="event">
          <template v-if="activeEvent">{{ activeEvent.name }}</template>
          <template v-else>No active event — sales won't be filed against one.</template>
        </p>
      </div>
      <p class="count">{{ itemCount }} item{{ itemCount === 1 ? '' : 's' }}</p>
    </header>

    <div class="layout">
      <div class="picker">
        <input v-model="search" type="search" placeholder="Search products" aria-label="Search products" />
        <p v-if="!products.length" class="empty">
          {{ search ? 'Nothing matches that search.' : 'No products for sale yet — add some in Catalog.' }}
        </p>
        <div v-else class="grid">
          <button v-for="product in products" :key="product.id" type="button" class="tile" @click="add(product.id)">
            <span class="title">{{ product.title }}</span>
            <span class="price">{{ product.price.toFixed(2) }}</span>
          </button>
        </div>
      </div>

      <div class="ticket">
        <p v-if="isEmpty" class="empty">Pick a product to start a sale.</p>

        <ul v-else class="lines">
          <li v-for="line in cart.lines" :key="line.lineId">
            <span class="name">{{ line.name }}</span>
            <input
              class="qty"
              type="number"
              min="1"
              :value="line.qty"
              :aria-label="`Quantity for ${line.name}`"
              @input="setQty(line.lineId, Number(($event.target as HTMLInputElement).value))"
            />
            <span class="linetotal">{{ (line.unitPrice * line.qty).toFixed(2) }}</span>
            <button type="button" :aria-label="`Remove ${line.name}`" @click="removeLine(line.lineId)">×</button>
          </li>
        </ul>

        <footer class="checkout">
          <p class="total"><span>Total</span> <strong>{{ cart.currency }} {{ total.toFixed(2) }}</strong></p>
          <div class="actions">
            <button type="button" :disabled="isEmpty || cart.busy" @click="clear">Clear</button>
            <button type="button" :disabled="isEmpty || cart.busy" @click="take">
              {{ cart.busy ? 'Taking payment…' : 'Take payment' }}
            </button>
          </div>
          <p v-if="message" :class="['result', { bad: failed }]" role="status">{{ message }}</p>
        </footer>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pos { display: flex; flex-direction: column; gap: 1rem; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
h1 { font-size: 1.35rem; margin: 0; }
.event, .count, .empty { color: var(--bly-muted, #5a6472); margin: 0; font-size: .875rem; }
.layout { display: grid; grid-template-columns: 1fr 22rem; gap: 1.5rem; align-items: start; }
.picker { display: flex; flex-direction: column; gap: .75rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: .5rem; }
.tile { display: flex; flex-direction: column; align-items: flex-start; gap: .25rem; padding: .7rem .8rem; text-align: left; min-height: 4.2rem; }
.tile .title { font-weight: 600; font-size: .9rem; }
.tile .price { font-variant-numeric: tabular-nums; color: var(--bly-muted, #5a6472); }
.ticket { border: 1px solid var(--bly-line, #d6dde4); border-radius: 12px; background: var(--bly-surface, #fff); padding: 1rem; display: flex; flex-direction: column; gap: .75rem; position: sticky; top: 1rem; }
.lines { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.lines li { display: grid; grid-template-columns: 1fr 3.5rem 4.5rem auto; gap: .5rem; align-items: center; font-size: .9rem; }
.qty { width: 100%; }
.linetotal { text-align: right; font-variant-numeric: tabular-nums; }
.checkout { display: flex; flex-direction: column; gap: .6rem; border-top: 1px solid var(--bly-line, #d6dde4); padding-top: .75rem; }
.total { display: flex; justify-content: space-between; margin: 0; font-size: 1.1rem; font-variant-numeric: tabular-nums; }
.actions { display: flex; gap: .5rem; justify-content: flex-end; }
.result { margin: 0; font-size: .875rem; color: var(--bly-accent-ink, #0a5a4a); }
.result.bad { color: var(--bly-danger, #c6512f); }
@media (max-width: 860px) { .layout { grid-template-columns: 1fr; } .ticket { position: static; } }
</style>
