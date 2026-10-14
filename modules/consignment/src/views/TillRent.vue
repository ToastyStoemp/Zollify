<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { RENT_REF_KIND, fmtPrice, isStore } from '@zollify/shared';
import { errorText, tillRent, type TillRental } from '../api';
import { sdk } from '../runtime';

/**
 * Over the till: take rent for a space. Pick the artist's rental, see what
 * it owes, and the amount goes in the cart like any item - store income, not
 * the artist's. Read back from the sale itself, so a refund un-pays it.
 */
const emit = defineEmits<{ close: [] }>();

const store = computed(() => sdk().data.events.active());
const rows = ref<TillRental[] | null>(null);
const counted = ref<Set<string>>(new Set());
const error = ref<string | null>(null);
const amounts = reactive<Record<string, string>>({});

/** Rent paid on this device that the server has not counted yet. */
const paidHere = computed(() => {
  const paid = new Map<string, number>();
  for (const tx of sdk().data.transactions.recent()) {
    if (tx.revertedAt || counted.value.has(tx.id)) continue;
    for (const item of tx.items) if (item.ref?.kind === RENT_REF_KIND) paid.set(item.ref.id, (paid.get(item.ref.id) ?? 0) + item.lineTotal);
  }
  return paid;
});

const paid = (r: TillRental): number => r.paidAtTill + (paidHere.value.get(r.id) ?? 0);
const owing = (r: TillRental): number => Math.round((r.charged - paid(r)) * 100) / 100;

onMounted(async () => {
  if (!store.value || !isStore(store.value)) return;
  try {
    const res = await tillRent(store.value.id);
    counted.value = new Set(res.counted);
    rows.value = res.rentals;
    for (const r of res.rentals) amounts[r.id] = String(owing(r) > 0 ? owing(r) : r.monthlyFee);
  } catch (err) {
    error.value = errorText(err, 'Could not load rentals - this needs a connection.');
  }
});

const amountOf = (r: TillRental): number => Math.round(Number(amounts[r.id]) * 100) / 100;

function charge(r: TillRental): void {
  const amount = amountOf(r);
  if (!(amount > 0)) return;
  const added = sdk().till.addLine({
    key: `rent:${r.id}`,
    name: `Rent · ${r.spaceName} · ${r.consignorName}`,
    qty: 1,
    unitPrice: amount,
    ref: { kind: RENT_REF_KIND, id: r.id },
  });
  if (added) emit('close');
}
</script>

<template>
  <div class="till-rent">
    <p v-if="!store || !isStore(store)" class="hint">Open a store's till to take rent for its spaces.</p>
    <template v-else>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="!rows && !error" class="hint">Loading…</p>
      <p v-else-if="rows && !rows.length" class="hint">No spaces rented at {{ store.name }}. Rentals are booked in Consignment → Planner.</p>
      <article v-for="r in rows ?? []" :key="r.id" class="rental">
        <header>
          <strong>{{ r.consignorName }}</strong>
          <span class="hint">{{ r.spaceName }} · {{ fmtPrice(r.monthlyFee, r.currency) }} a month</span>
          <span class="hint">
            Charged {{ fmtPrice(r.charged, r.currency) }} · paid here {{ fmtPrice(paid(r), r.currency) }} ·
            <strong v-if="owing(r) > 0">owes {{ fmtPrice(owing(r), r.currency) }}</strong>
            <template v-else-if="owing(r) < 0">{{ fmtPrice(-owing(r), r.currency) }} ahead</template>
            <template v-else>paid up</template>
          </span>
          <span v-if="r.deductFromSales" class="hint">Rent also comes off their sales - what they pay here is taken off that.</span>
        </header>
        <div class="pay">
          <input v-model="amounts[r.id]" type="number" min="0.01" step="0.01" inputmode="decimal" :aria-label="`Rent from ${r.consignorName}`" />
          <button type="button" class="primary" :disabled="!(amountOf(r) > 0)" @click="charge(r)">Charge {{ amountOf(r) > 0 ? fmtPrice(amountOf(r), r.currency) : '' }}</button>
        </div>
      </article>
    </template>
  </div>
</template>

<style scoped>
.till-rent { display: flex; flex-direction: column; gap: .8rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.rental { display: flex; flex-direction: column; gap: .4rem; padding-bottom: .7rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
.rental:last-child { border-bottom: 0; }
.rental header { display: flex; flex-direction: column; gap: .1rem; }
.pay { display: flex; gap: .4rem; }
.pay input { flex: 1 1 6rem; min-width: 0; }
</style>
