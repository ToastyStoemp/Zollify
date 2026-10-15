<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { ArtistDiscount } from '@zollify/shared';
import { endArtistDiscount, errorText, loadArtistDiscounts, saveArtistDiscount, type ArtistDiscounts } from '../api';
import { sdk } from '../runtime';

/**
 * The artist's own discounts at one store: percent off their work there,
 * all of it or some items, for some days or until ended. The store's till
 * applies it straight away; the store sets how deep it may go, and can end it.
 */
const props = defineProps<{ storeAccountId: string; consignorId: string; storeName: string }>();
const emit = defineEmits<{ close: [] }>();

const data = ref<ArtistDiscounts | null>(null);
const error = ref<string | null>(null);
async function refresh(): Promise<void> {
  try {
    data.value = await loadArtistDiscounts(props.storeAccountId, props.consignorId);
  } catch (err) {
    error.value = errorText(err, 'Could not load your discounts.');
  }
}
onMounted(refresh);

const editing = ref<string | null>(null);
const form = reactive({ name: '', percent: '' as string | number, productIds: [] as string[], validFrom: '', validUntil: '', eventIds: [] as string[] });
function openNew(): void {
  Object.assign(form, { name: '', percent: Math.min(10, data.value?.maxPct ?? 10), productIds: [], validFrom: '', validUntil: '', eventIds: [] });
  error.value = null;
  editing.value = crypto.randomUUID();
}
function openEdit(d: ArtistDiscount): void {
  Object.assign(form, { name: d.name, percent: d.percent, productIds: [...d.productIds], validFrom: d.validFrom ?? '', validUntil: d.validUntil ?? '', eventIds: [...d.eventIds] });
  error.value = null;
  editing.value = d.id;
}
async function save(): Promise<void> {
  error.value = null;
  const percent = Number(form.percent);
  if (!form.name.trim()) return void (error.value = 'Give it a name - it shows on the receipt.');
  if (!(percent > 0)) return void (error.value = 'Enter how much off.');
  try {
    await saveArtistDiscount(props.storeAccountId, props.consignorId, editing.value!, {
      name: form.name.trim(),
      percent,
      productIds: form.productIds,
      ...(form.validFrom ? { validFrom: form.validFrom } : {}),
      ...(form.validUntil ? { validUntil: form.validUntil } : {}),
      eventIds: form.eventIds,
    });
    editing.value = null;
    sdk().ui.toast(`${props.storeName} applies it at the till now.`, { kind: 'success' });
    await refresh();
  } catch (err) {
    error.value = errorText(err, 'Could not save the discount.');
  }
}
async function end(d: ArtistDiscount): Promise<void> {
  if (!(await sdk().ui.confirm(`"${d.name}" stops at ${props.storeName}'s till.`, 'End discount?'))) return;
  try {
    await endArtistDiscount(props.storeAccountId, props.consignorId, d.id);
    await refresh();
  } catch (err) {
    error.value = errorText(err, 'Could not end it.');
  }
}
const titleOf = (id: string): string => data.value?.items.find((i) => i.productId === id)?.title ?? 'Item';
const describe = (d: ArtistDiscount): string =>
  [
    `${d.percent}% off ${d.productIds.length ? d.productIds.map(titleOf).join(', ') : 'all your work'}`,
    d.validFrom || d.validUntil ? `${d.validFrom ?? 'now'} to ${d.validUntil ?? 'open-ended'}` : '',
    d.eventIds.length ? d.eventIds.map((id) => data.value?.stores.find((s) => s.id === id)?.name ?? id).join(', ') : '',
  ]
    .filter(Boolean)
    .join(' · ');
const canAdd = computed(() => !!data.value?.allowed && !editing.value);
</script>

<template>
  <div class="disc">
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!data" class="hint">Loading…</p>
    <template v-else>
      <p v-if="!data.allowed" class="hint">{{ storeName }} does not let artists set their own discounts. Ask them if you would like one.</p>
      <p v-else class="hint">Put your work on discount at {{ storeName }}'s till - up to {{ data.maxPct }}% off. The discount comes off the sale price, so your share and the store's commission shrink alike.</p>

      <ul v-if="data.discounts.length" class="list">
        <li v-for="d in data.discounts" :key="d.id">
          <span><strong>{{ d.name }}</strong><small>{{ describe(d) }}</small></span>
          <button type="button" @click="openEdit(d)">Edit</button>
          <button type="button" class="quiet" @click="end(d)">End</button>
        </li>
      </ul>

      <form v-if="editing" class="form" @submit.prevent="save">
        <div class="two">
          <label><span>Name on the receipt</span><input v-model="form.name" type="text" placeholder="Spring sale" /></label>
          <label><span>% off (max {{ data.maxPct }})</span><input v-model="form.percent" type="number" min="1" :max="data.maxPct" inputmode="decimal" /></label>
        </div>
        <fieldset>
          <legend>On</legend>
          <p class="hint">Nothing ticked: all your work at {{ storeName }}.</p>
          <label v-for="i in data.items" :key="i.productId" class="check"><input v-model="form.productIds" type="checkbox" :value="i.productId" /> {{ i.title }}</label>
        </fieldset>
        <div class="two">
          <label><span>From</span><input v-model="form.validFrom" type="date" /></label>
          <label><span>Until</span><input v-model="form.validUntil" type="date" /></label>
        </div>
        <fieldset v-if="data.stores.length > 1">
          <legend>At</legend>
          <label v-for="s in data.stores" :key="s.id" class="check"><input v-model="form.eventIds" type="checkbox" :value="s.id" /> {{ s.name }}</label>
        </fieldset>
        <div class="foot">
          <button type="button" @click="editing = null">Cancel</button>
          <button type="submit" class="primary">Save discount</button>
        </div>
      </form>
      <button v-else-if="canAdd" type="button" class="primary add" @click="openNew">New discount</button>
    </template>
    <div class="foot"><button type="button" @click="emit('close')">Done</button></div>
  </div>
</template>

<style scoped>
.disc { display: flex; flex-direction: column; gap: .7rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.list li { display: flex; align-items: center; gap: .5rem; padding: .5rem .65rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); }
.list li span { flex: 1; display: flex; flex-direction: column; font-size: .86rem; }
.list small { color: var(--zfy-muted, #5a6472); font-size: .76rem; }
.list button { min-height: 2rem; font-size: .78rem; }
.form { display: flex; flex-direction: column; gap: .6rem; padding: .8rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; }
.form label { display: flex; flex-direction: column; gap: .25rem; font-size: .86rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; padding: .4rem .7rem .6rem; margin: 0; display: flex; flex-direction: column; gap: .3rem; max-height: 14rem; overflow-y: auto; }
legend { font-size: .78rem; font-weight: 600; padding: 0 .3rem; }
.form label.check { flex-direction: row; align-items: center; gap: .45rem; }
.add { align-self: flex-start; }
.foot { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
