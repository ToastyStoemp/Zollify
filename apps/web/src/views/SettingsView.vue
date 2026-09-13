<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import { currentAccount } from '@boothly/platform';
import { contributions } from '../boot';

const account = currentAccount;
const panels = computed(() => (account.value ? contributions.settingsFor(account.value.role) : []));
const selected = shallowRef<string | null>(null);

watch(panels, (list) => {
  if (!selected.value && list.length) selected.value = list[0]?.id ?? null;
}, { immediate: true });

const activePanel = computed(() => panels.value.find((p) => p.id === selected.value) ?? null);
const activeComponent = shallowRef<unknown>(null);

watch(activePanel, async (panel) => {
  if (!panel) { activeComponent.value = null; return; }
  const loaded = await panel.component();
  activeComponent.value = (loaded as { default?: unknown }).default ?? loaded;
}, { immediate: true });
</script>

<template>
  <section class="settings">
    <h1>Settings</h1>

    <p v-if="!panels.length" class="empty">
      No settings yet — modules add their own panels here as they load.
    </p>

    <div v-else class="layout">
      <nav aria-label="Settings sections">
        <button
          v-for="panel in panels"
          :key="panel.id"
          type="button"
          :class="{ active: panel.id === selected }"
          @click="selected = panel.id"
        >
          {{ panel.label }}
        </button>
      </nav>
      <div class="panel">
        <component :is="activeComponent" v-if="activeComponent" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: 1rem; }
h1 { margin: 0; font-size: 1.35rem; }
.empty { color: var(--bly-muted, #5a6472); margin: 0; }
.layout { display: grid; grid-template-columns: 13rem 1fr; gap: 1.5rem; align-items: start; }
nav { display: flex; flex-direction: column; gap: .2rem; }
nav button { text-align: left; border-color: transparent; background: transparent; }
nav button.active { background: var(--bly-accent-soft, #deeee9); color: var(--bly-accent-ink, #0a5a4a); font-weight: 600; }
@media (max-width: 720px) { .layout { grid-template-columns: 1fr; } }
</style>
