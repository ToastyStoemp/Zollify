<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { ArtistConsignment } from '@zollify/shared';
import { cancelShipment, errorText, restock, sendShipment, type StockLineInput } from '../api';

/**
 * The artist's own stock at a store. In person: add what they just put on
 * the shelf, or recount it. By post: list what is in the box; nothing
 * changes until the store confirms it arrived, and then what the store
 * counted goes on the shelf.
 */
const props = defineProps<{ link: ArtistConsignment; mode: 'restock' | 'package' }>();
const emit = defineEmits<{ done: [message: string]; close: [] }>();

const stores = computed(() => props.link.venues.filter((v) => v.kind === 'store'));
const form = reactive({
  storeId: stores.value[0]?.id ?? '',
  recount: false,
  carrier: '',
  tracking: '',
  note: '',
  // Number inputs hand v-model a number (or '' when cleared).
  qty: {} as Record<string, string | number>,
});
const error = ref<string | null>(null);
const busy = ref(false);
const key = (i: { productId: string; variantId: string }): string => `${i.productId}:${i.variantId}`;

const lines = computed<StockLineInput[]>(() =>
  props.link.items
    .map((i) => ({ productId: i.productId, variantId: i.variantId, raw: String(form.qty[key(i)] ?? '').trim() }))
    .filter((l) => l.raw !== '')
    .map((l) => ({ productId: l.productId, variantId: l.variantId, qty: Math.max(0, Math.floor(Number(l.raw) || 0)) }))
    .filter((l) => form.recount || l.qty > 0),
);
const total = computed(() => lines.value.reduce((n, l) => n + l.qty, 0));

async function submit(): Promise<void> {
  if (!lines.value.length) return void (error.value = 'Enter how many for at least one item.');
  if (props.mode === 'package' && !form.storeId) return void (error.value = 'Pick the store it is going to.');
  busy.value = true;
  error.value = null;
  try {
    if (props.mode === 'restock') {
      await restock(props.link.storeAccountId, props.link.consignorId, { lines: lines.value, mode: form.recount ? 'set' : 'add', storeId: form.storeId || null });
      emit('done', form.recount ? 'Recounted - the store sees the new numbers with its next sync.' : `Added ${total.value} - the store sees it with its next sync.`);
    } else {
      await sendShipment(props.link.storeAccountId, props.link.consignorId, { storeId: form.storeId, lines: lines.value, note: form.note.trim(), carrier: form.carrier.trim(), tracking: form.tracking.trim() });
      emit('done', `Package of ${total.value} announced - it goes on the shelf when ${props.link.storeAccountName} confirms it arrived.`);
    }
    emit('close');
  } catch (err) {
    error.value = errorText(err, 'Could not save that.');
  } finally {
    busy.value = false;
  }
}

const open = computed(() => (props.link.shipments ?? []).filter((s) => s.status === 'sent'));
async function cancel(id: string): Promise<void> {
  try {
    await cancelShipment(props.link.storeAccountId, props.link.consignorId, id);
    emit('done', 'Package cancelled.');
    emit('close');
  } catch (err) {
    error.value = errorText(err, 'Could not cancel it.');
  }
}
</script>

<template>
  <div class="stock">
    <p class="hint">
      <template v-if="mode === 'restock'">Just filled your shelf at {{ link.storeAccountName }}? Enter what you added - it goes straight onto their count, with what already sold taken into account.</template>
      <template v-else>Sending stock to {{ link.storeAccountName }}? List what is in the box. Nothing changes on their shelf until they confirm it arrived, and they confirm what they actually counted.</template>
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="row">
      <label v-if="stores.length">
        <span>{{ mode === 'package' ? 'Going to' : 'At' }}</span>
        <select v-model="form.storeId">
          <option v-if="mode === 'restock'" value="">-</option>
          <option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>
      <label v-if="mode === 'restock'" class="check"><input v-model="form.recount" type="checkbox" /> Recount instead - the numbers are what is there now</label>
    </div>

    <p v-if="!link.items.length" class="hint">You have no items at this store yet - share some first.</p>
    <table v-else>
      <thead><tr><th>Item</th><th class="num">There now</th><th class="num">{{ mode === 'package' ? 'In the box' : form.recount ? 'Counted' : 'Adding' }}</th></tr></thead>
      <tbody>
        <tr v-for="i in link.items" :key="key(i)">
          <td>{{ i.title }}<template v-if="i.variantLabel"> · {{ i.variantLabel }}</template></td>
          <td class="num">{{ i.remaining ?? '-' }}</td>
          <td class="num"><input v-model="form.qty[key(i)]" type="number" min="0" step="1" inputmode="numeric" placeholder="-" :aria-label="`${i.title} ${i.variantLabel ?? ''}`" /></td>
        </tr>
      </tbody>
    </table>

    <template v-if="mode === 'package'">
      <div class="row">
        <label><span>Carrier</span><input v-model="form.carrier" type="text" placeholder="Post, DHL…" /></label>
        <label><span>Tracking</span><input v-model="form.tracking" type="text" /></label>
      </div>
      <label class="block"><span>Note</span><input v-model="form.note" type="text" placeholder="Anything the store should know" /></label>
      <div v-if="open.length" class="open">
        <strong>On its way</strong>
        <p v-for="s in open" :key="s.id" class="hint">
          {{ new Date(s.sentAt).toLocaleDateString() }} · {{ s.lines.reduce((n, l) => n + l.qty, 0) }} items<template v-if="s.tracking"> · {{ s.carrier }} {{ s.tracking }}</template>
          <button type="button" class="quiet" @click="cancel(s.id)">Cancel</button>
        </p>
      </div>
    </template>

    <div class="foot">
      <button type="button" @click="emit('close')">Cancel</button>
      <button type="button" class="primary" :disabled="busy || !lines.length" @click="submit">
        {{ mode === 'package' ? `Send ${total || ''} item${total === 1 ? '' : 's'}` : form.recount ? 'Save counts' : `Add ${total || ''}` }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.stock { display: flex; flex-direction: column; gap: .7rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.row { display: flex; gap: .6rem; flex-wrap: wrap; align-items: flex-end; }
.row label, .block { display: flex; flex-direction: column; gap: .2rem; font-size: .84rem; flex: 1 1 10rem; }
.check { flex-direction: row !important; align-items: center; gap: .4rem; }
table { width: 100%; border-collapse: collapse; font-size: .86rem; }
th, td { padding: .35rem .4rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); text-align: left; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
td input { width: 5rem; text-align: right; }
.open { display: flex; flex-direction: column; gap: .25rem; padding: .5rem .7rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); font-size: .84rem; }
.open button { min-height: 1.8rem; padding: .1rem .5rem; font-size: .76rem; }
.foot { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
