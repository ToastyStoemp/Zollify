<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { TradeDetailsSchema, fmtPrice, type Product, type TradeDetails } from '@zollify/shared';
import { api, errorText } from '../api';
import { sdk } from '../runtime';

/**
 * What each product is to the trade: price tiers by quantity, minimum
 * order, pack size, lead time, and the words the catalogue shows. Kept
 * apart from the catalogue, keyed by product id, so switching the module
 * off takes nothing from the products.
 */
const props = defineProps<{ details: Record<string, TradeDetails> }>();
const emit = defineEmits<{ changed: [] }>();

const query = ref('');
const onlyTrade = ref(false);
const currency = computed(() => sdk().account()?.profile.defaultCurrency ?? 'EUR');
const products = computed(() => {
  const q = query.value.trim().toLowerCase();
  return sdk().data.products.list().filter((p) => (!q || p.title.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q) || (p.type ?? '').toLowerCase().includes(q)) && (!onlyTrade.value || props.details[p.id]?.enabled));
});
const error = ref<string | null>(null);
const busy = ref(false);
const editing = ref<Product | null>(null);
const form = reactive<TradeDetails>(TradeDetailsSchema.parse({}));

function edit(p: Product): void {
  editing.value = p;
  Object.assign(form, TradeDetailsSchema.parse(props.details[p.id] ?? {}));
  form.tiers = [...form.tiers.map((t) => ({ ...t }))];
  error.value = null;
}
const addTier = (): void => {
  form.tiers = [...form.tiers, { minQty: form.tiers.length ? Math.max(...form.tiers.map((t) => t.minQty)) * 2 : 1, price: editing.value?.price ?? 0 }];
};
async function save(): Promise<void> {
  if (!editing.value) return;
  const parsed = TradeDetailsSchema.safeParse({ ...form, tiers: form.tiers.map((t) => ({ minQty: Number(t.minQty), price: Number(t.price) })), moq: Number(form.moq), packSize: Number(form.packSize), leadDays: Number(form.leadDays) });
  if (!parsed.success) {
    error.value = parsed.error.issues[0]?.message ?? 'Check the values.';
    return;
  }
  busy.value = true;
  try {
    await api.saveDetails(editing.value.id, parsed.data);
    editing.value = null;
    emit('changed');
  } catch (err) {
    error.value = errorText(err, 'Could not save.');
  } finally {
    busy.value = false;
  }
}
const summary = (p: Product): string => {
  const d = props.details[p.id];
  if (!d) return 'list price';
  if (!d.enabled) return 'not to the trade';
  return d.tiers.length ? d.tiers.map((t) => `${t.minQty}+ ${fmtPrice(t.price, currency.value)}`).join(' · ') : 'list price';
};
</script>

<template>
  <div class="products">
    <div class="bar">
      <input v-model="query" type="search" placeholder="Find a product" aria-label="Find a product" />
      <label class="check"><input v-model="onlyTrade" type="checkbox" /> Only those offered to the trade</label>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <form v-if="editing" class="card" @submit.prevent="save">
      <div class="formhead"><h2>{{ editing.title }} <small class="hint">list {{ fmtPrice(editing.price, currency) }}</small></h2><button type="button" class="quiet" @click="editing = null">Close</button></div>
      <label class="check"><input v-model="form.enabled" type="checkbox" /> Offered to the trade</label>
      <div class="grid">
        <label>Minimum order <input v-model.number="form.moq" type="number" min="1" /></label>
        <label>Pack size <input v-model.number="form.packSize" type="number" min="1" /><span class="hint">Orders are rounded up to whole packs.</span></label>
        <label>Lead time (working days) <input v-model.number="form.leadDays" type="number" min="0" max="365" /></label>
      </div>
      <h3>Price tiers ({{ currency }})</h3>
      <p class="hint">From a quantity, a unit price. The highest tier an order line reaches applies; with none, the list price.</p>
      <div v-for="(t, i) in form.tiers" :key="i" class="tier">
        <label>From <input v-model.number="t.minQty" type="number" min="1" /></label>
        <label>each <input v-model.number="t.price" type="number" min="0" step="0.01" /></label>
        <button type="button" class="quiet" @click="form.tiers = form.tiers.filter((_, k) => k !== i)">Remove</button>
      </div>
      <div><button type="button" @click="addTier">Add a tier</button></div>
      <label>Trade description <textarea v-model="form.description" rows="3" maxlength="1000"></textarea></label>
      <div class="grid">
        <label>Materials <input v-model="form.materials" type="text" maxlength="200" :placeholder="editing.material || ''" /></label>
        <label>Dimensions <input v-model="form.dimensions" type="text" maxlength="120" placeholder="A4 · 21 × 29.7 cm" /></label>
      </div>
      <div class="actions"><button type="submit" class="primary" :disabled="busy">Save</button></div>
    </form>

    <p v-if="!products.length" class="hint">No products match.</p>
    <ul v-else class="list">
      <li v-for="p in products" :key="p.id">
        <button type="button" class="row" :class="{ off: details[p.id] && !details[p.id]!.enabled }" @click="edit(p)">
          <span class="main"><strong>{{ p.title }}</strong><span class="hint">{{ p.type || '' }}{{ p.sku ? ` · ${p.sku}` : '' }}</span></span>
          <span class="side"><span>{{ summary(p) }}</span><span v-if="details[p.id]" class="hint">min {{ details[p.id]!.moq }}{{ details[p.id]!.packSize > 1 ? ` · packs of ${details[p.id]!.packSize}` : '' }}{{ details[p.id]!.leadDays ? ` · ${details[p.id]!.leadDays} days` : '' }}</span></span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.products { display: flex; flex-direction: column; gap: .7rem; }
.bar { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; }
.hint { color: var(--zfy-muted, #5a6472); font-size: .84rem; margin: 0; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .6rem; }
.formhead { display: flex; justify-content: space-between; align-items: center; gap: .6rem; }
h2 { margin: 0; font-size: 1.05rem; }
h3 { margin: .3rem 0 0; font-size: .95rem; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .875rem; }
label.check { flex-direction: row; align-items: center; gap: .4rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .6rem; }
.tier { display: flex; gap: .6rem; align-items: flex-end; }
.tier label { flex-direction: row; align-items: center; gap: .3rem; }
.tier input { width: 7rem; }
.actions { display: flex; gap: .5rem; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.row { display: flex; justify-content: space-between; gap: .6rem; text-align: left; width: 100%; padding: .5rem .7rem; font-weight: 400; min-height: 3rem; }
.row.off { opacity: .6; }
.main, .side { display: flex; flex-direction: column; gap: .1rem; min-width: 0; }
.side { align-items: flex-end; text-align: right; flex: none; font-size: .9rem; }
textarea { font: inherit; }
</style>
