<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { authFetch } from '@zollify/platform';
import { loadEnabledModules, loadOutcomes, loader, unloadModule } from '../boot';

interface AvailableModule {
  moduleId: string;
  version: string;
  title: string;
  description?: string;
  requires?: string[];
  enabled: boolean;
}

const router = useRouter();
const modules = ref<AvailableModule[]>([]);
const busy = ref<string | null>(null);
const error = ref<string | null>(null);

async function refresh(): Promise<void> {
  try {
    const res = (await authFetch('/modules/available')) as { modules: AvailableModule[] };
    modules.value = res.modules;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the module list.';
  }
}

onMounted(refresh);

/**
 * Switched on is not the same as running: a module the loader skipped (role
 * too low, an unmet dependency, a bundle that failed to load) would otherwise
 * read as on while nothing of it is visible.
 */
function problem(mod: AvailableModule): string | null {
  if (!mod.enabled || loader.isLoaded(mod.moduleId)) return null;
  const outcome = loadOutcomes.value.find((o) => o.moduleId === mod.moduleId);
  return outcome?.reason ?? 'Not running on this device — reload the app.';
}

/**
 * Re-scans the server's module store. The catalogue is read at boot, so a
 * module published since then is invisible until this runs.
 */
async function reloadStore(): Promise<void> {
  busy.value = 'reload';
  error.value = null;
  try {
    await authFetch('/modules/reload', { method: 'POST' });
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not reload the module store.';
  } finally {
    busy.value = null;
  }
}

/**
 * Toggling is applied server-side first, then reflected in the running shell.
 * Doing it in that order means a failed request leaves the UI honest rather
 * than showing a module as enabled that the gateway will refuse to serve.
 */
async function toggle(mod: AvailableModule): Promise<void> {
  busy.value = mod.moduleId;
  error.value = null;
  try {
    await authFetch('/modules/toggle', {
      method: 'POST',
      body: JSON.stringify({ moduleId: mod.moduleId, enabled: !mod.enabled }),
    });

    if (mod.enabled) {
      await unloadModule(router, mod.moduleId);
    } else {
      await loadEnabledModules(router);
    }
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not change that module.';
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <section class="modules">
    <header>
      <h2>Modules</h2>
      <button type="button" :disabled="busy !== null" @click="reloadStore">
        {{ busy === 'reload' ? 'Rescanning…' : 'Rescan store' }}
      </button>
    </header>
    <p class="lede">
      Switch features on and off for this account. Changes apply straight away. Rescan after
      publishing a new module bundle.
    </p>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <ul class="list">
      <li v-for="mod in modules" :key="mod.moduleId">
        <div class="meta">
          <strong>{{ mod.title }}</strong>
          <span class="ver">{{ mod.moduleId }} · {{ mod.version }}</span>
          <p v-if="mod.description" class="desc">{{ mod.description }}</p>
          <p v-if="mod.requires?.length" class="requires">Needs: {{ mod.requires.join(', ') }}</p>
          <p v-if="problem(mod)" class="problem">Switched on but not running: {{ problem(mod) }}</p>
        </div>
        <button type="button" :class="mod.enabled ? 'quiet' : 'primary'" :disabled="busy === mod.moduleId" @click="toggle(mod)">
          {{ busy === mod.moduleId ? 'Working…' : mod.enabled ? 'Switch off' : 'Switch on' }}
        </button>
      </li>
    </ul>

    <p v-if="!modules.length && !error" class="empty">No modules are published on this server yet.</p>
  </section>
</template>

<style scoped>
.modules { display: flex; flex-direction: column; gap: 1rem; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
h2 { margin: 0; font-size: 1.05rem; }
.lede, .empty { color: var(--zfy-muted, #5a6472); margin: 0; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.list li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .85rem 1rem; background: var(--zfy-surface, #fff); }
.meta { display: flex; flex-direction: column; gap: .1rem; }
.ver { font-size: .78rem; color: var(--zfy-muted, #5a6472); font-variant-numeric: tabular-nums; }
.desc, .requires { margin: .25rem 0 0; font-size: .85rem; color: var(--zfy-muted, #5a6472); }
.problem { margin: .25rem 0 0; font-size: .85rem; color: var(--zfy-danger, #c6512f); }
</style>
