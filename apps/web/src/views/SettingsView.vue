<script setup lang="ts">
import { computed, ref, shallowRef, watch, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { currentAccount } from '@zollify/platform';
import { roleAtLeast, type Role } from '@zollify/sdk';
import { contributions } from '../boot';
import { Icon } from '@zollify/ui';

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
 * Core is not a module, so it has nothing to register through the SDK - but its
 * settings belong in the same index, not a separate screen.
 */
const corePanels: Panel[] = [
  {
    id: 'core.profile',
    label: 'Booth profile',
    group: 'Core',
    minRole: 'admin',
    component: () => import('./ProfileSettings.vue'),
  },
  {
    id: 'core.data',
    label: 'Backup & restore',
    group: 'Core',
    component: () => import('./DataSettings.vue'),
  },
  {
    id: 'core.security',
    label: 'Account & security',
    group: 'Core',
    component: () => import('./SecuritySettings.vue'),
  },
  {
    id: 'core.team',
    label: 'Team',
    group: 'Core',
    minRole: 'admin',
    component: () => import('./TeamSettings.vue'),
  },
  {
    id: 'core.modules',
    label: 'Modules',
    group: 'Core',
    minRole: 'admin',
    component: () => import('./ModulesView.vue'),
  },
  {
    id: 'core.admin',
    label: 'Server admin',
    group: 'Core',
    minRole: 'owner',
    component: () => import('./AdminSettings.vue'),
  },
  {
    id: 'core.device',
    label: 'This device',
    group: 'Core',
    component: () => import('./DeviceSettings.vue'),
  },
];

/** Phone: the list and a panel are two screens, not two columns. */
const phone = ref(typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches);
if (typeof matchMedia === 'function') matchMedia('(max-width: 720px)').addEventListener('change', (e) => { phone.value = e.matches; });

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

const route = useRoute();
const router = useRouter();

/**
 * The open panel lives in the URL (`#/settings?panel=core.team`) so a reload
 * lands on the same panel and the back button steps between them, and so a
 * module can link straight to its own settings.
 */
const selected = computed<string | null>(() => {
  const wanted = typeof route.query.panel === 'string' ? route.query.panel : null;
  if (wanted && panels.value.some((p) => p.id === wanted)) return wanted;
  return phone.value ? null : (panels.value[0]?.id ?? null);
});

function select(id: string): void {
  void router.push({ name: 'settings', query: { panel: id } });
}

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
  <section class="settings" :class="{ phone }">
    <h1 v-if="!phone || !activePanel">Settings</h1>
    <router-link v-else :to="{ name: 'settings' }" class="back"><Icon name="arrow-left" :size="14" /> Settings</router-link>

    <div class="layout">
      <nav v-if="!phone || !activePanel" aria-label="Settings sections">
        <template v-for="group in groups" :key="group.name">
          <p v-if="group.items.length" class="group">{{ group.name }}</p>
          <button
            v-for="panel in group.items"
            :key="panel.id"
            type="button"
            :class="{ active: panel.id === selected }"
            :aria-current="panel.id === selected ? 'page' : undefined"
            @click="select(panel.id)"
          >
            {{ panel.label }}
          </button>
        </template>
      </nav>

      <div v-if="!phone || activePanel" class="panel">
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
.group { margin: .6rem 0 .1rem; font-size: .7rem; letter-spacing: .1em; text-transform: uppercase; color: var(--zfy-faint, #8a94a2); }
.group:first-child { margin-top: 0; }
nav button { text-align: left; border-color: transparent; background: transparent; justify-content: flex-start; }
nav button.active { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); font-weight: 600; }
@media (max-width: 720px) {
  .layout { grid-template-columns: 1fr; }
  nav { gap: .35rem; }
  nav button { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 2.8rem; border: 1px solid var(--zfy-line, #d6dde4); background: var(--zfy-surface, #fff); }
  nav button::after { content: '\203A'; color: var(--zfy-muted, #5a6472); font-size: 1.1rem; }
  .group { margin: .6rem 0 .1rem; }
  .back { display: inline-flex; align-items: center; gap: .35rem; color: var(--zfy-muted, #5a6472); text-decoration: none; font-size: .9rem; }
}
</style>
