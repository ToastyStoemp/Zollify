<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { sdk } from '../runtime';

type CardSize = 'small' | 'medium' | 'large';

const selected = ref<Set<string>>(new Set());
const size = ref<CardSize>('medium');
const showSku = ref(false);
const currency = ref('CHF');

const products = computed(() => sdk().data.products.forSale());

const chosen = computed(() =>
  products.value.filter((p) => selected.value.has(p.id)),
);

onMounted(async () => {
  size.value = (await sdk().config.get<CardSize>('cardSize')) ?? 'medium';
  showSku.value = (await sdk().config.get<boolean>('showSku')) ?? false;
  currency.value = sdk().data.events.active()?.currency ?? sdk().account()?.profile.defaultCurrency ?? 'CHF';
  // Nothing selected reads as a mistake on a printing screen, so start with
  // everything on and let the user narrow it down.
  selected.value = new Set(products.value.map((p) => p.id));
});

function toggle(id: string): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function selectAll(): void {
  selected.value = new Set(products.value.map((p) => p.id));
}

function selectNone(): void {
  selected.value = new Set();
}

async function persist(): Promise<void> {
  try {
    await sdk().config.set('cardSize', size.value);
    await sdk().config.set('showSku', showSku.value);
  } catch {
    /* best effort - printing still proceeds even if the preference save fails */
  }
}

function print(): void {
  void persist();
  window.print();
}
</script>

<template>
  <section class="page price-cards">
    <header>
      <h1>Price cards</h1>
      <div class="tools opts">
        <label>
          <span>Size</span>
          <select v-model="size">
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </label>
        <label class="inline"><input v-model="showSku" type="checkbox" /> <span>Show SKU</span></label>
        <button type="button" @click="selectAll">All</button>
        <button type="button" @click="selectNone">None</button>
        <button type="button" :disabled="!chosen.length" @click="print">Print {{ chosen.length }}</button>
      </div>
    </header>

    <p v-if="!products.length" class="empty">
      No products for sale yet - add some in Catalog and they'll appear here.
    </p>

    <div v-else class="picker">
      <label v-for="product in products" :key="product.id" class="pick">
        <input type="checkbox" :checked="selected.has(product.id)" @change="toggle(product.id)" />
        <span>{{ product.title }}</span>
      </label>
    </div>

    <div :class="['sheet', size]">
      <article v-for="product in chosen" :key="product.id" class="card">
        <h2>{{ product.title }}</h2>
        <p v-if="showSku && product.sku" class="sku">{{ product.sku }}</p>
        <p class="price">{{ currency }} {{ product.price.toFixed(2) }}</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.opts label { display: flex; align-items: center; gap: .35rem; font-size: .85rem; }
.picker { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: .35rem; }
.pick { display: flex; align-items: center; gap: .4rem; font-size: .875rem; }
.sheet { display: grid; gap: .5rem; }
.sheet.small { grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr)); }
.sheet.medium { grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); }
.sheet.large { grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .9rem; background: #fff; color: #141a22; display: flex; flex-direction: column; gap: .3rem; break-inside: avoid; }
.card h2 { margin: 0; font-size: 1rem; line-height: 1.25; }
.sku { margin: 0; font-size: .75rem; font-family: ui-monospace, monospace; color: #5a6472; }
.price { margin: auto 0 0; font-size: 1.4rem; font-weight: 700; font-variant-numeric: tabular-nums; }

/* Only the cards should reach the paper - the controls and picker are workflow. */
@media print {
  .tools, .picker, .empty { display: none; }
  .card { border-color: #999; }
  .sheet { gap: .35rem; }
}
</style>
