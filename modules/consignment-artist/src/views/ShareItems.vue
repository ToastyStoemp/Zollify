<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { fmtPrice, type ShareableItem } from '@zollify/shared';
import { errorText, loadShares, setShares, type Shares } from '../api';

/**
 * The artist choosing which of their own items a store sells. A shared item
 * shows up in the store's catalogue and on its till - with its photo and in
 * the store's currency - and follows the artist's edits. Unsharing takes it
 * off their till; sales already made stay.
 */
const props = defineProps<{ storeAccountId: string; consignorId: string; storeName: string }>();
const emit = defineEmits<{ changed: [] }>();

const data = ref<Shares | null>(null);
const error = ref<string | null>(null);
const busy = ref<string | null>(null);
const search = ref('');

onMounted(async () => {
  try {
    data.value = await loadShares(props.storeAccountId, props.consignorId);
  } catch (err) {
    error.value = errorText(err, 'Could not load your items.');
  }
});

const items = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (data.value?.items ?? []).filter((i) => !q || i.title.toLowerCase().includes(q) || (i.sku ?? '').toLowerCase().includes(q));
});
const sharedCount = computed(() => (data.value?.items ?? []).filter((i) => i.shared).length);
const sameCurrency = computed(() => data.value?.artistCurrency === data.value?.storeCurrency);

async function toggle(ids: string[], shared: boolean, key: string): Promise<void> {
  if (!ids.length) return;
  busy.value = key;
  error.value = null;
  try {
    data.value = { ...data.value!, items: (await setShares(props.storeAccountId, props.consignorId, ids, shared)).items };
    emit('changed');
  } catch (err) {
    error.value = errorText(err, 'Could not update sharing.');
  } finally {
    busy.value = null;
  }
}
const visibleIds = (shared: boolean): string[] => items.value.filter((i) => i.shared !== shared).map((i) => i.productId);
const storePrice = (i: ShareableItem): string =>
  i.storePrice == null ? 'needs a price' : fmtPrice(i.storePrice, data.value!.storeCurrency);
</script>

<template>
  <div class="share">
    <p class="hint">
      Tick what {{ storeName }} may sell. Shared items appear on their till with your photo and stay in step when you edit them here.
      <template v-if="data && !sameCurrency">Your prices are in {{ data.artistCurrency }}; the store sells in {{ data.storeCurrency }} at its rate.</template>
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!data && !error" class="hint">Loading…</p>
    <template v-else-if="data">
      <div class="bar">
        <input v-model="search" type="search" placeholder="Search your items" aria-label="Search your items" />
        <span class="count">{{ sharedCount }} of {{ data.items.length }} shared</span>
        <button type="button" :disabled="!!busy || !visibleIds(true).length" @click="toggle(visibleIds(true), true, 'all')">Share all shown</button>
        <button type="button" class="quiet" :disabled="!!busy || !visibleIds(false).length" @click="toggle(visibleIds(false), false, 'none')">Stop all shown</button>
      </div>
      <p v-if="!data.items.length" class="hint">You have nothing for sale in your catalogue.</p>
      <ul class="items">
        <li v-for="i in items" :key="i.productId" :class="{ on: i.shared }">
          <label class="check">
            <input type="checkbox" :checked="i.shared" :disabled="busy === i.productId" @change="toggle([i.productId], ($event.target as HTMLInputElement).checked, i.productId)" />
            <span class="title">{{ i.title }}<small v-if="i.sku"> · {{ i.sku }}</small><small v-if="i.variants.length"> · {{ i.variants.length }} variants</small></span>
          </label>
          <span v-if="i.autoShared" class="pill" title="The store scanned its label, so it was shared automatically">shared by scan</span>
          <span class="price">{{ fmtPrice(i.price, data.artistCurrency) }}<small v-if="i.shared && !sameCurrency"> → {{ storePrice(i) }}</small></span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.share { display: flex; flex-direction: column; gap: .7rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.bar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.bar input { flex: 1 1 12rem; }
.bar button { min-height: 2.2rem; font-size: .8rem; }
.count { font-size: .82rem; color: var(--zfy-muted, #5a6472); }
.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; max-height: 55vh; overflow-y: auto; }
.items li { display: flex; align-items: center; gap: .6rem; padding: .4rem .2rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
.items li.on .title { font-weight: 600; }
.check { flex: 1; display: flex; align-items: center; gap: .5rem; font-size: .88rem; min-width: 0; }
.title small { color: var(--zfy-muted, #5a6472); font-weight: 400; }
.price { font-variant-numeric: tabular-nums; font-size: .86rem; white-space: nowrap; }
.price small { color: var(--zfy-muted, #5a6472); }
.pill { font-size: .62rem; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; border-radius: 999px; padding: .1rem .45rem; background: var(--zfy-signal-soft, #e4ecf6); }
</style>
