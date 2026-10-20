<script setup lang="ts">
import { computed, ref } from 'vue';
import { fmtDayRange } from '@zollify/shared';
import { Icon } from '@zollify/ui';
import { forecast, forecastItems, incomingByDossier, rangeDays, salesHistory, sizeFactor, toMoq, upcomingEvents, type ForecastRow, type PlannedEvent } from '../forecast';
import { onHandFor, orderLines, snap, supplierName } from '../api';
import { sdk } from '../runtime';

/**
 * Forecast - how many of each item sell on an average event day, and what
 * the picked events should therefore take. Pick one or more upcoming events,
 * adjust their days or how busy they are, and each row says what to order
 * (or make yourself) on top of what is here and already on its way.
 */
const emit = defineEmits<{ error: [message: string] }>();

const WINDOWS = [
  { days: 90, label: 'Last 3 months' },
  { days: 180, label: 'Last 6 months' },
  { days: 365, label: 'Last 12 months' },
  { days: 0, label: 'All time' },
];
const windowDays = ref(365);
const bufferPct = ref(10);
const search = ref('');
const soldOnly = ref(true);

const events = computed(() => sdk().data.events.list());
const transactions = computed(() => sdk().data.transactions.recent());
const history = computed(() => salesHistory(events.value, transactions.value, windowDays.value ? Date.now() - windowDays.value * 86400000 : 0));
const allTime = computed(() => salesHistory(events.value, transactions.value));
const upcoming = computed(() => upcomingEvents(events.value));

// ── Picked events, with their days and size factor ──────────────────────────
const picked = ref<string[]>([]);
const daysOverride = ref<Record<string, number>>({});
const factorOverride = ref<Record<string, number>>({});
const suggested = computed(() => new Map(upcoming.value.map((e) => [e.id, { days: rangeDays(e) ?? 1, size: sizeFactor(e, events.value, allTime.value) }])));
/** A typed number, or the suggestion when the box is empty. */
const typed = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
function togglePick(id: string): void {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id];
}
const planned = computed<PlannedEvent[]>(() =>
  upcoming.value
    .filter((e) => picked.value.includes(e.id))
    .map((e) => {
      const s = suggested.value.get(e.id)!;
      return { eventId: e.id, name: e.name, days: typed(daysOverride.value[e.id], s.days), factor: typed(factorOverride.value[e.id], s.size.factor) };
    }),
);

// ── Rows ────────────────────────────────────────────────────────────────────
const rows = computed<ForecastRow[]>(() => {
  const items = forecastItems(sdk().data.products.list(), snap.value.dossiers);
  const all = forecast(items, history.value, planned.value, { bufferPct: Number(bufferPct.value) || 0, onHand: onHandFor, incoming: incomingByDossier(snap.value.reorders) });
  const q = search.value.trim().toLowerCase();
  return all
    .filter((r) => (!soldOnly.value || r.sold > 0) && (!q || r.title.toLowerCase().includes(q)))
    .sort((a, b) => b.suggestQty - a.suggestQty || b.perDay - a.perDay || a.title.localeCompare(b.title));
});
const toOrder = computed(() => rows.value.filter((r) => r.suggestQty > 0));

const qty = ref<Record<string, number>>({});
const chosen = ref<Set<string>>(new Set());
const qtyOf = (r: ForecastRow): number => qty.value[r.key] ?? r.suggestQty;
function toggleRow(r: ForecastRow): void {
  const s = new Set(chosen.value);
  if (s.has(r.key)) s.delete(r.key);
  else s.add(r.key);
  chosen.value = s;
}
function pickAll(): void {
  chosen.value = new Set(toOrder.value.map((r) => r.key));
}

async function order(): Promise<void> {
  const lines: { dossierId: string; title: string; supplierId: string | null; qty: number }[] = [];
  const noDossier: string[] = [];
  for (const r of rows.value) {
    if (!chosen.value.has(r.key)) continue;
    const q = toMoq(Math.max(0, Math.floor(Number(qtyOf(r)) || 0)), r.moq);
    if (q <= 0) continue;
    if (!r.dossier) noDossier.push(r.title);
    else lines.push({ dossierId: r.dossier.id, title: r.dossier.title, supplierId: r.dossier.supplierId, qty: q });
  }
  try {
    const { created, merged, skipped } = await orderLines(lines, 'forecast');
    chosen.value = new Set();
    const left = [...skipped, ...noDossier];
    sdk().ui.toast(`${created} reorder${created === 1 ? '' : 's'} created, ${merged} updated${left.length ? ` · make yourself or add a supplier: ${left.join(', ')}` : ''}.`, { kind: 'success' });
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not create the reorders.');
  }
}

/** The list as plain text - for printing runs made at home, or a supplier with no dossier yet. */
async function copyList(): Promise<void> {
  const list = (chosen.value.size ? rows.value.filter((r) => chosen.value.has(r.key)) : toOrder.value).map((r) => `${qtyOf(r)} × ${r.title}`).filter((l) => !l.startsWith('0 '));
  if (!list.length) return;
  try {
    await navigator.clipboard.writeText(`For ${planned.value.map((e) => e.name).join(', ')}:\n${list.join('\n')}`);
    sdk().ui.toast(`${list.length} line${list.length === 1 ? '' : 's'} copied.`, { kind: 'success' });
  } catch {
    emit('error', 'Clipboard blocked by the browser.');
  }
}

const one = (n: number): string => (n >= 10 ? String(Math.round(n)) : (Math.round(n * 10) / 10).toString());
const rate = (n: number): string => (n ? (Math.round(n * 100) / 100).toFixed(2) : '-');
</script>

<template>
  <div class="tab">
    <div class="tools">
      <label class="inline"><span>Sales from</span>
        <select v-model.number="windowDays"><option v-for="w in WINDOWS" :key="w.days" :value="w.days">{{ w.label }}</option></select>
      </label>
      <label class="inline"><span>Buffer</span><input v-model.number="bufferPct" type="number" min="0" step="5" inputmode="numeric" class="num" /> %</label>
      <span class="spacer"></span>
      <span class="muted small">{{ history.days }} event day{{ history.days === 1 ? '' : 's' }} · {{ history.units }} units</span>
    </div>
    <p class="hint">Per day means per day at an event: units sold at events ÷ the days those events ran. Stores are left out. Pick the events to plan for; each gets a size from what its earlier editions sold per day against the average (1 = an average event), and both can be changed.</p>

    <section class="events" aria-label="Events to plan for">
      <p v-if="!upcoming.length" class="empty">No upcoming events. Add one under Events and it shows up here.</p>
      <div v-for="e in upcoming" :key="e.id" class="ev" :class="{ on: picked.includes(e.id) }">
        <label class="pick">
          <input type="checkbox" :checked="picked.includes(e.id)" @change="togglePick(e.id)" />
          <span><strong>{{ e.name }}</strong><small>{{ fmtDayRange(e.dateStart, e.dateEnd) || 'no dates' }}</small></span>
        </label>
        <template v-if="picked.includes(e.id)">
          <label class="inline"><span>Days</span><input v-model.number="daysOverride[e.id]" type="number" min="0" step="1" inputmode="numeric" class="num" :placeholder="String(suggested.get(e.id)!.days)" /></label>
          <label class="inline"><span>Size</span><input v-model.number="factorOverride[e.id]" type="number" min="0" step="0.1" inputmode="decimal" class="num" :placeholder="String(suggested.get(e.id)!.size.factor)" /> ×</label>
          <small class="muted">{{ suggested.get(e.id)!.size.editions ? `from ${suggested.get(e.id)!.size.editions} earlier edition${suggested.get(e.id)!.size.editions === 1 ? '' : 's'}` : 'no earlier edition' }}</small>
        </template>
      </div>
    </section>

    <div class="tools">
      <input v-model="search" type="search" placeholder="Search items" aria-label="Search items" class="search" />
      <label class="inline"><input v-model="soldOnly" type="checkbox" /> <span>Only items that sold</span></label>
      <span class="spacer"></span>
      <template v-if="planned.length">
        <button type="button" class="quiet" :disabled="!toOrder.length" @click="pickAll">Pick all to order</button>
        <button type="button" class="quiet" :disabled="!toOrder.length" @click="copyList"><Icon name="copy" :size="14" /> Copy list</button>
        <button type="button" class="primary" :disabled="!chosen.size" @click="order"><Icon name="shopping-bag" :size="14" /> Order {{ chosen.size || '' }}</button>
      </template>
    </div>

    <p v-if="!history.days" class="empty">No event sales yet{{ windowDays ? ' in this period' : '' }}. Once events have sold something, each item's daily rate shows here.</p>
    <p v-else-if="!rows.length" class="empty">No items match.</p>
    <div v-else class="table-scroll">
      <table>
        <thead>
          <tr>
            <th v-if="planned.length"></th>
            <th class="l">Item</th>
            <th title="Units sold at events in the period">Sold</th>
            <th title="Average units per event day">Per day</th>
            <template v-if="planned.length">
              <th v-for="e in planned" :key="e.eventId" class="ev-col" :title="e.name">{{ e.name }}</th>
              <th v-if="planned.length > 1">Expected</th>
              <th>On hand</th>
              <th title="On reorders not yet received">Coming</th>
              <th>Suggest</th>
              <th>Order</th>
            </template>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.key" :class="{ due: planned.length && r.suggestQty > 0 }">
            <td v-if="planned.length"><input type="checkbox" :checked="chosen.has(r.key)" :aria-label="`Order ${r.title}`" @change="toggleRow(r)" /></td>
            <td class="l">
              {{ r.title }}
              <small v-if="r.dossier">{{ r.dossier.supplierId ? (supplierName.get(r.dossier.supplierId) ?? '?') : 'no supplier' }}<template v-if="r.moq"> · MOQ {{ r.moq }}</template></small>
              <small v-else-if="planned.length">no dossier - make yourself</small>
            </td>
            <td class="muted">{{ r.sold }}</td>
            <td><strong>{{ rate(r.perDay) }}</strong></td>
            <template v-if="planned.length">
              <td v-for="(n, i) in r.perEvent" :key="i" class="muted">{{ one(n) }}</td>
              <td v-if="planned.length > 1">{{ one(r.expected) }}</td>
              <td>{{ r.onHand }}</td>
              <td class="muted">{{ r.incoming || '-' }}</td>
              <td :class="r.suggestQty ? 'bad' : 'muted'"><strong>{{ r.suggestQty || '-' }}</strong></td>
              <td><input v-if="chosen.has(r.key)" :value="qtyOf(r)" type="number" min="0" inputmode="numeric" class="qty" aria-label="Quantity" @input="qty[r.key] = Number(($event.target as HTMLInputElement).value)" /></td>
            </template>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="planned.length" class="hint">Suggest = expected × (1 + buffer), less what is on hand and what is already on order, rounded up to the MOQ. Items without a dossier have no supplier to order from - copy the list to make them yourself.</p>
  </div>
</template>

<style scoped>
.tab { display: flex; flex-direction: column; gap: .8rem; }
.tools { display: flex; gap: .5rem .8rem; align-items: center; flex-wrap: wrap; }
.tools .primary, .tools .quiet { display: inline-flex; align-items: center; gap: .35rem; }
.spacer { flex: 1; }
.inline { display: inline-flex; align-items: center; gap: .35rem; font-size: .82rem; }
.inline span { color: var(--zfy-muted, #5a6472); }
.num { width: 4.5rem; min-height: 2.2rem; padding: .1rem .4rem; text-align: right; }
.search { flex: 1 1 12rem; max-width: 20rem; min-height: 2.2rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; max-width: 70ch; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.events { display: flex; flex-direction: column; gap: .35rem; }
.ev { display: flex; align-items: center; gap: .5rem 1rem; flex-wrap: wrap; padding: .45rem .7rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; background: var(--zfy-surface, #fff); }
.ev.on { border-color: var(--zfy-accent, #127a64); background: var(--zfy-accent-soft, #deeee9); }
.pick { display: flex; align-items: center; gap: .6rem; flex: 1 1 14rem; min-width: 0; cursor: pointer; }
.pick span { display: flex; flex-direction: column; min-width: 0; }
.pick small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
.table-scroll { overflow-x: auto; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
table { width: 100%; border-collapse: collapse; font-size: .85rem; font-variant-numeric: tabular-nums; }
th { text-align: right; font-weight: 500; font-size: .72rem; color: var(--zfy-muted, #5a6472); padding: .45rem .6rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); white-space: nowrap; }
th.ev-col { max-width: 7rem; overflow: hidden; text-overflow: ellipsis; }
td { text-align: right; padding: .35rem .6rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
tr:last-child td { border-bottom: 0; }
th.l, td.l { text-align: left; }
td.l small { display: block; color: var(--zfy-muted, #5a6472); font-size: .72rem; }
tr.due td { background: var(--zfy-signal-soft, #f6e5df); }
.muted { color: var(--zfy-muted, #5a6472); }
.small { font-size: .74rem; }
.bad { color: var(--zfy-danger, #c6512f); }
.qty { width: 4.5rem; min-height: 2.2rem; padding: .1rem .4rem; text-align: right; }
</style>
