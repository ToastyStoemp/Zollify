<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { fmtPrice, sharedPrice } from '@zollify/shared';
import { errorText, loadPricing, savePricing, type Pricing } from '../api';
import { sdk } from '../runtime';

/**
 * How one artist's shared items are priced in this store - the same idea as
 * an event abroad: the artist sets prices in their currency, the store
 * converts at its own rate, rounds, and fixes any price that does not land
 * on a sensible number. Saving re-prices every shared item on every till.
 */
const props = defineProps<{ consignorId: string; name: string }>();
const emit = defineEmits<{ saved: []; close: [] }>();

const data = ref<Pricing | null>(null);
const error = ref<string | null>(null);
const saving = ref(false);
const fetching = ref(false);
const form = reactive({ rate: '', rounding: '0', overrides: {} as Record<string, string> });
const ROUNDING = ['0', '0.05', '0.1', '0.5', '1', '5'];

onMounted(async () => {
  try {
    data.value = await loadPricing(props.consignorId);
    const p = data.value.pricing;
    form.rate = p.rate != null ? String(p.rate) : '';
    form.rounding = String(p.rounding);
    form.overrides = Object.fromEntries(Object.entries(p.overrides).map(([k, v]) => [k, String(v)]));
  } catch (err) {
    error.value = errorText(err, 'Could not load pricing.');
  }
});

const same = computed(() => !!data.value && data.value.artistCurrency === data.value.storeCurrency);
const rate = computed(() => {
  const n = parseFloat(form.rate);
  return Number.isFinite(n) && n > 0 ? n : null;
});
const overrides = computed(() => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(form.overrides)) {
    const n = parseFloat(v);
    if (v.trim() && Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
});
/** What the till will charge, as the form stands. */
const preview = (price: number, key: string): string => {
  const p = sharedPrice(price, key, same.value, { rate: rate.value, rounding: Number(form.rounding) || 0, overrides: overrides.value });
  return p == null ? 'no price yet' : fmtPrice(p, data.value!.storeCurrency);
};

async function fetchRate(): Promise<void> {
  if (!data.value?.artistCurrency) return;
  fetching.value = true;
  const r = await sdk().fx.latest(data.value.artistCurrency, data.value.storeCurrency);
  fetching.value = false;
  if (r) form.rate = String(Math.round(r.rate * 10000) / 10000);
  else error.value = 'Could not fetch a rate - enter it by hand.';
}

async function save(): Promise<void> {
  saving.value = true;
  error.value = null;
  try {
    await savePricing(props.consignorId, { rate: same.value ? null : rate.value, rounding: Number(form.rounding) || 0, overrides: overrides.value });
    emit('saved');
    emit('close');
  } catch (err) {
    error.value = errorText(err, 'Could not save pricing.');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="pricing">
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!data && !error" class="hint">Loading…</p>
    <template v-else-if="data">
      <p v-if="!data.artistCurrency" class="hint">{{ name }} has not linked their account, so there is nothing shared to price.</p>
      <template v-else>
        <p v-if="same" class="hint">{{ name }} prices in {{ data.storeCurrency }} too, so their prices are used as they are. Set a different price per item below if you need to.</p>
        <template v-else>
          <p class="hint">{{ name }} prices in {{ data.artistCurrency }}; you sell in {{ data.storeCurrency }}. Until a rate is set, their shared items are not on your till.</p>
          <div class="row">
            <label><span>1 {{ data.artistCurrency }} =</span><input v-model="form.rate" type="number" min="0" step="0.0001" inputmode="decimal" :placeholder="`rate in ${data.storeCurrency}`" /></label>
            <label><span>Round to</span><select v-model="form.rounding"><option v-for="r in ROUNDING" :key="r" :value="r">{{ r === '0' ? 'cents' : r }}</option></select></label>
            <button type="button" :disabled="fetching" @click="fetchRate">{{ fetching ? 'Fetching…' : "Today's rate" }}</button>
          </div>
        </template>
        <p v-if="!data.items.length" class="hint">Nothing shared yet - {{ name }} picks what you sell under My stores on their account.</p>
        <table v-else>
          <thead><tr><th>Item</th><th class="num">{{ data.artistCurrency }}</th><th class="num">Till</th><th class="num">Your price</th></tr></thead>
          <tbody>
            <template v-for="i in data.items" :key="i.productId">
              <tr>
                <td>{{ i.title }}</td>
                <td class="num">{{ fmtPrice(i.price, data.artistCurrency) }}</td>
                <td class="num">{{ preview(i.price, `${i.productId}:`) }}</td>
                <td class="num"><input v-model="form.overrides[`${i.productId}:`]" type="number" min="0" step="0.05" inputmode="decimal" placeholder="-" :aria-label="`Your price for ${i.title}`" /></td>
              </tr>
              <tr v-for="v in i.variants" :key="`${i.productId}:${v.id}`" class="variant">
                <td>{{ v.name }}</td>
                <td class="num">{{ fmtPrice(v.price, data.artistCurrency) }}</td>
                <td class="num">{{ preview(v.price, `${i.productId}:${v.id}`) }}</td>
                <td class="num"><input v-model="form.overrides[`${i.productId}:${v.id}`]" type="number" min="0" step="0.05" inputmode="decimal" placeholder="-" :aria-label="`Your price for ${i.title} ${v.name}`" /></td>
              </tr>
            </template>
          </tbody>
        </table>
      </template>
      <div class="foot">
        <button type="button" @click="emit('close')">Cancel</button>
        <button type="button" class="primary" :disabled="saving || !data.artistCurrency" @click="save">Save prices</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pricing { display: flex; flex-direction: column; gap: .7rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.row { display: flex; gap: .6rem; align-items: flex-end; flex-wrap: wrap; }
.row label { display: flex; flex-direction: column; gap: .2rem; font-size: .84rem; }
.row button { min-height: 2.4rem; }
table { width: 100%; border-collapse: collapse; font-size: .84rem; }
th, td { padding: .3rem .4rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); text-align: left; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td input { width: 6rem; text-align: right; }
.variant td:first-child { padding-left: 1.2rem; color: var(--zfy-muted, #5a6472); }
.foot { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
