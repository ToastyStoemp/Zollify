<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ModalShell } from '@zollify/ui';
import { consignors, errorText, loadShipments, receiveShipment, stores, type Shipment } from '../api';
import { sdk } from '../runtime';

/**
 * Packages artists have sent. Confirming one puts what was counted on the
 * shelf - the artist's list is the starting point, corrected to what is
 * actually in the box - and tells the artist, naming any difference.
 */
const emit = defineEmits<{ error: [message: string | null] }>();

const shipments = ref<Shipment[]>([]);
async function refresh(): Promise<void> {
  try {
    shipments.value = await loadShipments();
  } catch (err) {
    emit('error', errorText(err, 'Could not load packages.'));
  }
}
onMounted(refresh);

const incoming = computed(() => shipments.value.filter((s) => s.status === 'sent'));
const recent = computed(() => shipments.value.filter((s) => s.status === 'received').slice(0, 5));
const nameOf = (id: string): string => consignors.value.find((c) => c.id === id)?.name ?? 'Artist';
const storeName = (id: string): string => stores.value.find((s) => s.id === id)?.name ?? '';
const units = (s: Shipment): number => s.lines.reduce((n, l) => n + l.qty, 0);
const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString();

const open = ref<Shipment | null>(null);
const counted = reactive<Record<string, string>>({});
const busy = ref(false);
const key = (l: { productId: string; variantId: string }): string => `${l.productId}:${l.variantId}`;
function confirm(s: Shipment): void {
  open.value = s;
  for (const k of Object.keys(counted)) delete counted[k];
  for (const l of s.lines) counted[key(l)] = String(l.qty);
}
async function receive(): Promise<void> {
  const s = open.value!;
  busy.value = true;
  emit('error', null);
  try {
    await receiveShipment(s.id, s.lines.map((l) => ({ productId: l.productId, variantId: l.variantId, qty: Math.max(0, Math.floor(Number(counted[key(l)]) || 0)) })));
    open.value = null;
    sdk().ui.toast(`The package from ${nameOf(s.consignorId)} is on the shelf - they have been told.`, { kind: 'success' });
    await refresh();
  } catch (err) {
    emit('error', errorText(err, 'Could not confirm the package.'));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section v-if="incoming.length || recent.length" class="packages">
    <div v-for="s in incoming" :key="s.id" class="pkg">
      <div>
        <strong>{{ nameOf(s.consignorId) }} sent a package</strong>
        <p class="hint">
          {{ fmtDate(s.sentAt) }} · {{ units(s) }} items<template v-if="storeName(s.storeId)"> for {{ storeName(s.storeId) }}</template>
          <template v-if="s.tracking"> · {{ s.carrier }} {{ s.tracking }}</template>
        </p>
        <p v-if="s.note" class="hint">“{{ s.note }}”</p>
      </div>
      <button type="button" class="primary" @click="confirm(s)">Confirm arrival</button>
    </div>
    <details v-if="recent.length">
      <summary>Received lately</summary>
      <p v-for="s in recent" :key="s.id" class="hint">{{ fmtDate(s.receivedAt ?? s.sentAt) }} · {{ nameOf(s.consignorId) }} · {{ (s.received ?? []).reduce((n, l) => n + l.qty, 0) }} items</p>
    </details>

    <ModalShell v-if="open" :title="`Package from ${nameOf(open.consignorId)}`" @close="open = null">
      <div class="form">
        <p class="hint">Count what is in the box. These numbers go on the shelf; {{ nameOf(open.consignorId) }} is told if they differ from the list.</p>
        <table>
          <thead><tr><th>Item</th><th class="num">Listed</th><th class="num">Counted</th></tr></thead>
          <tbody>
            <tr v-for="l in open.lines" :key="key(l)">
              <td>{{ l.title }}</td>
              <td class="num">{{ l.qty }}</td>
              <td class="num"><input v-model="counted[key(l)]" type="number" min="0" step="1" inputmode="numeric" :aria-label="`Counted ${l.title}`" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <template #footer>
        <div class="foot">
          <button type="button" @click="open = null">Not yet</button>
          <button type="button" class="primary" :disabled="busy" @click="receive">Put on the shelf</button>
        </div>
      </template>
    </ModalShell>
  </section>
</template>

<style scoped>
.packages { display: flex; flex-direction: column; gap: .5rem; padding: .8rem 1rem; border-radius: 12px; background: var(--zfy-signal-soft, #e4ecf6); }
.pkg { display: flex; align-items: center; gap: 1rem; justify-content: space-between; flex-wrap: wrap; }
.pkg button { min-height: 2.2rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
summary { cursor: pointer; font-size: .82rem; font-weight: 600; }
.form { display: flex; flex-direction: column; gap: .6rem; }
table { width: 100%; border-collapse: collapse; font-size: .86rem; }
th, td { padding: .35rem .4rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); text-align: left; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
td input { width: 5rem; text-align: right; }
.foot { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
