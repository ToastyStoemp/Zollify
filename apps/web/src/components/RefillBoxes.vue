<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { SalesEvent } from '@zollify/shared';
import { claimFor, claimRefill, copyEventPricing, getProduct, refillPlan, shellConfirm, stockKey, type RefillRow } from '@zollify/platform';
import { typeColor } from '@zollify/ui';
import ProductThumb from './ProductThumb.vue';

/**
 * Refilling the travelling boxes after an event. Each item the event claimed
 * comes back with what did not sell; this says how many to put in from home
 * to fill the box back up to the claim, most first, against what is at home -
 * and then claims the full boxes for the next event in one step: what came
 * back is carried on, the refill comes off home. The "In" ticks are only for
 * packing on this device and are not saved.
 */
const props = defineProps<{ search: string; canEdit: boolean; upcomingEvents: SalesEvent[]; pastEvents: SalesEvent[] }>();

const hasClaims = (e: SalesEvent): boolean => refillPlan(e.id).length > 0;
/** Events whose boxes can be refilled: the finished ones first, most recent first, then those still on. */
const sources = computed(() => [...props.pastEvents, ...props.upcomingEvents].filter(hasClaims));
const sourceId = ref(props.pastEvents.find(hasClaims)?.id ?? sources.value[0]?.id ?? '');
const targets = computed(() => props.upcomingEvents.filter((e) => e.id !== sourceId.value));
const targetId = ref('');
const pickTarget = (): void => {
  if (!targets.value.some((e) => e.id === targetId.value)) targetId.value = targets.value[0]?.id ?? '';
};
pickTarget();

/** What to put in, typed over the plan's figure per item; cleared with the event. */
const typed = ref<Record<string, number>>({});
const packed = ref<Set<string>>(new Set());
const matchPrices = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const note = ref('');
watch(sourceId, () => {
  typed.value = {};
  packed.value = new Set();
  note.value = '';
  pickTarget();
});
watch(targetId, () => (note.value = ''));

const keyOf = (r: RefillRow): string => stockKey(r.productId, r.variantId);
const plan = computed(() => (sourceId.value ? refillPlan(sourceId.value, targetId.value) : []));
const rows = computed(() => {
  const q = props.search.trim().toLowerCase();
  return plan.value.filter((r) => !q || r.label.toLowerCase().includes(q));
});
const filtered = computed(() => props.search.trim() !== '');
const putIn = (r: RefillRow): number => typed.value[keyOf(r)] ?? r.refill;
const short = (r: RefillRow): boolean => putIn(r) < r.need;
const totals = computed(() => ({
  need: rows.value.reduce((n, r) => n + r.need, 0),
  putIn: rows.value.reduce((n, r) => n + putIn(r), 0),
  short: rows.value.filter((r) => r.need > 0 && short(r)).length,
  toFill: rows.value.filter((r) => r.need > 0).length,
}));
const claimable = computed(() => rows.value.filter((r) => r.inBox + putIn(r) > 0));
const replacing = computed(() => (targetId.value ? claimable.value.filter((r) => claimFor(targetId.value, r.productId, r.variantId) !== null).length : 0));
const source = computed(() => [...props.pastEvents, ...props.upcomingEvents].find((e) => e.id === sourceId.value));
const target = computed(() => props.upcomingEvents.find((e) => e.id === targetId.value));
const sourceHasPrices = computed(() => Boolean(source.value?.localCurrency));

const imageOf = (r: RefillRow): string | undefined => {
  const p = getProduct(r.productId);
  return (r.variantId && p?.variants.find((v) => v.id === r.variantId)?.imageId) || p?.imageId;
};
const typeOf = (r: RefillRow): string => getProduct(r.productId)?.type?.trim() || 'Other';
const blurOnWheel = (e: WheelEvent): void => (e.target as HTMLInputElement).blur();

function setPutIn(r: RefillRow, value: string): void {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  typed.value = { ...typed.value, [keyOf(r)]: n };
}
function togglePacked(r: RefillRow): void {
  const next = new Set(packed.value);
  if (next.has(keyOf(r))) next.delete(keyOf(r));
  else next.add(keyOf(r));
  packed.value = next;
}

async function claim(): Promise<void> {
  const to = target.value;
  const from = source.value;
  const list = claimable.value;
  if (!to || !from || !list.length) return;
  const units = list.reduce((n, r) => n + r.inBox + putIn(r), 0);
  const which = filtered.value ? 'shown ' : '';
  const prices = matchPrices.value && sourceHasPrices.value ? ` and match ${from.name}'s ${from.localCurrency} prices` : '';
  const replaced = replacing.value ? ` ${replacing.value} of them already have a claim there, which is replaced.` : '';
  const ok = await shellConfirm(
    `Claim the refilled boxes of ${list.length} ${which}item${list.length === 1 ? '' : 's'} (${units} unit${units === 1 ? '' : 's'}) for ${to.name}${prices}? What came back from ${from.name} is carried on; the rest comes from home.${replaced}`,
    'Claim the boxes',
  );
  if (!ok) return;
  busy.value = true;
  error.value = null;
  note.value = '';
  try {
    const refills = Object.fromEntries(list.map((r) => [keyOf(r), putIn(r)]));
    const done = await claimRefill(from.id, to.id, refills, new Set(list.map(keyOf)));
    if (matchPrices.value && sourceHasPrices.value) await copyEventPricing(from.id, to.id);
    note.value = `Claimed ${done.units} unit${done.units === 1 ? '' : 's'} across ${done.items} item${done.items === 1 ? '' : 's'} for ${to.name}.`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not claim the boxes.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="refill">
    <div class="pick">
      <label>
        <span>After</span>
        <select v-model="sourceId">
          <option value="">Pick an event</option>
          <option v-for="event in sources" :key="event.id" :value="event.id">{{ event.name }}</option>
        </select>
      </label>
      <label>
        <span>Next event</span>
        <select v-model="targetId">
          <option value="">Pick an event</option>
          <option v-for="event in targets" :key="event.id" :value="event.id">{{ event.name }}</option>
        </select>
      </label>
      <label v-if="canEdit && sourceHasPrices && targetId" class="check">
        <input v-model="matchPrices" type="checkbox" />
        Also match its prices ({{ source?.localCurrency }}, rate and overrides)
      </label>
      <button v-if="canEdit" type="button" class="primary" :disabled="busy || !targetId || !claimable.length" @click="claim">
        {{ busy ? 'Claiming…' : target ? `Claim the boxes for ${target.name}` : 'Claim the boxes' }}
      </button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="note" class="ok" role="status">{{ note }}</p>

    <p class="lede">
      Each item {{ source?.name ?? 'the event' }} claimed, with what came back unsold and how many to put in from home to fill the box back up to the claim - most first.
      At home is what nobody else has claimed, outside the box. Claiming carries what came back on to the next event and takes the rest from home; type a different number to put in less or more.
    </p>

    <p v-if="!sources.length" class="empty">No event has claimed stock yet - claim what goes in the boxes under "Claimed for an event".</p>
    <p v-else-if="!sourceId" class="empty">Pick the event the boxes came back from.</p>
    <p v-else-if="!rows.length" class="empty">Nothing matches the search.</p>

    <template v-else>
      <ul class="totals">
        <li><span class="label">To put in</span><strong>{{ totals.need }}</strong><span class="sub">across {{ totals.toFill }} item{{ totals.toFill === 1 ? '' : 's' }}</span></li>
        <li><span class="label">Going in</span><strong>{{ totals.putIn }}</strong></li>
        <li v-if="totals.short"><span class="label">Short</span><strong class="bad">{{ totals.short }}</strong><span class="sub">not enough at home</span></li>
      </ul>

      <div class="table-scroll"><table>
        <thead>
          <tr>
            <th>Item</th>
            <th class="num">Claimed</th>
            <th class="num">Sold</th>
            <th class="num">Came back</th>
            <th class="num">Put in</th>
            <th class="num">At home</th>
            <th class="num">In</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="keyOf(r)" :class="{ short: r.need > 0 && short(r), done: packed.has(keyOf(r)), full: r.need === 0 }">
            <td class="item">
              <div class="what">
                <span class="swatch" :style="{ background: typeColor(typeOf(r)) }"></span>
                <ProductThumb :image-id="imageOf(r)" :alt="r.label" :size="28" />
                <span class="name">{{ r.label }}</span>
              </div>
            </td>
            <td class="num" data-label="Claimed">{{ r.claimed }}</td>
            <td class="num" data-label="Sold">{{ r.sold }}</td>
            <td class="num" data-label="Came back">{{ r.inBox }}</td>
            <td class="num" data-label="Put in">
              <input
                v-if="canEdit && r.need > 0"
                type="number"
                min="0"
                inputmode="numeric"
                :value="putIn(r)"
                :aria-label="`Units to put in for ${r.label}`"
                @wheel="blurOnWheel"
                @change="setPutIn(r, ($event.target as HTMLInputElement).value)"
              />
              <strong v-else>{{ putIn(r) }}</strong>
            </td>
            <td class="num" data-label="At home" :class="{ bad: r.need > 0 && r.home !== null && r.home < r.need }">
              {{ r.home === null ? 'not counted' : r.home }}
            </td>
            <td class="num" data-label="In">
              <input type="checkbox" :checked="packed.has(keyOf(r))" :aria-label="`${r.label} is in the box`" @change="togglePacked(r)" />
            </td>
          </tr>
        </tbody>
      </table></div>
    </template>
  </div>
</template>

<style scoped>
.refill { display: flex; flex-direction: column; gap: .75rem; }
.pick { display: flex; align-items: flex-end; gap: .6rem; flex-wrap: wrap; font-size: .875rem; }
.pick label { display: flex; flex-direction: column; gap: .25rem; }
.pick .check { flex-direction: row; align-items: center; gap: .4rem; }
.lede, .empty { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .9rem; max-width: 70ch; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.ok { color: var(--zfy-accent-ink, #0a5a4a); margin: 0; font-size: .875rem; }
.totals { list-style: none; margin: 0; padding: 0; display: flex; gap: .75rem; flex-wrap: wrap; }
.totals li { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .9rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; min-width: 8rem; }
.totals .label { font-size: .75rem; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.totals strong { font-size: 1.2rem; font-variant-numeric: tabular-nums; }
.totals .sub { font-size: .75rem; color: var(--zfy-muted, #5a6472); }
th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); font-size: .9rem; white-space: nowrap; }
tbody tr:last-child td { border-bottom: none; }
tbody tr.short { background: var(--zfy-signal-soft, #f6e5df); }
tbody tr.full td, tbody tr.done td { color: var(--zfy-muted, #5a6472); }
tbody tr.done td.item .name { text-decoration: line-through; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.num input[type='number'] { width: 5.5rem; text-align: right; }
.num input[type='checkbox'] { width: 1.2rem; height: 1.2rem; }
.bad { color: var(--zfy-danger, #c6512f); font-weight: 600; }
.swatch { flex: none; width: .35rem; height: .8rem; border-radius: 999px; }
td.item { white-space: normal; min-width: 14rem; }
.what { display: flex; align-items: center; gap: .5rem; }

/* Packing at the shelf with a phone: one card per item, the number to put in big. */
@media (max-width: 600px) {
  .table-scroll table, .table-scroll tbody { display: block; min-width: 0; }
  .table-scroll thead { display: none; }
  .table-scroll tbody tr { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .3rem .6rem; padding: .7rem .75rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
  .table-scroll td { border: 0; padding: 0; white-space: normal; }
  .table-scroll td.item { grid-column: 1 / -1; min-width: 0; }
  .table-scroll td.num { text-align: left; }
  .table-scroll td.num::before { content: attr(data-label); display: block; font-size: .7rem; letter-spacing: .04em; color: var(--zfy-muted, #5a6472); }
  .num input[type='number'] { width: 100%; min-height: 2.6rem; font-size: 1.05rem; text-align: left; }
  .num input[type='checkbox'] { width: 1.6rem; height: 1.6rem; }
}
</style>
