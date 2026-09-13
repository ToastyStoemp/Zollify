<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  addLine,
  appliedDiscounts,
  baseTotal,
  cart,
  isConverting,
  checkout,
  clear,
  discountTotal,
  isEmpty,
  itemCount,
  removeLine,
  setCustomDiscount,
  setQty,
  subtotal,
  total,
} from '../cart';
import { useRouter } from 'vue-router';
import type { Product, Variant } from '@boothly/shared';
import { sdk } from '../runtime';
import ProductThumb from '../components/ProductThumb.vue';

const providerId = ref('manual');
const message = ref<string | null>(null);
const failed = ref(false);
const search = ref('');
const lastSaleId = ref<string | null>(null);
const router = useRouter();

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
  const event = activeEvent.value;
  cart.eventId = event?.id ?? null;

  const base = event?.currency ?? 'CHF';
  cart.baseCurrency = base;
  // An event abroad charges in its local currency while the books stay in the
  // base one.
  const converting = Boolean(event?.localCurrency && event.exchangeRate);
  cart.currency = converting ? event!.localCurrency! : base;
  cart.exchangeRate = converting ? (event!.exchangeRate ?? null) : null;
  cart.roundingIncrement = event?.roundingIncrement ?? 0;
});

/** A product with variants needs one chosen before it can be added. */
const choosing = ref<Product | null>(null);

function tap(product: Product): void {
  const variants = (product.variants ?? []).filter((v) => !v.unlisted);
  if (variants.length) {
    choosing.value = product;
    return;
  }
  addProduct(product);
}

function addProduct(product: Product): void {
  addLine({
    productId: product.id,
    sku: product.sku ?? null,
    name: product.title,
    qty: 1,
    unitPrice: product.price,
    taxRate: product.vatRate ?? null,
    type: product.type,
  });
}

/**
 * A variant without its own price inherits the product's, so "same print,
 * three sizes, one price" stays a single number to maintain.
 */
function addVariant(product: Product, variant: Variant): void {
  addLine({
    productId: product.id,
    variantId: variant.id,
    variantLabel: variant.name,
    sku: variant.sku ?? product.sku ?? null,
    name: `${product.title} · ${variant.name}`,
    qty: 1,
    unitPrice: variant.price ?? product.price,
    taxRate: product.vatRate ?? null,
    type: product.type,
  });
  choosing.value = null;
}

const discountInput = ref('');
const discountKind = ref<'amount' | 'percent'>('amount');

/**
 * A manual discount on top of any rules — the "do me a deal" case that every
 * booth needs and no rule can anticipate.
 */
function applyCustomDiscount(): void {
  const value = Number(discountInput.value);
  if (!Number.isFinite(value) || value <= 0) {
    setCustomDiscount(null);
    return;
  }
  setCustomDiscount({
    type: discountKind.value,
    value,
    name: discountKind.value === 'percent' ? `${value}% off` : 'Discount',
  });
}

function clearCustomDiscount(): void {
  discountInput.value = '';
  setCustomDiscount(null);
}

async function take(): Promise<void> {
  message.value = null;
  const saleId = crypto.randomUUID();
  const outcome = await checkout(providerId.value, saleId);
  failed.value = !outcome.approved;
  lastSaleId.value = outcome.approved ? saleId : null;
  message.value = outcome.approved
    ? `Approved — ${outcome.sale?.currency} ${outcome.sale?.total.toFixed(2)}`
    : (outcome.error ?? 'The payment did not complete.');
}

function openReceipt(): void {
  if (lastSaleId.value) {
    void router.push({ name: 'pos:receipt', params: { saleId: lastSaleId.value } });
  }
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

    <div v-if="choosing" class="variant-picker" role="dialog" aria-modal="true">
      <div class="sheet">
        <h2>{{ choosing.title }}</h2>
        <div class="options">
          <button
            v-for="variant in (choosing.variants ?? []).filter((v) => !v.unlisted)"
            :key="variant.id"
            type="button"
            @click="addVariant(choosing, variant)"
          >
            <span>{{ variant.name }}</span>
            <span class="price">{{ (variant.price ?? choosing.price).toFixed(2) }}</span>
          </button>
        </div>
        <button type="button" class="cancel" @click="choosing = null">Cancel</button>
      </div>
    </div>

    <div class="layout">
      <div class="picker">
        <input v-model="search" type="search" placeholder="Search products" aria-label="Search products" />
        <p v-if="!products.length" class="empty">
          {{ search ? 'Nothing matches that search.' : 'No products for sale yet — add some in Catalog.' }}
        </p>
        <div v-else class="grid">
          <button v-for="product in products" :key="product.id" type="button" class="tile" @click="tap(product)">
            <ProductThumb :image-id="product.imageId" :alt="product.title" :size="44" />
            <span class="title">{{ product.title }}</span>
            <span class="price">
              {{ product.price.toFixed(2) }}
              <template v-if="product.variants?.length"> · {{ product.variants.length }} sizes</template>
            </span>
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
          <div class="discount">
            <label>
              <span class="sr">Discount amount</span>
              <input
                v-model="discountInput"
                type="number"
                min="0"
                step="0.01"
                placeholder="Discount"
                @input="applyCustomDiscount"
              />
            </label>
            <select v-model="discountKind" aria-label="Discount kind" @change="applyCustomDiscount">
              <option value="amount">{{ cart.currency }}</option>
              <option value="percent">%</option>
            </select>
            <button v-if="cart.custom" type="button" @click="clearCustomDiscount">Clear</button>
          </div>

          <p v-if="discountTotal > 0" class="line-sub">
            <span>Subtotal</span> <span>{{ subtotal.toFixed(2) }}</span>
          </p>
          <p v-for="applied in appliedDiscounts" :key="applied.rule.id" class="line-sub discount-line">
            <span>{{ applied.rule.name }}</span> <span>−{{ applied.amount.toFixed(2) }}</span>
          </p>
          <p v-if="cart.custom" class="line-sub discount-line">
            <span>Manual discount</span>
            <span>−{{ (discountTotal - appliedDiscounts.reduce((s, a) => s + a.amount, 0)).toFixed(2) }}</span>
          </p>

          <p class="total"><span>Total</span> <strong>{{ cart.currency }} {{ total.toFixed(2) }}</strong></p>
          <p v-if="isConverting" class="line-sub">
            <span>{{ cart.baseCurrency }} equivalent</span>
            <span>{{ baseTotal.toFixed(2) }}</span>
          </p>
          <div class="actions">
            <button type="button" :disabled="isEmpty || cart.busy" @click="clear">Clear</button>
            <button type="button" :disabled="isEmpty || cart.busy" @click="take">
              {{ cart.busy ? 'Taking payment…' : 'Take payment' }}
            </button>
          </div>
          <p v-if="message" :class="['result', { bad: failed }]" role="status">{{ message }}</p>
          <button v-if="lastSaleId" type="button" class="receipt-link" @click="openReceipt">
            Receipt
          </button>
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
.tile { display: flex; flex-direction: column; align-items: flex-start; gap: .3rem; padding: .7rem .8rem; text-align: left; min-height: 4.2rem; }
.tile .title { font-weight: 600; font-size: .9rem; }
.tile .price { font-variant-numeric: tabular-nums; color: var(--bly-muted, #5a6472); }
.ticket { border: 1px solid var(--bly-line, #d6dde4); border-radius: 12px; background: var(--bly-surface, #fff); padding: 1rem; display: flex; flex-direction: column; gap: .75rem; position: sticky; top: 1rem; }
.lines { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.lines li { display: grid; grid-template-columns: 1fr 3.5rem 4.5rem auto; gap: .5rem; align-items: center; font-size: .9rem; }
.qty { width: 100%; }
.linetotal { text-align: right; font-variant-numeric: tabular-nums; }
.discount { display: flex; gap: .4rem; align-items: center; }
.discount input { width: 6rem; }
.discount select { width: 4.5rem; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.line-sub { display: flex; justify-content: space-between; margin: 0; font-size: .82rem; color: var(--bly-muted, #5a6472); font-variant-numeric: tabular-nums; }
.discount-line { color: var(--bly-accent-ink, #0a5a4a); }
.checkout { display: flex; flex-direction: column; gap: .6rem; border-top: 1px solid var(--bly-line, #d6dde4); padding-top: .75rem; }
.total { display: flex; justify-content: space-between; margin: 0; font-size: 1.1rem; font-variant-numeric: tabular-nums; }
.actions { display: flex; gap: .5rem; justify-content: flex-end; }
.receipt-link { align-self: flex-end; }
.variant-picker { position: fixed; inset: 0; background: rgba(20,26,34,.45); display: grid; place-items: center; padding: 1rem; z-index: 10; }
.sheet { background: var(--bly-surface, #fff); border-radius: 14px; padding: 1.25rem; width: 100%; max-width: 24rem; display: flex; flex-direction: column; gap: .75rem; }
.sheet h2 { margin: 0; font-size: 1.05rem; }
.options { display: grid; gap: .4rem; }
.options button { display: flex; justify-content: space-between; padding: .7rem .9rem; font-size: .95rem; }
.options .price { font-variant-numeric: tabular-nums; color: var(--bly-muted, #5a6472); }
.cancel { align-self: flex-end; }
.result { margin: 0; font-size: .875rem; color: var(--bly-accent-ink, #0a5a4a); }
.result.bad { color: var(--bly-danger, #c6512f); }
@media (max-width: 860px) { .layout { grid-template-columns: 1fr; } .ticket { position: static; } }
</style>
