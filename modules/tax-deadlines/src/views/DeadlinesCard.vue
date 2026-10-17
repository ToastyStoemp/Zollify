<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ACTION_LABELS, daysBetween, dueIn, localIsoDay } from '@zollify/shared';
import { Icon } from '@zollify/ui';
import { doneSet, loadState, state } from '../api';
import { groupDeadlines } from '../list';

/** Home screen: missed deadlines and those in the next 30 days, at most five. */
const SHOW = 5;
const failed = ref(false);
const today = localIsoDay();
onMounted(() => loadState().catch(() => (failed.value = true)));

const settings = computed(() => state.value?.settings ?? null);
const items = computed(() => {
  if (!settings.value?.configured) return [];
  const g = groupDeadlines(settings.value, doneSet(state.value), today);
  return [...g.overdue, ...g.soon];
});
const fmtDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
</script>

<template>
  <div class="card-body">
    <header class="head">
      <h2>Tax deadlines</h2>
      <Icon name="calendar" :size="16" />
    </header>
    <p v-if="failed" class="empty">Could not load your deadlines.</p>
    <p v-else-if="!settings" class="empty">Loading…</p>
    <p v-else-if="!settings.configured" class="empty">Set up your tax profile to see what is due and get reminders.</p>
    <p v-else-if="!items.length" class="empty">Nothing due in the next 30 days.</p>
    <ul v-else class="list">
      <li v-for="d in items.slice(0, SHOW)" :key="d.id">
        <span class="what">{{ d.title }}<small>{{ ACTION_LABELS[d.action] }}</small></span>
        <strong :class="{ bad: d.due < today, warn: d.due >= today && daysBetween(today, d.due) <= 3 }">{{ d.due < today ? dueIn(d.due, today) : fmtDay(d.due) }}</strong>
      </li>
    </ul>
    <p v-if="items.length > SHOW" class="empty">and {{ items.length - SHOW }} more</p>
    <footer class="foot">
      <a href="#/m/tax-deadlines">{{ settings?.configured ? 'All deadlines' : 'Set up' }} <Icon name="chevron-right" :size="14" /></a>
    </footer>
  </div>
</template>

<style scoped>
.card-body { display: flex; flex-direction: column; gap: .6rem; }
.head { display: flex; align-items: center; justify-content: space-between; }
h2 { margin: 0; font-size: 1rem; }
.head .zfy-icon { color: var(--zfy-muted); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
.list li { display: flex; justify-content: space-between; align-items: baseline; gap: .6rem; font-size: .88rem; }
.what { display: flex; flex-direction: column; min-width: 0; }
.what small { color: var(--zfy-muted); font-size: .75rem; }
.list strong { font-variant-numeric: tabular-nums; white-space: nowrap; }
.list strong.bad { color: var(--zfy-danger); }
.list strong.warn { color: var(--zfy-warning-ink, #8a5a1e); }
.empty { margin: 0; color: var(--zfy-muted); font-size: .85rem; }
.foot { display: flex; justify-content: flex-end; }
.foot a { display: inline-flex; align-items: center; gap: .2rem; font-size: .85rem; }
</style>
