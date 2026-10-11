<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { homeName, loadStorage, loaded, locations, ownLocation, setOwnLocation } from '../state';
import OverviewTab from './OverviewTab.vue';
import PickListTab from './PickListTab.vue';
import LocationsTab from './LocationsTab.vue';

type Tab = 'overview' | 'pick' | 'locations';
const tab = ref<Tab>('overview');
const error = ref<string | null>(null);

async function pickOwn(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value;
  error.value = null;
  try {
    await setOwnLocation(value || null);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not change where this device sells from.';
  }
}

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
    <p class="lede">Where your stock is: a storage unit, the studio, a friend's garage. Totals stay as counted under Inventory; this splits them by place.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <label v-if="loaded && locations.length" class="own">
      <span>This device sells from</span>
      <select :value="ownLocation ?? ''" @change="pickOwn">
        <option value="">{{ homeName }}</option>
        <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
      </select>
      <small>Sales here at an event with no claim on an item come out of this place. Changing it only affects sales from now on.</small>
    </label>

    <template v-if="loaded">
      <OverviewTab v-if="tab === 'overview'" @manage="tab = 'locations'" />
      <PickListTab v-else-if="tab === 'pick'" />
      <LocationsTab v-else />
    </template>
  </section>
</template>

<style scoped>
.own { display: flex; flex-direction: column; gap: .3rem; font-size: .875rem; max-width: 28rem; }
.own small { color: var(--zfy-muted, #5a6472); font-size: .78rem; }
</style>
