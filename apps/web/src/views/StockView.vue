<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  activeEventId,
  availabilityFor,
  clearClaim,
  currentAccount,
  getProduct,
  inventoryLoaded,
  inventoryRows,
  loadInventory,
  setClaim,
  setOnHand,
  visibleEvents,
} from '@zollify/platform';
import { typeColor } from '@zollify/ui';
import ProductThumb from '../components/ProductThumb.vue';

/**
 * One inventory, with per-event claims on top.
 *
 * Two views of the same stock: what the booth owns, and what a given event has
 * set aside. An event with no claim sells from whatever is unclaimed, which is
 * the normal case for a booth working one event at a time — so claiming is
 * opt-in rather than something to fill in for every event.
 */

const account = currentAccount;
const mode = ref<'inventory' | 'claims'>('inventory');
const eventId = ref<string>('');
const error = ref<string | null>(null);

const canEdit = computed(
  () => account.value?.role === 'owner' || account.value?.role === 'admin',
);

const stock = computed(() => inventoryRows());
const claims = computed(() => (eventId.value ? availabilityFor(eventId.value) : []));

/** Rows grouped by product type, matching the catalogue and the till; a search narrows both tables. */
const search = ref('');
function grouped<T extends { productId: string; variantId: string; label: string }>(rows: T[]): { type: string; rows: T[] }[] {
  const q = search.value.trim().toLowerCase();
  const map = new Map<string, T[]>();
  for (const r of rows) {
    if (q && !r.label.toLowerCase().includes(q)) continue;
    const type = getProduct(r.productId)?.type?.trim() || 'Other';
    (map.get(type) ?? map.set(type, []).get(type)!).push(r);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([type, list]) => ({ type, rows: list }));
}
const stockGroups = computed(() => grouped(stock.value));
const claimGroups = computed(() => grouped(claims.value));
const imageOf = (productId: string, variantId: string): string | undefined => {
  const p = getProduct(productId);
  return (variantId && p?.variants.find((v) => v.id === variantId)?.imageId) || p?.imageId;
};

const totals = computed(() => ({
  onHand: stock.value.reduce((n, r) => n + r.onHand, 0),
  claimed: stock.value.reduce((n, r) => n + r.claimed, 0),
  sold: stock.value.reduce((n, r) => n + r.sold, 0),
  free: stock.value.reduce((n, r) => n + r.free, 0),
}));

const overCommitted = computed(() => stock.value.filter((r) => r.overCommitted));

/**
 * Over-commitment has two causes and they need different fixes, so the message
 * names whichever one actually applies rather than always blaming claims.
 */
const overCommitMessage = computed(() => {
  const rows = overCommitted.value;
  if (!rows.length) return '';

  const fromClaims = rows.some((r) => r.claimed > 0);
  const count = `${rows.length} item${rows.length === 1 ? '' : 's'}`;

  if (fromClaims) {
    return `${count} ${rows.length === 1 ? 'is' : 'are'} claimed or sold beyond what's counted in. Reduce a claim, or count more in.`;
  }
  return `${count} ${rows.length === 1 ? 'has' : 'have'} sold more than the count says exists. Count what's actually there.`;
});

onMounted(async () => {
  eventId.value = activeEventId.value ?? visibleEvents.value[0]?.id ?? '';
  if (!inventoryLoaded.value) {
    await loadInventory().catch((err) => {
      error.value = err instanceof Error ? err.message : 'Could not load inventory.';
    });
  }
});

watch(mode, (next) => {
  if (next === 'claims' && !eventId.value) {
    eventId.value = activeEventId.value ?? visibleEvents.value[0]?.id ?? '';
  }
});

async function updateOnHand(productId: string, variantId: string, value: number): Promise<void> {
  error.value = null;
  try {
    await setOnHand(productId, variantId, value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save that count.';
  }
}

async function updateClaim(productId: string, variantId: string, value: string): Promise<void> {
  if (!eventId.value) return;
  error.value = null;
  try {
    // Blank means "no claim" — the event falls back to the shared pool. Zero
    // is different: it deliberately reserves nothing.
    if (value.trim() === '') await clearClaim(eventId.value, productId, variantId);
    else await setClaim(eventId.value, productId, variantId, Number(value));
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save that claim.';
  }
}
</script>

<template>
  <section class="stock">
    <header>
      <h1>Inventory</h1>
      <div class="tabs">
        <button type="button" :class="{ active: mode === 'inventory' }" @click="mode = 'inventory'">
          What we own
        </button>
        <button type="button" :class="{ active: mode === 'claims' }" @click="mode = 'claims'">
          Claimed for an event
        </button>
      </div>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <input v-model="search" type="search" class="search" placeholder="Search items…" aria-label="Search items" />

    <!-- ── The one inventory ────────────────────────────────────────────── -->
    <template v-if="mode === 'inventory'">
      <ul class="totals">
        <li><span class="label">On hand</span><strong>{{ totals.onHand }}</strong></li>
        <li><span class="label">Claimed</span><strong>{{ totals.claimed }}</strong></li>
        <li><span class="label">Sold</span><strong>{{ totals.sold }}</strong></li>
        <li>
          <span class="label">Free</span>
          <strong :class="{ bad: totals.free < 0 }">{{ totals.free }}</strong>
          <span class="sub">unclaimed and unsold</span>
        </li>
      </ul>

      <p v-if="overCommitMessage" class="warn" role="alert">{{ overCommitMessage }}</p>

      <p v-if="!stock.length" class="empty">No products yet — add some in Catalog.</p>

      <div v-else class="table-scroll"><table>
        <thead>
          <tr>
            <th>Item</th>
            <th class="num">On hand</th>
            <th class="num">Claimed</th>
            <th class="num">Sold</th>
            <th class="num">Free</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="g in stockGroups" :key="g.type">
          <tr class="group"><th colspan="5"><span class="swatch" :style="{ background: typeColor(g.type) }"></span>{{ g.type }}</th></tr>
          <tr
            v-for="row in g.rows"
            :key="row.productId + row.variantId"
            :class="{ short: row.overCommitted }"
          >
            <td class="item"><ProductThumb :image-id="imageOf(row.productId, row.variantId)" :alt="row.label" :size="28" /><span>{{ row.label }}</span></td>
            <td class="num">
              <input
                v-if="canEdit"
                type="number"
                min="0"
                :value="row.onHand"
                :aria-label="`Units owned of ${row.label}`"
                @change="updateOnHand(row.productId, row.variantId, Number(($event.target as HTMLInputElement).value))"
              />
              <span v-else>{{ row.onHand }}</span>
            </td>
            <td class="num">{{ row.claimed }}</td>
            <td class="num">{{ row.sold }}</td>
            <td class="num" :class="{ bad: row.free < 0 }">{{ row.free }}</td>
          </tr>
          </template>
        </tbody>
      </table></div>
    </template>

    <!-- ── Claims for one event ─────────────────────────────────────────── -->
    <template v-else>
      <label class="scope">
        <span>Event</span>
        <select v-model="eventId">
          <option value="">Pick an event</option>
          <option v-for="event in visibleEvents" :key="event.id" :value="event.id">
            {{ event.name }}{{ event.id === activeEventId ? ' (active)' : '' }}
          </option>
        </select>
      </label>

      <p class="hint">
        Claiming reserves stock for this event — no other event can sell it. Leave a claim blank and
        the event sells from whatever is unclaimed. Selling past a claim takes the extra from the
        unclaimed stock.
      </p>

      <p v-if="!eventId" class="empty">Pick an event to plan what it takes.</p>
      <p v-else-if="!claims.length" class="empty">No products yet — add some in Catalog.</p>

      <div v-else class="table-scroll"><table>
        <thead>
          <tr>
            <th>Item</th>
            <th class="num">Claim</th>
            <th class="num">Sold here</th>
            <th class="num">Available</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="g in claimGroups" :key="g.type">
          <tr class="group"><th colspan="5"><span class="swatch" :style="{ background: typeColor(g.type) }"></span>{{ g.type }}</th></tr>
          <tr
            v-for="row in g.rows"
            :key="row.productId + row.variantId"
            :class="{ short: row.available < 0 }"
          >
            <td class="item"><ProductThumb :image-id="imageOf(row.productId, row.variantId)" :alt="row.label" :size="28" /><span>{{ row.label }}</span></td>
            <td class="num">
              <input
                v-if="canEdit"
                type="number"
                min="0"
                placeholder="—"
                :value="row.claimed ?? ''"
                :aria-label="`Claim for ${row.label}`"
                @change="updateClaim(row.productId, row.variantId, ($event.target as HTMLInputElement).value)"
              />
              <span v-else>{{ row.claimed ?? '—' }}</span>
            </td>
            <td class="num">{{ row.soldHere }}</td>
            <!-- Negative means more was sold than the claim allowed: the claim
                 is wrong, not the sales, so it is flagged rather than clamped. -->
            <td class="num" :class="{ bad: row.available < 0 }">{{ row.available }}</td>
            <td class="source">
              <template v-if="row.source === 'claim'">reserved</template>
              <template v-else>
                shared pool
                <span v-if="row.reservedElsewhere" class="sub">
                  · {{ row.reservedElsewhere }} held by other events
                </span>
              </template>
            </td>
          </tr>
          </template>
        </tbody>
      </table></div>
    </template>
  </section>
</template>

<style scoped>
.stock { display: flex; flex-direction: column; gap: 1rem; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
.tabs { display: flex; gap: .3rem; }
.tabs button.active { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); border-color: var(--zfy-accent, #0e7c66); font-weight: 600; }
.scope { display: flex; align-items: center; gap: .5rem; font-size: .875rem; }
.empty, .hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .9rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.warn { color: var(--zfy-danger, #c6512f); margin: 0; font-size: .9rem; }
.totals { list-style: none; margin: 0; padding: 0; display: flex; gap: .75rem; flex-wrap: wrap; }
.totals li { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .9rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; min-width: 8rem; }
.totals .label { font-size: .75rem; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.totals strong { font-size: 1.2rem; font-variant-numeric: tabular-nums; }
.totals .sub, .source .sub { font-size: .75rem; color: var(--zfy-muted, #5a6472); }
table { width: 100%; border-collapse: collapse; background: var(--zfy-surface, #fff); border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); font-size: .9rem; white-space: nowrap; }
tbody tr:last-child td { border-bottom: none; }
tbody tr.short { background: var(--zfy-signal-soft, #f6e5df); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.num input { width: 5.5rem; text-align: right; }
.source { color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.bad { color: var(--zfy-danger, #c6512f); font-weight: 600; }
.search { max-width: 18rem; }
tr.group th { padding: .35rem .75rem; font-size: .75rem; font-weight: 600; background: var(--zfy-bg, #f1f4f6); }
.swatch { display: inline-block; width: .35rem; height: .8rem; border-radius: 999px; margin-right: .5rem; vertical-align: middle; }
td.item { white-space: normal; }
td.item span { display: inline-block; vertical-align: middle; margin-left: .5rem; }
td.item :deep(img), td.item :deep(.thumb) { vertical-align: middle; }
.stock { max-width: 64rem; }
</style>
