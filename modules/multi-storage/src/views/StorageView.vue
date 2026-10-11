<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { loadStorage, loaded, locations } from '../state';
import OverviewTab from './OverviewTab.vue';
import PickListTab from './PickListTab.vue';
import LocationsTab from './LocationsTab.vue';

type Tab = 'overview' | 'pick' | 'locations';
const tab = ref<Tab>('overview');
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    await loadStorage();
    if (!locations.value.length) tab.value = 'locations';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not load the storage locations.';
  }
});
</script>

<template>
  <section class="page storage">
    <header>
      <h1>Storage</h1>
      <div class="tools">
        <div class="seg" role="tablist" aria-label="View">
          <button type="button" role="tab" :class="{ on: tab === 'overview' }" :aria-selected="tab === 'overview'" @click="tab = 'overview'">Stock by place</button>
          <button type="button" role="tab" :class="{ on: tab === 'pick' }" :aria-selected="tab === 'pick'" @click="tab = 'pick'">Pick list</button>
          <button type="button" role="tab" :class="{ on: tab === 'locations' }" :aria-selected="tab === 'locations'" @click="tab = 'locations'">Locations</button>
        </div>
      </div>
    </header>
    <p class="lede">Where your stock is when it is not with you: a storage unit, the studio, a friend's garage. Totals stay as counted under Inventory; this splits them by place.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <template v-if="loaded">
      <OverviewTab v-if="tab === 'overview'" @manage="tab = 'locations'" />
      <PickListTab v-else-if="tab === 'pick'" />
      <LocationsTab v-else />
    </template>
  </section>
</template>
