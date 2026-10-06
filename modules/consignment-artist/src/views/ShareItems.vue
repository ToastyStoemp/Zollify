<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { fmtPrice, type ShareableItem } from '@zollify/shared';
import { errorText, loadShares, saveShares, type Shares } from '../api';

/**
 * The artist choosing which of their own items a store sells - a whole
 * product, or only some of its variants. Ticks are a draft until Save, which
 * sends the whole edit at once (and the store hears about it once). A shared
 * item shows up in the store's catalogue and on its till, with its photo and
 * in the store's currency, and follows the artist's edits. Unsharing takes it
 * off their till; sales already made stay.
 */
const props = defineProps<{ storeAccountId: string; consignorId: string; storeName: string }>();
const emit = defineEmits<{ changed: []; close: [] }>();

const data = ref<Shares | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const search = ref('');
/** What is ticked now, by key: a product id (no variants) or `productId:variantId`. */
const ticked = ref(new Set<string>());
/** What the server has, to send only the difference. */
let saved = new Set<string>();

const keysOf = (i: ShareableItem): string[] => (i.variants.length ? i.variants.map((v) => `${i.productId}:${v.id}`) : [i.productId]);
function sharedKeys(items: ShareableItem[]): Set<string> {
  const out = new Set<string>();
  for (const i of items) {
    if (!i.variants.length) {
      if (i.shared) out.add(i.productId);
    } else for (const v of i.variants) if (v.shared) out.add(`${i.productId}:${v.id}`);
  }
  return out;
}
function load(s: Shares): void {
  data.value = s;
  saved = sharedKeys(s.items);
  ticked.value = new Set(saved);
}

onMounted(async () => {
  try {
    load(await loadShares(props.storeAccountId, props.consignorId));
  } catch (err) {
    error.value = errorText(err, 'Could not load your items.');
  }
});

const items = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (data.value?.items ?? []).filter((i) => !q || i.title.toLowerCase().includes(q) || (i.sku ?? '').toLowerCase().includes(q));
});
const sameCurrency = computed(() => data.value?.artistCurrency === data.value?.storeCurrency);

/** all / some / none of an item's keys ticked. */
function state(i: ShareableItem): 'all' | 'some' | 'none' {
  const keys = keysOf(i);
  const n = keys.filter((k) => ticked.value.has(k)).length;
  return n === 0 ? 'none' : n === keys.length ? 'all' : 'some';
}
function set(keys: string[], on: boolean): void {
  const next = new Set(ticked.value);
  for (const k of keys) {
    if (on) next.add(k);
    else next.delete(k);
  }
  ticked.value = next;
}
const sharedCount = computed(() => (data.value?.items ?? []).filter((i) => state(i) !== 'none').length);
const visibleKeys = computed(() => items.value.flatMap(keysOf));
/** Variants open for picking: products with variants the artist expanded, or partly ticked ones. */
const open = ref(new Set<string>());
function toggleOpen(id: string): void {
  const next = new Set(open.value);
  if (!next.delete(id)) next.add(id);
  open.value = next;
}

const changes = computed(() => {
  const share = [...ticked.value].filter((k) => !saved.has(k));
  const unshare = [...saved].filter((k) => !ticked.value.has(k));
  return { share, unshare, count: share.length + unshare.length };
});

async function save(): Promise<void> {
  if (!changes.value.count) return emit('close');
  busy.value = true;
  error.value = null;
  try {
    const res = await saveShares(props.storeAccountId, props.consignorId, changes.value.share, changes.value.unshare);
    load({ ...data.value!, items: res.items });
    emit('changed');
    emit('close');
  } catch (err) {
    error.value = errorText(err, 'Could not update sharing.');
  } finally {
    busy.value = false;
  }
}
const storePrice = (i: ShareableItem): string => (i.storePrice == null ? 'needs a price' : fmtPrice(i.storePrice, data.value!.storeCurrency));
</script>

<template>
  <div class="share">
    <p class="hint">
      Tick what {{ storeName }} may sell - a whole item, or only some of its variants. Shared items appear on their till with your photo and stay in step when you edit them.
      <template v-if="data && !sameCurrency">Your prices are in {{ data.artistCurrency }}; the store sells in {{ data.storeCurrency }} at its rate.</template>
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!data && !error" class="hint">Loading…</p>
    <template v-else-if="data">
      <div class="bar">
        <input v-model="search" type="search" placeholder="Search your items" aria-label="Search your items" />
        <span class="count">{{ sharedCount }} of {{ data.items.length }} shared</span>
        <button type="button" :disabled="busy || !visibleKeys.length" @click="set(visibleKeys, true)">Tick all shown</button>
        <button type="button" class="quiet" :disabled="busy || !visibleKeys.length" @click="set(visibleKeys, false)">Untick all shown</button>
      </div>
      <p v-if="!data.items.length" class="hint">You have nothing for sale in your catalogue.</p>
      <ul class="items">
        <li v-for="i in items" :key="i.productId" :class="{ on: state(i) !== 'none' }">
          <div class="row">
            <label class="check">
              <input
                type="checkbox"
                :checked="state(i) === 'all'"
                :indeterminate.prop="state(i) === 'some'"
                :disabled="busy"
                @change="set(keysOf(i), ($event.target as HTMLInputElement).checked)"
              />
              <span class="title">{{ i.title }}<small v-if="i.sku"> · {{ i.sku }}</small></span>
            </label>
            <button v-if="i.variants.length" type="button" class="quiet vbtn" :aria-expanded="open.has(i.productId) || state(i) === 'some'" @click="toggleOpen(i.productId)">
              {{ state(i) === 'some' ? `${keysOf(i).filter((k) => ticked.has(k)).length} of ${i.variants.length}` : `${i.variants.length} variants` }}
            </button>
            <span v-if="i.autoShared" class="pill" title="The store scanned its label, so it was shared automatically">shared by scan</span>
            <span class="price">{{ fmtPrice(i.price, data.artistCurrency) }}<small v-if="i.shared && !sameCurrency"> → {{ storePrice(i) }}</small></span>
          </div>
          <ul v-if="i.variants.length && (open.has(i.productId) || state(i) === 'some')" class="variants">
            <li v-for="v in i.variants" :key="v.id">
              <label class="check">
                <input type="checkbox" :checked="ticked.has(`${i.productId}:${v.id}`)" :disabled="busy" @change="set([`${i.productId}:${v.id}`], ($event.target as HTMLInputElement).checked)" />
                <span>{{ v.name }}</span>
              </label>
              <span class="price">{{ fmtPrice(v.price, data.artistCurrency) }}</span>
            </li>
          </ul>
        </li>
      </ul>
      <div class="foot">
        <span class="hint">{{ changes.count ? `${changes.count} change${changes.count === 1 ? '' : 's'} not saved` : 'No changes' }}</span>
        <button type="button" @click="emit('close')">Cancel</button>
        <button type="button" class="primary" :disabled="busy" @click="save">{{ changes.count ? 'Save' : 'Done' }}</button>
      </div>
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
.items > li { padding: .4rem .2rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
.row { display: flex; align-items: center; gap: .6rem; }
.items > li.on .title { font-weight: 600; }
.check { flex: 1; display: flex; align-items: center; gap: .5rem; font-size: .88rem; min-width: 0; }
.title small { color: var(--zfy-muted, #5a6472); font-weight: 400; }
.vbtn { min-height: 1.9rem; padding: .1rem .5rem; font-size: .75rem; }
.variants { list-style: none; margin: .3rem 0 0 1.6rem; padding: 0; display: flex; flex-direction: column; gap: .15rem; }
.variants li { display: flex; align-items: center; gap: .6rem; font-size: .84rem; }
.price { font-variant-numeric: tabular-nums; font-size: .86rem; white-space: nowrap; }
.price small { color: var(--zfy-muted, #5a6472); }
.pill { font-size: .62rem; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; border-radius: 999px; padding: .1rem .45rem; background: var(--zfy-signal-soft, #e4ecf6); }
.foot { display: flex; align-items: center; justify-content: flex-end; gap: .5rem; }
.foot .hint { margin-right: auto; }
</style>
