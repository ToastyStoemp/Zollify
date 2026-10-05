<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { consignors, errorText, loadConsignors, loaded, stores } from '../api';
import ArtistsTab from './ArtistsTab.vue';
import ItemsTab from './ItemsTab.vue';
import StatementTab from './StatementTab.vue';
import MyStoresTab from './MyStoresTab.vue';

/**
 * Consignment. The first three tabs are the store owner's: who the artists
 * are and which stores carry them, which items are theirs, and what each is
 * owed. "Where I consign" is the artist's side - the stores this account's
 * own work sells in. An account can be both.
 */
type Tab = 'artists' | 'items' | 'statement' | 'mine';
const tab = ref<Tab>('artists');
const error = ref<string | null>(null);
/** Handed from Artists to Items when "Items" is clicked on one artist. */
const focus = ref<string>('');

onMounted(async () => {
  try {
    await loadConsignors();
    // An artist's account with no stores of its own opens on its own side.
    if (!consignors.value.length && !stores.value.length) tab.value = 'mine';
  } catch (err) {
    error.value = errorText(err, 'Could not load consignment.');
  }
});

const active = computed(() => consignors.value.filter((c) => !c.archived).length);
const tabs = computed<{ id: Tab; label: string; badge?: number }[]>(() => [
  { id: 'artists', label: 'Artists', badge: active.value },
  { id: 'items', label: 'Items' },
  { id: 'statement', label: 'Statement' },
  { id: 'mine', label: 'Where I consign' },
]);
function pick(id: Tab): void {
  tab.value = id;
  error.value = null;
}
function showItems(consignorId: string): void {
  focus.value = consignorId;
  pick('items');
}
</script>

<template>
  <section class="consignment">
    <header>
      <h1>Consignment</h1>
      <nav class="seg" aria-label="Consignment sections">
        <button v-for="t in tabs" :key="t.id" type="button" :class="{ on: tab === t.id }" @click="pick(t.id)">{{ t.label }}<em v-if="t.badge">{{ t.badge }}</em></button>
      </nav>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!loaded && !error" class="hint">Loading…</p>
    <template v-else-if="loaded">
      <ArtistsTab v-if="tab === 'artists'" @error="error = $event" @items="showItems" />
      <ItemsTab v-else-if="tab === 'items'" v-model:consignor="focus" @error="error = $event" />
      <StatementTab v-else-if="tab === 'statement'" @error="error = $event" />
      <MyStoresTab v-else @error="error = $event" />
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
