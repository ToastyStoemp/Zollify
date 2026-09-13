<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { CURRENCY_BILLS, fmtPrice, round2 } from '@boothly/shared';
import {
  activeEventId,
  recentTransactions,
  visibleEvents,
} from '@boothly/platform';

/**
 * Cash up.
 *
 * The question at the end of a convention is narrow: how much cash should be
 * in the box, how much actually is, and what is the difference. Card takings
 * are shown for completeness but never counted — the terminal's own settlement
 * is the authority there, not this screen.
 */

const eventId = ref<string>(activeEventId.value ?? visibleEvents.value[0]?.id ?? '');
const counted = ref<Map<number, number>>(new Map());
const float = ref(0);

const sales = computed(() =>
  recentTransactions.value.filter((tx) => tx.eventId === eventId.value && !tx.revertedAt),
);

const currency = computed(() => sales.value[0]?.currency ?? 'CHF');

/** Denominations for the event's currency, largest first. */
const denominations = computed(() => {
  const bills = CURRENCY_BILLS[currency.value] ?? CURRENCY_BILLS.CHF ?? [];
  return [...bills].sort((a, b) => b - a);
});

const takings = computed(() => {
  let cash = 0;
  let card = 0;
  for (const tx of sales.value) {
    for (const leg of tx.payments) {
      if (leg.kind === 'cash') cash += leg.amount;
      else card += leg.amount;
    }
  }
  return { cash: round2(cash), card: round2(card), total: round2(cash + card) };
});

const reverted = computed(() =>
  round2(
    recentTransactions.value
      .filter((tx) => tx.eventId === eventId.value && tx.revertedAt)
      .reduce((n, tx) => n + tx.total, 0),
  ),
);

const countedTotal = computed(() =>
  round2([...counted.value.entries()].reduce((sum, [value, qty]) => sum + value * qty, 0)),
);

/** What should be in the box: the float you started with plus cash taken. */
const expected = computed(() => round2(float.value + takings.value.cash));

const variance = computed(() => round2(countedTotal.value - expected.value));

// Counting is per event, so switching events must not carry a count across.
watch(eventId, () => {
  counted.value = new Map();
});

function setCount(value: number, qty: number): void {
  const next = new Map(counted.value);
  if (qty > 0) next.set(value, Math.floor(qty));
  else next.delete(value);
  counted.value = next;
}

function label(value: number): string {
  return value < 1 ? `${Math.round(value * 100)}c` : String(value);
}
</script>

<template>
  <section class="cashup">
    <header>
      <h1>Cash up</h1>
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

    <p v-if="!eventId" class="empty">Pick an event to cash up.</p>

    <template v-else>
      <ul class="totals">
        <li>
          <span class="label">Cash taken</span>
          <strong>{{ fmtPrice(takings.cash, currency) }}</strong>
        </li>
        <li>
          <span class="label">Card taken</span>
          <strong>{{ fmtPrice(takings.card, currency) }}</strong>
          <span class="sub">settled by the terminal</span>
        </li>
        <li>
          <span class="label">Total</span>
          <strong>{{ fmtPrice(takings.total, currency) }}</strong>
          <span class="sub">{{ sales.length }} sale{{ sales.length === 1 ? '' : 's' }}</span>
        </li>
        <li v-if="reverted > 0">
          <span class="label">Reverted</span>
          <strong class="bad">{{ fmtPrice(reverted, currency) }}</strong>
        </li>
      </ul>

      <div class="count">
        <h2>Count the box</h2>
        <label class="float">
          <span>Opening float</span>
          <input v-model.number="float" type="number" min="0" step="0.01" />
        </label>

        <div class="denoms">
          <label v-for="value in denominations" :key="value">
            <span>{{ label(value) }}</span>
            <input
              type="number"
              min="0"
              :value="counted.get(value) ?? 0"
              :aria-label="`Count of ${label(value)}`"
              @input="setCount(value, Number(($event.target as HTMLInputElement).value))"
            />
          </label>
        </div>

        <dl class="result">
          <dt>Counted</dt>
          <dd>{{ fmtPrice(countedTotal, currency) }}</dd>

          <dt>Expected</dt>
          <dd>{{ fmtPrice(expected, currency) }}</dd>

          <dt>Difference</dt>
          <!-- Shown signed, never as an absolute: over and short are different
               problems and reading them the same way hides one of them. -->
          <dd :class="{ bad: variance !== 0, good: variance === 0 }">
            {{ variance > 0 ? '+' : '' }}{{ fmtPrice(variance, currency) }}
            <template v-if="variance === 0"> · balanced</template>
            <template v-else-if="variance > 0"> · over</template>
            <template v-else> · short</template>
          </dd>
        </dl>
      </div>
    </template>
  </section>
</template>

<style scoped>
.cashup { display: flex; flex-direction: column; gap: 1rem; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: 1.05rem; }
.scope { display: flex; align-items: center; gap: .5rem; font-size: .875rem; }
.empty { color: var(--bly-muted, #5a6472); margin: 0; }
.totals { list-style: none; margin: 0; padding: 0; display: flex; gap: .75rem; flex-wrap: wrap; }
.totals li { border: 1px solid var(--bly-line, #d6dde4); border-radius: 10px; padding: .6rem .9rem; background: var(--bly-surface, #fff); display: flex; flex-direction: column; min-width: 9rem; }
.totals .label { font-size: .75rem; letter-spacing: .06em; color: var(--bly-muted, #5a6472); }
.totals strong { font-size: 1.2rem; font-variant-numeric: tabular-nums; }
.totals .sub { font-size: .75rem; color: var(--bly-muted, #5a6472); }
.count { border: 1px solid var(--bly-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--bly-surface, #fff); display: flex; flex-direction: column; gap: .75rem; max-width: 34rem; }
.float { display: flex; align-items: center; gap: .5rem; font-size: .875rem; }
.float input { width: 8rem; }
.denoms { display: grid; grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr)); gap: .4rem; }
.denoms label { display: flex; align-items: center; gap: .4rem; font-size: .875rem; }
.denoms input { width: 100%; text-align: right; }
.result { display: grid; grid-template-columns: 8rem 1fr; gap: .3rem 1rem; margin: 0; border-top: 1px solid var(--bly-line, #d6dde4); padding-top: .75rem; font-variant-numeric: tabular-nums; }
.result dt { color: var(--bly-muted, #5a6472); font-size: .875rem; }
.result dd { margin: 0; font-weight: 600; }
.bad { color: var(--bly-danger, #c6512f); }
.good { color: var(--bly-accent-ink, #0a5a4a); }
</style>
