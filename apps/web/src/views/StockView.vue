<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { EventStock } from '@boothly/shared';
import {
  activeEventId,
  allProducts,
  currentAccount,
  recentTransactions,
  setStock,
  stockForEvent,
  visibleEvents,
} from '@boothly/platform';

/**
 * Per-event stock: what was brought, what sold, what should still be in the box.
 *
 * "Remaining" is derived from recorded sales rather than decremented on each
 * one. A counter that is written on every sale drifts the moment a sale is
 * reverted or arrives late from another register; recomputing cannot drift.
 */

const account = currentAccount;
const eventId = ref<string>('');
const brought = ref<Map<string, number>>(new Map());
const error = ref<string | null>(null);
const saving = ref<string | null>(null);

const canEdit = computed(
  () => account.value?.role === 'owner' || account.value?.role === 'admin',
);

/** Stock is tracked per product and variant; '' is the product itself. */
function key(productId: string, variantId: string): string {
  return `${productId}:${variantId}`;
}

interface Row {
  productId: string;
  variantId: string;
  label: string;
  brought: number;
  sold: number;
  remaining: number;
}

const soldByKey = computed(() => {
  const counts = new Map<string, number>();
  for (const tx of recentTransactions.value) {
    if (tx.eventId !== eventId.value || tx.revertedAt) continue;
    for (const item of tx.items) {
      const k = key(item.pid, item.vid ?? '');
      counts.set(k, (counts.get(k) ?? 0) + item.qty);
    }
  }
  return counts;
});

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  for (const product of allProducts.value) {
    const variants = product.variants ?? [];
    const entries = variants.length
      ? variants.map((v) => ({ id: v.id, label: `${product.title} · ${v.name}` }))
      : [{ id: '', label: product.title }];

    for (const entry of entries) {
      const k = key(product.id, entry.id);
      const b = brought.value.get(k) ?? 0;
      const sold = soldByKey.value.get(k) ?? 0;
      out.push({
        productId: product.id,
        variantId: entry.id,
        label: entry.label,
        brought: b,
        sold,
        remaining: b - sold,
      });
    }
  }
  return out;
});

const totals = computed(() => ({
  brought: rows.value.reduce((n, r) => n + r.brought, 0),
  sold: rows.value.reduce((n, r) => n + r.sold, 0),
  remaining: rows.value.reduce((n, r) => n + Math.max(0, r.remaining), 0),
}));

async function load(): Promise<void> {
  if (!eventId.value) {
    brought.value = new Map();
    return;
  }
  try {
    const rowsForEvent = await stockForEvent(eventId.value);
    brought.value = new Map(
      rowsForEvent.map((r) => [key(r.productId, r.variantId ?? ''), r.broughtQty]),
    );
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load stock.';
  }
}

onMounted(() => {
  eventId.value = activeEventId.value ?? visibleEvents.value[0]?.id ?? '';
  void load();
});

watch(eventId, () => void load());

async function updateBrought(row: Row, value: number): Promise<void> {
  if (!eventId.value) return;
  const qty = Math.max(0, Math.floor(value));
  const k = key(row.productId, row.variantId);
  brought.value = new Map(brought.value).set(k, qty);

  saving.value = k;
  error.value = null;
  try {
    const entry: EventStock = {
      eventId: eventId.value,
      productId: row.productId,
      variantId: row.variantId,
      broughtQty: qty,
      updatedAt: Date.now(),
    };
    await setStock(entry);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save that count.';
  } finally {
    saving.value = null;
  }
}
</script>

<template>
  <section class="stock">
    <header>
      <h1>Stock</h1>
      <label class="scope">
        <span>Event</span>
        <select v-model="eventId">
          <option value="">Pick an event</option>
          <option v-for="event in visibleEvents" :key="event.id" :value="event.id">
            {{ event.name }}{{ event.id === activeEventId ? ' (active)' : '' }}
          </option>
        </select>
      </label>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <p v-if="!eventId" class="empty">Pick an event to plan what you're taking.</p>
    <p v-else-if="!rows.length" class="empty">No products yet — add some in Catalog.</p>

    <template v-else>
      <ul class="totals">
        <li><span class="label">Brought</span><strong>{{ totals.brought }}</strong></li>
        <li><span class="label">Sold</span><strong>{{ totals.sold }}</strong></li>
        <li><span class="label">Remaining</span><strong>{{ totals.remaining }}</strong></li>
      </ul>

      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th class="num">Brought</th>
            <th class="num">Sold</th>
            <th class="num">Remaining</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.productId + row.variantId"
            :class="{ short: row.remaining < 0 }"
          >
            <td>{{ row.label }}</td>
            <td class="num">
              <input
                v-if="canEdit"
                type="number"
                min="0"
                :value="row.brought"
                :aria-label="`Brought quantity for ${row.label}`"
                @change="updateBrought(row, Number(($event.target as HTMLInputElement).value))"
              />
              <span v-else>{{ row.brought }}</span>
            </td>
            <td class="num">{{ row.sold }}</td>
            <!-- Negative means more sold than the count says was brought: the
                 count is wrong, not the sales, so it is flagged rather than clamped. -->
            <td class="num">{{ row.remaining }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>

<style scoped>
.stock { display: flex; flex-direction: column; gap: 1rem; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
.scope { display: flex; align-items: center; gap: .5rem; font-size: .875rem; }
.empty { color: var(--bly-muted, #5a6472); margin: 0; }
.error { color: var(--bly-danger, #c6512f); margin: 0; }
.totals { list-style: none; margin: 0; padding: 0; display: flex; gap: .75rem; flex-wrap: wrap; }
.totals li { border: 1px solid var(--bly-line, #d6dde4); border-radius: 10px; padding: .6rem .9rem; background: var(--bly-surface, #fff); display: flex; flex-direction: column; min-width: 7rem; }
.totals .label { font-size: .75rem; letter-spacing: .06em; color: var(--bly-muted, #5a6472); }
.totals strong { font-size: 1.2rem; font-variant-numeric: tabular-nums; }
table { width: 100%; border-collapse: collapse; background: var(--bly-surface, #fff); border: 1px solid var(--bly-line, #d6dde4); border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid var(--bly-line, #d6dde4); font-size: .9rem; }
tbody tr:last-child td { border-bottom: none; }
tbody tr.short { background: var(--bly-signal-soft, #f6e5df); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.num input { width: 5rem; text-align: right; }
</style>
