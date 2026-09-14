<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@zollify/ui';
import { computeEventPlan, computeRestock, nextRef, type Reorder } from '../engine';
import { save, snap, supplierName } from '../api';
import { sdk } from '../runtime';

/**
 * Restock — what to order next. Two lenses: months of cover from the recent
 * sales rate and what the booth has on hand, or the calendar: what the
 * previous edition of each upcoming event sold. Ticked rows become one
 * reorder per supplier, folded into that supplier's open one when there is.
 */
const emit = defineEmits<{ error: [message: string] }>();
const lens = ref<'cover' | 'events'>('cover');
const onHand = (pid: string, vid: string) => sdk().data.inventory.onHand(pid, vid || null);
const restock = computed(() => computeRestock(snap.value.dossiers, sdk().data.transactions.recent(), onHand));
const plan = computed(() => computeEventPlan(sdk().data.events.list(), snap.value.dossiers, sdk().data.transactions.recent(), onHand));
const rows = computed(() => (lens.value === 'cover' ? restock.value : plan.value.rows));
const picked = ref<Set<string>>(new Set());
const qty = ref<Record<string, number>>({});
function toggle(id: string, suggest: number): void {
  const s = new Set(picked.value);
  if (s.has(id)) s.delete(id);
  else {
    s.add(id);
    if (!(id in qty.value)) qty.value[id] = suggest;
  }
  picked.value = s;
}
function pickDue(): void {
  const s = new Set<string>();
  for (const r of rows.value) {
    if (!r.due || !r.suggestQty) continue;
    s.add(r.dossierId);
    if (!(r.dossierId in qty.value)) qty.value[r.dossierId] = r.suggestQty;
  }
  picked.value = s;
}
const MERGEABLE = ['draft', 'quote_requested', 'quoted'];
async function order(): Promise<void> {
  const bySupplier = new Map<string, { dossierId: string; title: string; qty: number }[]>();
  const skipped: string[] = [];
  for (const r of rows.value) {
    if (!picked.value.has(r.dossierId)) continue;
    let q = Math.max(0, Math.floor(Number(qty.value[r.dossierId]) || 0));
    if (r.moq && q > 0) q = Math.max(q, r.moq);
    if (q <= 0) continue;
    if (!r.supplierId) {
      skipped.push(r.title);
      continue;
    }
    (bySupplier.get(r.supplierId) ?? bySupplier.set(r.supplierId, []).get(r.supplierId)!).push({ dossierId: r.dossierId, title: r.title, qty: q });
  }
  try {
    let created = 0;
    let merged = 0;
    for (const [supplierId, lines] of bySupplier) {
      const open = snap.value.reorders.filter((x) => x.supplierId === supplierId && MERGEABLE.includes(x.status)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
      if (open) {
        const byD = new Map(open.lines.map((l) => [l.dossierId, l]));
        for (const nl of lines) byD.set(nl.dossierId, { ...(byD.get(nl.dossierId) ?? {}), ...nl });
        await save('reorders', { ...open, lines: [...byD.values()], events: [...open.events, { status: open.status, at: Date.now(), note: `Added ${lines.length} item(s) from restock` }] });
        merged++;
      } else {
        const now = Date.now();
        const r: Reorder = { id: crypto.randomUUID(), ref: nextRef(snap.value.reorders), supplierId, status: 'draft', note: '', currency: sdk().account()?.profile.defaultCurrency ?? 'CHF', landedExtra: null, lines, events: [{ status: 'draft', at: now, note: 'Created from restock' }], createdAt: now };
        await save('reorders', r);
        created++;
      }
    }
    picked.value = new Set();
    sdk().ui.toast(`${created} reorder${created === 1 ? '' : 's'} created, ${merged} updated${skipped.length ? ` · no supplier: ${skipped.join(', ')}` : ''}.`, { kind: 'success' });
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not create the reorders.');
  }
}
</script>

<template>
  <div class="tab">
    <div class="tools">
      <div class="seg">
        <button type="button" :class="{ on: lens === 'cover' }" @click="lens = 'cover'">Months of cover</button>
        <button type="button" :class="{ on: lens === 'events' }" @click="lens = 'events'">Upcoming events</button>
      </div>
      <span class="spacer"></span>
      <button type="button" class="quiet" @click="pickDue">Pick all due</button>
      <button type="button" class="primary" :disabled="!picked.size" @click="order"><Icon name="shopping-bag" :size="14" /> Order {{ picked.size || '' }}</button>
    </div>
    <p v-if="lens === 'cover'" class="hint">Sold per month over the last 120 days of sales on this device, against what is on hand. Due when cover drops under the dossier's target (3 months by default); the suggestion tops it back up, rounded up to the MOQ.</p>
    <p v-else class="hint">For each upcoming event, the previous edition (same name, earlier year) and what it sold there. {{ plan.events.filter((e) => e.previous).length }} of {{ plan.events.length }} upcoming events have a previous edition.</p>

    <p v-if="!rows.length" class="empty">{{ snap.dossiers.some((d) => d.pid) ? 'Nothing to show yet — sales will fill this in.' : 'Link the catalogue under Dossiers first.' }}</p>
    <div v-else class="table-scroll">
      <table>
        <thead>
          <tr>
            <th></th><th class="l">Item</th><th class="l">Supplier</th>
            <template v-if="lens === 'cover'"><th>Sold / mo</th><th>On hand</th><th>Cover</th></template>
            <template v-else><th>Sold last time</th><th>On hand</th><th class="l">Events</th></template>
            <th>Suggest</th><th>Order</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.dossierId" :class="{ due: r.due }">
            <td><input type="checkbox" :checked="picked.has(r.dossierId)" :aria-label="`Order ${r.title}`" @change="toggle(r.dossierId, r.suggestQty)" /></td>
            <td class="l">{{ r.title }}<small v-if="r.moq"> MOQ {{ r.moq }}</small></td>
            <td class="l muted">{{ r.supplierId ? (supplierName.get(r.supplierId) ?? '?') : '—' }}</td>
            <template v-if="lens === 'cover' && 'soldPerMonth' in r"><td>{{ r.soldPerMonth }}</td><td>{{ r.onHand }}</td><td :class="r.due ? 'bad' : ''">{{ r.monthsCover == null ? '—' : `${r.monthsCover} mo` }}</td></template>
            <template v-else-if="'soldPrev' in r"><td>{{ r.soldPrev }}</td><td>{{ r.onHand }}</td><td class="l muted small">{{ r.events.map((e) => `${e.name} (${e.soldPrev})`).join(', ') }}</td></template>
            <td :class="r.due ? 'bad' : 'muted'"><strong>{{ r.suggestQty || '—' }}</strong></td>
            <td><input v-if="picked.has(r.dossierId)" v-model.number="qty[r.dossierId]" type="number" min="0" inputmode="numeric" class="qty" aria-label="Quantity" /></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.tab { display: flex; flex-direction: column; gap: .8rem; }
.tools { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.tools .primary { display: inline-flex; align-items: center; gap: .35rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; max-width: 70ch; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.table-scroll { overflow-x: auto; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
table { width: 100%; border-collapse: collapse; font-size: .85rem; font-variant-numeric: tabular-nums; }
th { text-align: right; font-weight: 500; font-size: .72rem; color: var(--zfy-muted, #5a6472); padding: .45rem .6rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); white-space: nowrap; }
td { text-align: right; padding: .35rem .6rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
tr:last-child td { border-bottom: 0; }
th.l, td.l { text-align: left; }
tr.due td { background: var(--zfy-signal-soft, #f6e5df); }
td small { color: var(--zfy-muted, #5a6472); margin-left: .3rem; }
.muted { color: var(--zfy-muted, #5a6472); }
.small { font-size: .74rem; }
.bad { color: var(--zfy-danger, #c6512f); }
.qty { width: 4.5rem; min-height: 1.8rem; padding: .1rem .4rem; text-align: right; }
</style>
