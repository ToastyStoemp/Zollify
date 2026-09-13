<script setup lang="ts">
import { computed, shallowRef, watch, type Component } from 'vue';
import { currentAccount } from '@boothly/platform';
import { roleAtLeast, type Role } from '@boothly/sdk';
import { contributions } from '../boot';

interface Panel {
  id: string;
  label: string;
  group: 'Core' | 'Modules';
  minRole?: Role;
  component: () => Promise<Component | { default: Component }>;
}

const account = currentAccount;

/**
 * Core's own panels, listed before module contributions.
 *
 * Core is not a module, so it has nothing to register through the SDK — but its
 * settings belong in the same index, not a separate screen.
 */
const corePanels: Panel[] = [
  {
    id: 'core.data',
    label: 'Backup & restore',
    group: 'Core',
    component: () => import('./DataSettings.vue'),
  },
  {
    id: 'core.team',
    label: 'Team',
    group: 'Core',
    minRole: 'admin',
    component: () => import('./TeamSettings.vue'),
  },
  {
    id: 'core.device',
    label: 'This device',
    group: 'Core',
    component: () => import('./DeviceSettings.vue'),
  },
];

const panels = computed<Panel[]>(() => {
  const role = account.value?.role;
  if (!role) return [];

  const core = corePanels.filter((p) => !p.minRole || roleAtLeast(role, p.minRole));
  const fromModules: Panel[] = contributions.settingsFor(role).map((p) => ({
    id: p.id,
    label: p.label,
    group: 'Modules',
    component: p.component,
  }));

  return [...core, ...fromModules];
});

const selected = shallowRef<string | null>(null);

watch(
  panels,
  (list) => {
    // Keep the current selection when a module loads or unloads; only fall back
    // when what was selected has actually gone.
    if (selected.value && list.some((p) => p.id === selected.value)) return;
    selected.value = list[0]?.id ?? null;
  },
  { immediate: true },
);

const activePanel = computed(() => panels.value.find((p) => p.id === selected.value) ?? null);
const activeComponent = shallowRef<Component | null>(null);

watch(
  activePanel,
  async (panel) => {
    if (!panel) {
      activeComponent.value = null;
      return;
    }
    const loaded = await panel.component();
    activeComponent.value = ((loaded as { default?: Component }).default ?? loaded) as Component;
  },
  { immediate: true },
);

const groups = computed(() => [
  { name: 'Core', items: panels.value.filter((p) => p.group === 'Core') },
  { name: 'Modules', items: panels.value.filter((p) => p.group === 'Modules') },
]);
</script>

<template>
  <section class="settings">
    <h1>Settings</h1>

    <div class="layout">
      <nav aria-label="Settings sections">
        <template v-for="group in groups" :key="group.name">
          <p v-if="group.items.length" class="group">{{ group.name }}</p>
          <button
            v-for="panel in group.items"
            :key="panel.id"
            type="button"
            :class="{ active: panel.id === selected }"
            @click="selected = panel.id"
          >
            {{ panel.label }}
          </button>
        </template>
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
.layout { display: grid; grid-template-columns: 13rem 1fr; gap: 1.5rem; align-items: start; }
nav { display: flex; flex-direction: column; gap: .2rem; }
.group { margin: .6rem 0 .1rem; font-size: .7rem; letter-spacing: .1em; text-transform: uppercase; color: var(--bly-faint, #8a94a2); }
.group:first-child { margin-top: 0; }
nav button { text-align: left; border-color: transparent; background: transparent; }
nav button.active { background: var(--bly-accent-soft, #deeee9); color: var(--bly-accent-ink, #0a5a4a); font-weight: 600; }
@media (max-width: 720px) { .layout { grid-template-columns: 1fr; } }
</style>
