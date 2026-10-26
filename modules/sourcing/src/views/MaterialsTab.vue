<script setup lang="ts">
import { computed, ref } from 'vue';
import { fmtPrice, localIsoDay } from '@zollify/shared';
import { Icon, ModalShell } from '@zollify/ui';
import { materialOnHand, materialTotals, type Material, type MaterialUse } from '../engine';
import { countMaterial, dropUse, remove, save, snap, useMaterial } from '../api';
import { sdk } from '../runtime';
import PrinterKeys from './PrinterKeys.vue';

/**
 * Materials - home-print consumables. Paper, ink, packaging: log what you
 * buy, and each material's unit cost is the weighted average of everything
 * bought. A dossier's recipe turns those into a cost per print.
 */
const emit = defineEmits<{ error: [message: string] }>();
const currency = computed(() => sdk().account()?.profile.defaultCurrency ?? 'CHF');
const list = computed(() => [...snap.value.materials].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)));
const editing = ref<Material | null>(null);
const buying = ref<Material | null>(null);
const purchase = ref({ qty: '', cost: '', date: localIsoDay(), note: '' });
function openNew(): void {
  editing.value = { id: crypto.randomUUID(), name: '', type: 'paper', unit: 'sheet', description: '', purchases: [] };
}
async function saveMaterial(): Promise<void> {
  if (!editing.value?.name.trim()) return emit('error', 'A material needs a name.');
  try {
    const { lowAt, ...rest } = editing.value;
    const mark = Number(lowAt);
    await save('materials', { ...rest, name: rest.name.trim(), unit: rest.unit.trim() || 'unit', ...(lowAt !== undefined && String(lowAt) !== '' && mark >= 0 ? { lowAt: mark } : {}) });
    editing.value = null;
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not save the material.');
  }
}
function openBuy(m: Material): void {
  buying.value = m;
  purchase.value = { qty: '', cost: '', date: localIsoDay(), note: '' };
}
async function logPurchase(): Promise<void> {
  const m = buying.value;
  const qty = parseFloat(purchase.value.qty);
  const cost = parseFloat(purchase.value.cost);
  if (!m || !(qty > 0) || !(cost >= 0)) return emit('error', 'Quantity and cost are required.');
  try {
    await save('materials', { ...m, purchases: [...m.purchases, { id: crypto.randomUUID(), qty, cost, date: purchase.value.date, note: purchase.value.note }] });
    buying.value = null;
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not log the purchase.');
  }
}
const dropPurchase = (m: Material, id: string) => save('materials', { ...m, purchases: m.purchases.filter((p) => p.id !== id) });
const usedBy = (m: Material) => snap.value.dossiers.filter((d) => d.recipe.some((r) => r.materialId === m.id)).length;
const sorted = (m: Material) => [...m.purchases].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

// ── On hand: bought less used, by hand, by the printing app, or by a recount ─
const usageOf = (m: Material) => snap.value.usage?.[m.id];
const onHand = (m: Material) => materialOnHand(m, usageOf(m));
const low = (m: Material) => typeof m.lowAt === 'number' && onHand(m) <= m.lowAt;
const SOURCE: Record<MaterialUse['source'], string> = { manual: 'Used', printer: 'Printed', count: 'Recount' };
const useText = (u: MaterialUse, m: Material) => (u.source === 'count' ? (u.qty > 0 ? `${plural(u.qty, m.unit)} fewer` : `${plural(-u.qty, m.unit)} more`) : plural(u.qty, m.unit));
const stamp = (t: number) => new Date(t).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const using = ref<{ m: Material; mode: 'use' | 'count'; qty: string; note: string } | null>(null);
function openUse(m: Material, mode: 'use' | 'count'): void {
  using.value = { m, mode, qty: mode === 'count' ? String(onHand(m)) : '', note: '' };
}
async function logUse(): Promise<void> {
  const u = using.value;
  if (!u) return;
  const qty = parseFloat(u.qty);
  if (u.mode === 'use' ? !(qty > 0) : !(qty >= 0)) return emit('error', u.mode === 'use' ? 'How many were used?' : 'How many are there?');
  try {
    if (u.mode === 'use') await useMaterial(u.m.id, qty, u.note.trim() || undefined);
    else await countMaterial(u.m.id, qty);
    using.value = null;
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not save that.');
  }
}
async function undoUse(u: MaterialUse): Promise<void> {
  try {
    await dropUse(u.id);
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not remove that.');
  }
}
</script>

<template>
  <div class="tab">
    <div class="tools">
      <p class="hint">Unit cost = total spent ÷ total units bought, so it self-adjusts as prices change. Give a dossier a recipe and its cost per print follows.</p>
      <span class="spacer"></span>
      <button type="button" class="primary" @click="openNew"><Icon name="plus" :size="14" /> New material</button>
    </div>
    <p v-if="!list.length" class="empty">No materials yet. Start with the paper you print on.</p>
    <article v-for="m in list" :key="m.id" class="card">
      <div class="head">
        <span class="main"><strong>{{ m.name }}<em>{{ m.type }}</em></strong><small>{{ plural(materialTotals(m).qty, m.unit) }} bought · {{ fmtPrice(materialTotals(m).spent, currency) }} spent · used by {{ usedBy(m) }} recipe{{ usedBy(m) === 1 ? '' : 's' }}</small></span>
        <span :class="['unit', 'hand', { low: low(m) }]"><strong>{{ onHand(m) }}</strong><small>{{ m.unit }}s on hand{{ low(m) ? ' · low' : '' }}</small></span>
        <span class="unit"><strong>{{ fmtPrice(materialTotals(m).unitCost, currency) }}</strong><small>per {{ m.unit }}</small></span>
        <button type="button" @click="openBuy(m)"><Icon name="plus" :size="14" /> Purchase</button>
        <button type="button" @click="openUse(m, 'use')">Use</button>
        <button type="button" class="quiet" @click="openUse(m, 'count')">Count</button>
        <button type="button" class="quiet" @click="editing = { ...m }">Edit</button>
        <button type="button" class="quiet danger" @click="remove('materials', m.id)">Remove</button>
      </div>
      <ul v-if="m.purchases.length" class="purchases">
        <li v-for="p in sorted(m)" :key="p.id">
          <span>{{ p.date || '-' }}</span><span>{{ plural(p.qty, m.unit) }}</span><span>{{ fmtPrice(p.cost, currency) }}</span><span class="muted">{{ p.note }}</span>
          <button type="button" class="quiet" aria-label="Remove purchase" @click="dropPurchase(m, p.id)"><Icon name="x" :size="12" /></button>
        </li>
      </ul>
      <ul v-if="usageOf(m)?.recent.length" class="purchases uses">
        <li v-for="u in usageOf(m)!.recent" :key="u.id">
          <span>{{ stamp(u.at) }}</span><span :class="['src', u.source]">{{ SOURCE[u.source] }}</span><span>{{ useText(u, m) }}</span><span class="muted">{{ u.note }}</span>
          <button type="button" class="quiet" aria-label="Remove this use" @click="undoUse(u)"><Icon name="x" :size="12" /></button>
        </li>
      </ul>
    </article>

    <PrinterKeys @error="emit('error', $event)" />

    <ModalShell v-if="editing" title="Material" @close="editing = null">
      <div class="form">
        <label><span>Name</span><input v-model="editing.name" type="text" placeholder="Hahnemühle A3" /></label>
        <div class="two">
          <label>
            <span>Type</span>
            <select v-model="editing.type"><option value="paper">Paper</option><option value="ink">Ink</option><option value="packaging">Packaging</option><option value="other">Other</option></select>
          </label>
          <label><span>Unit</span><input v-model="editing.unit" type="text" placeholder="sheet, ml, sleeve" /></label>
        </div>
        <label><span>Description</span><input v-model="editing.description" type="text" /></label>
        <label><span>Running low at ({{ editing.unit || 'unit' }}s on hand, optional)</span><input v-model.number="editing.lowAt" type="number" min="0" step="1" inputmode="numeric" placeholder="e.g. 20" /></label>
      </div>
      <template #footer><div class="footer"><span class="spacer"></span><button type="button" @click="editing = null">Cancel</button><button type="button" class="primary" @click="saveMaterial">Save</button></div></template>
    </ModalShell>

    <ModalShell v-if="buying" :title="`Purchase · ${buying.name}`" @close="buying = null">
      <div class="form">
        <div class="two">
          <label><span>Quantity ({{ buying.unit }}s)</span><input v-model="purchase.qty" type="number" min="0" step="0.01" inputmode="decimal" /></label>
          <label><span>Total cost ({{ currency }})</span><input v-model="purchase.cost" type="number" min="0" step="0.01" inputmode="decimal" /></label>
        </div>
        <div class="two">
          <label><span>Date</span><input v-model="purchase.date" type="date" /></label>
          <label><span>Note</span><input v-model="purchase.note" type="text" /></label>
        </div>
      </div>
      <template #footer><div class="footer"><span class="spacer"></span><button type="button" @click="buying = null">Cancel</button><button type="button" class="primary" @click="logPurchase">Log purchase</button></div></template>
    </ModalShell>

    <ModalShell v-if="using" :title="`${using.mode === 'use' ? 'Use' : 'Count'} · ${using.m.name}`" @close="using = null">
      <div class="form">
        <p class="hint">{{ using.mode === 'use' ? 'Paper used by hand - a print run, a misprint. The printing app logs its own prints.' : `What is really there. The books say ${onHand(using.m)}; the difference is logged as a recount.` }}</p>
        <div class="two">
          <label><span>{{ using.mode === 'use' ? 'Used' : 'On hand' }} ({{ using.m.unit }}s)</span><input v-model="using.qty" type="number" min="0" step="1" inputmode="decimal" /></label>
          <label v-if="using.mode === 'use'"><span>Note</span><input v-model="using.note" type="text" maxlength="200" /></label>
        </div>
      </div>
      <template #footer><div class="footer"><span class="spacer"></span><button type="button" @click="using = null">Cancel</button><button type="button" class="primary" @click="logUse">{{ using.mode === 'use' ? 'Log use' : 'Save count' }}</button></div></template>
    </ModalShell>
  </div>
</template>

<style scoped>
.tab { display: flex; flex-direction: column; gap: .8rem; }
.tools { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.tools .primary, .head button { display: inline-flex; align-items: center; gap: .35rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; max-width: 60ch; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .6rem .9rem; display: flex; flex-direction: column; gap: .4rem; }
.head { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.main em { font-style: normal; font-weight: 500; font-size: .66rem; margin-left: .35rem; padding: .05rem .35rem; border-radius: 4px; background: var(--zfy-bg, #f1f4f6); color: var(--zfy-muted, #5a6472); vertical-align: middle; }
.main small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
.unit { display: flex; flex-direction: column; align-items: flex-end; font-variant-numeric: tabular-nums; }
.unit small { color: var(--zfy-muted, #5a6472); font-size: .7rem; }
.head button { min-height: 2.2rem; padding: .2rem .6rem; font-size: .78rem; }
.purchases { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .15rem; font-size: .8rem; }
.purchases li { display: grid; grid-template-columns: 6rem 7rem 7rem 1fr auto; gap: .5rem; align-items: center; padding: .2rem .4rem; border-radius: 6px; background: var(--zfy-bg, #f1f4f6); font-variant-numeric: tabular-nums; }
.purchases .quiet { min-height: 2.2rem; padding: 0 .3rem; }
.muted { color: var(--zfy-muted, #5a6472); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hand { min-width: 5rem; }
.hand.low strong, .hand.low small { color: var(--zfy-danger, #c6512f); }
.src { font-weight: 600; }
.src.printer { color: var(--zfy-accent-ink, #0a5a4a); }
.src.count { color: var(--zfy-muted, #5a6472); }
.form { display: flex; flex-direction: column; gap: .6rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.footer { display: flex; align-items: center; gap: .5rem; }
</style>
