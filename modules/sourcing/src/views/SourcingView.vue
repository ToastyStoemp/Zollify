<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { loaded, refresh, snap } from '../api';
import DossiersTab from './DossiersTab.vue';
import ReordersTab from './ReordersTab.vue';
import RestockTab from './RestockTab.vue';
import IssuesTab from './IssuesTab.vue';
import MaterialsTab from './MaterialsTab.vue';

/**
 * Sourcing - the reorder cockpit, ported from ZollSource. Dossiers hold what
 * a supplier needs to make each product; Restock says what to order;
 * Reorders carry an order from quote to received; Issues and Materials feed
 * the specs and the home-print costs.
 */
type Tab = 'dossiers' | 'reorders' | 'restock' | 'issues' | 'materials';
const tab = ref<Tab>('dossiers');
const error = ref<string | null>(null);
onMounted(() => {
  refresh().catch((e) => (error.value = e instanceof Error ? e.message : 'Could not load sourcing data.'));
});
const open = computed(() => snap.value.reorders.filter((r) => r.status !== 'received').length);
const tabs = computed<{ id: Tab; label: string; badge?: number }[]>(() => [
  { id: 'dossiers', label: 'Dossiers', badge: snap.value.dossiers.length },
  { id: 'reorders', label: 'Reorders', badge: open.value },
  { id: 'restock', label: 'Restock' },
  { id: 'issues', label: 'Issues', badge: snap.value.issues.filter((i) => i.status === 'open').length },
  { id: 'materials', label: 'Materials' },
]);
function pick(id: Tab): void {
  tab.value = id;
  error.value = null;
}
</script>

<template>
  <section class="sourcing">
    <header>
      <h1>Sourcing</h1>
      <nav class="seg" aria-label="Sourcing sections">
        <button v-for="t in tabs" :key="t.id" type="button" :class="{ on: tab === t.id }" @click="pick(t.id)">{{ t.label }}<em v-if="t.badge">{{ t.badge }}</em></button>
      </nav>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!loaded" class="hint">Loading…</p>
    <template v-else>
      <DossiersTab v-if="tab === 'dossiers'" @error="error = $event" />
      <ReordersTab v-else-if="tab === 'reorders'" @error="error = $event" />
      <RestockTab v-else-if="tab === 'restock'" @error="error = $event" />
      <IssuesTab v-else-if="tab === 'issues'" @error="error = $event" />
      <MaterialsTab v-else @error="error = $event" />
    </template>
  </section>
</template>

<style scoped>
.sourcing { display: flex; flex-direction: column; gap: 1rem; max-width: 64rem; }
header { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
.seg { display: inline-flex; gap: .15rem; padding: .15rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); flex-wrap: wrap; }
.seg button { min-height: 2.2rem; padding: .1rem .8rem; font-size: .82rem; border: 0; border-radius: 6px; background: none; color: var(--zfy-muted, #5a6472); display: inline-flex; align-items: center; gap: .35rem; }
.seg button.on { background: var(--zfy-surface, #fff); color: var(--zfy-ink, #1a2230); font-weight: 600; box-shadow: 0 1px 2px var(--zfy-shadow, rgba(20,26,34,.15)); }
.seg em { font-style: normal; font-size: .68rem; padding: 0 .35rem; border-radius: 999px; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); }
</style>
