<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { errorText, loadConsignors, loaded } from '../api';
import { sdk } from '../runtime';
import ArtistsTab from './ArtistsTab.vue';
import ItemsTab from './ItemsTab.vue';
import StatementTab from './StatementTab.vue';
import PlannerTab from './PlannerTab.vue';
import ProgrammeTab from './ProgrammeTab.vue';
import ReportsTab from './ReportsTab.vue';

/**
 * One consignment page for the store owner. Each part (artists, items,
 * planner, store events, statement, reports) is its own page in the
 * sidebar's Stores section, so no screen carries all of them at once. The
 * artist's side is the separate "My stores" module.
 */
export type Page = 'artists' | 'items' | 'planner' | 'programme' | 'statement' | 'reports';
const props = defineProps<{ page: Page }>();
const TITLES: Record<Page, string> = { artists: 'Artists', items: 'Consigned items', planner: 'Planner', programme: 'Store events', statement: 'Statement', reports: 'Reports' };

/** Bumped when one of our notifications is opened, so the page reloads even if it was already showing. */
const revision = ref(0);
let off: (() => void) | null = null;
onMounted(() => {
  off = sdk().events.on('notification:opened', (n) => {
    if (n.moduleId === 'consignment') revision.value++;
  });
});
onUnmounted(() => off?.());
const error = ref<string | null>(null);
/** Handed from Artists to Items when "Items" is clicked on one artist. */
const focus = ref<string>(new URLSearchParams(location.hash.split('?')[1] ?? '').get('consignor') ?? '');

onMounted(async () => {
  try {
    await loadConsignors();
  } catch (err) {
    error.value = errorText(err, 'Could not load consignment.');
  }
});

function showItems(consignorId: string): void {
  location.hash = `#/m/consignment/items?consignor=${encodeURIComponent(consignorId)}`;
}
</script>

<template>
  <section class="consignment">
    <header><h1>{{ TITLES[props.page] }}</h1></header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!loaded && !error" class="hint">Loading…</p>
    <template v-else-if="loaded">
      <ArtistsTab v-if="props.page === 'artists'" :key="revision" @error="error = $event" @items="showItems" />
      <ItemsTab v-else-if="props.page === 'items'" :key="revision" v-model:consignor="focus" @error="error = $event" />
      <PlannerTab v-else-if="props.page === 'planner'" :key="revision" @error="error = $event" />
      <ProgrammeTab v-else-if="props.page === 'programme'" :key="revision" @error="error = $event" />
      <StatementTab v-else-if="props.page === 'statement'" :key="revision" @error="error = $event" />
      <ReportsTab v-else :key="revision" @error="error = $event" />
    </template>
  </section>
</template>

<style scoped>
.consignment { display: flex; flex-direction: column; gap: 1rem; max-width: 72rem; }
header { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
.seg { display: inline-flex; gap: .15rem; padding: .15rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); flex-wrap: wrap; }
.seg button { min-height: 2.2rem; padding: .1rem .8rem; font-size: .82rem; border: 0; border-radius: 6px; background: none; color: var(--zfy-muted, #5a6472); display: inline-flex; align-items: center; gap: .35rem; }
.seg button.on { background: var(--zfy-surface, #fff); color: var(--zfy-ink, #1a2230); font-weight: 600; box-shadow: 0 1px 2px var(--zfy-shadow, rgba(20,26,34,.15)); }
.seg em { font-style: normal; font-size: .68rem; padding: 0 .35rem; border-radius: 999px; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); }
</style>
