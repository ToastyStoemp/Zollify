<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type ConfigGroup } from '../api';
import { refreshStatus } from '../state';

/**
 * Integration credentials, one group per provider. Secrets show "saved" once
 * stored and are never sent back; leave one blank to keep it, or clear it.
 * A group switched off is ignored entirely, credentials or not.
 */

const groups = ref<ConfigGroup[]>([]);
const values = ref<Record<string, string | boolean>>({});
const enabled = ref<Record<string, boolean>>({});
const edits = ref<Record<string, string>>({});
const clears = ref<Set<string>>(new Set());
const openGroups = ref<Set<string>>(new Set());
const tests = ref<Record<string, { ok: boolean; detail: string } | 'busy'>>({});
const busy = ref(false);
const saved = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const res = await api.config();
    groups.value = res.groups;
    values.value = res.values;
    enabled.value = res.enabled;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the integration settings.';
  }
});

const isSet = (key: string): boolean => values.value[`${key}__set`] === true;
const plain = (key: string): string => (typeof values.value[key] === 'string' ? (values.value[key] as string) : '');

function toggleOpen(id: string): void {
  const s = new Set(openGroups.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  openGroups.value = s;
}

function clearSecret(key: string): void {
  const s = new Set(clears.value);
  s.add(key);
  clears.value = s;
  delete edits.value[key];
}

async function save(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const res = await api.saveConfig({ set: { ...edits.value }, clear: [...clears.value], enabled: { ...enabled.value } });
    values.value = res.values;
    enabled.value = res.enabled;
    edits.value = {};
    clears.value = new Set();
    saved.value = true;
    setTimeout(() => (saved.value = false), 2500);
    await refreshStatus().catch(() => {});
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save.';
  } finally {
    busy.value = false;
  }
}

async function test(id: string): Promise<void> {
  tests.value = { ...tests.value, [id]: 'busy' };
  try {
    tests.value = { ...tests.value, [id]: await api.testConfig(id) };
  } catch (err) {
    tests.value = { ...tests.value, [id]: { ok: false, detail: err instanceof Error ? err.message : String(err) } };
  }
}

const dirty = (): boolean => Object.keys(edits.value).length > 0 || clears.value.size > 0;
const testResult = (id: string): { ok: boolean; detail: string } | null => {
  const t = tests.value[id];
  return t && t !== 'busy' ? t : null;
};
</script>

<template>
  <section class="integrations">
    <header class="head">
      <div>
        <h2>Integrations</h2>
        <p class="hint">
          Credentials for the services the books talk to. Secrets are stored encrypted and never shown
          again; switch a service off to ignore it entirely.
        </p>
      </div>
      <div class="actions">
        <span v-if="saved" class="ok" role="status">Saved.</span>
        <button type="button" class="primary" :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'Save changes' }}</button>
      </div>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <section v-for="g in groups" :key="g.id" :class="['group', { off: enabled[g.id] === false }]">
      <header class="ghead">
        <label class="switch">
          <input v-model="enabled[g.id]" type="checkbox" />
          <strong>{{ g.label }}</strong>
        </label>
        <div class="gactions">
          <span v-if="tests[g.id] === 'busy'" class="hint">Testing…</span>
          <span v-else-if="testResult(g.id)" :class="['pill', testResult(g.id)!.ok ? 'good' : 'bad']">{{ testResult(g.id)!.detail }}</span>
          <button type="button" class="quiet" :disabled="dirty()" :title="dirty() ? 'Save first' : ''" @click="test(g.id)">Test connection</button>
          <button type="button" class="quiet" :aria-expanded="openGroups.has(g.id)" @click="toggleOpen(g.id)">{{ openGroups.has(g.id) ? 'Hide' : 'Edit' }}</button>
        </div>
      </header>
      <p class="hint">{{ g.hint }}</p>

      <div v-if="openGroups.has(g.id)" class="fields">
        <label v-for="f in g.fields" :key="f.key">
          <span>{{ f.label }}<em v-if="f.secret && isSet(f.key) && !clears.has(f.key)"> · saved</em></span>
          <select v-if="f.select" :value="edits[f.key] ?? plain(f.key)" @change="edits[f.key] = ($event.target as HTMLSelectElement).value">
            <option v-for="o in f.select" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <span v-else-if="f.secret" class="secret">
            <input v-model="edits[f.key]" type="password" autocomplete="off" :placeholder="isSet(f.key) && !clears.has(f.key) ? '••••••••  (leave blank to keep)' : f.placeholder ?? ''" />
            <button v-if="isSet(f.key) && !clears.has(f.key)" type="button" class="quiet" @click="clearSecret(f.key)">Clear</button>
          </span>
          <input v-else :value="edits[f.key] ?? plain(f.key)" type="text" :placeholder="f.placeholder ?? ''" @input="edits[f.key] = ($event.target as HTMLInputElement).value" />
          <small v-if="f.hint">{{ f.hint }}</small>
        </label>
      </div>
    </section>
  </section>
</template>

<style scoped>
.integrations { display: flex; flex-direction: column; gap: 1rem; max-width: 46rem; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
h2 { margin: 0; font-size: 1.05rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .85rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.ok { color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
.actions, .gactions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.group { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: .9rem 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .5rem; }
.group.off { opacity: .6; }
.ghead { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
.switch { display: flex; align-items: center; gap: .5rem; }
.pill { font-size: .78rem; padding: .2rem .6rem; border-radius: 999px; border: 1px solid var(--zfy-line, #d6dde4); max-width: 24rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill.good { color: var(--zfy-accent-ink, #0a5a4a); background: var(--zfy-accent-soft, #deeee9); border-color: transparent; }
.pill.bad { color: var(--zfy-danger, #c6512f); }
.fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: .75rem; padding-top: .3rem; }
.fields label { display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; }
.fields label em { font-style: normal; color: var(--zfy-accent-ink, #0a5a4a); font-size: .78rem; }
.fields small { color: var(--zfy-muted, #5a6472); font-size: .75rem; }
.secret { display: flex; gap: .4rem; }
.secret input { flex: 1; min-width: 0; }
</style>
