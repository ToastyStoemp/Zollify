<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { fmtPrice, localIsoDay } from '@zollify/shared';
import { Icon } from '@zollify/ui';
import { api } from '../api';
import { sdk } from '../runtime';
import { vatByEvent } from '../ledger-vat';
import { lastAgainstSeries, rankEvents, type EventFigures } from '../ranking';

/**
 * Home screen: how the last event did, against the average of its earlier
 * editions - one line to answer "was it worth it?" before the next one.
 */
const figures = ref<Map<string, EventFigures>>(new Map());
onMounted(async () => {
  try {
    const { rows } = await api.pnl();
    const vat = vatByEvent(sdk().data.transactions.recent());
    figures.value = new Map(rows.map((r) => [r.eventId, { revenue: r.revenue, vat: vat[r.eventId] ?? 0, expenses: r.expenses, mixed: r.currencies.some((c) => c && c !== (r.currency || 'EUR')) }]));
  } catch {
    /* offline: revenue alone */
  }
});
const result = computed(() => lastAgainstSeries(rankEvents(sdk().data.events.list(), sdk().data.transactions.recent(), figures.value, localIsoDay())));
const diff = computed(() => {
  const r = result.value;
  if (!r || r.seriesAvg == null || r.last.perDay == null || r.seriesAvg === 0) return null;
  return Math.round(((r.last.perDay - r.seriesAvg) / Math.abs(r.seriesAvg)) * 100);
});
</script>

<template>
  <div class="card-body">
    <header class="head">
      <h2>Last event</h2>
      <Icon name="bar-chart" :size="16" />
    </header>
    <p v-if="!result" class="empty">No event is over yet.</p>
    <template v-else>
      <p class="line"><strong>{{ result.last.name }}</strong><span class="sub"> · {{ result.last.days || '?' }} day{{ result.last.days === 1 ? '' : 's' }}</span></p>
      <p class="line">{{ result.last.profit == null ? 'Revenue' : 'Profit' }} <strong>{{ fmtPrice(result.last.profit ?? result.last.revenue, result.last.currency) }}</strong><span v-if="result.last.perDay != null" class="sub"> · {{ fmtPrice(result.last.perDay, result.last.currency) }} per day</span></p>
      <p v-if="diff != null" class="line" :class="diff >= 0 ? 'good' : 'bad'">{{ diff >= 0 ? '+' : '' }}{{ diff }}% against the earlier editions of {{ result.seriesName }}</p>
      <p v-else class="sub">No earlier edition to compare with.</p>
      <router-link :to="{ name: 'tax:ranking' }" class="more">Event ranking</router-link>
    </template>
  </div>
</template>

<style scoped>
.card-body { display: flex; flex-direction: column; gap: .4rem; }
.head { display: flex; align-items: center; justify-content: space-between; }
h2 { margin: 0; font-size: 1rem; }
.line, .empty, .sub { margin: 0; font-size: .9rem; }
.empty, .sub { color: var(--zfy-muted, #5a6472); }
.good { color: var(--zfy-accent-ink, #0a5a4a); }
.bad { color: var(--zfy-danger, #c6512f); }
.more { font-size: .85rem; color: var(--zfy-accent-ink, #0a5a4a); }
</style>
