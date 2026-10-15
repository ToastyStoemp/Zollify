<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { authFetch } from '@zollify/platform';

/**
 * Server settings, for the server owner: everything the server reads from
 * its environment. Most can be set here and apply at once; a value set in the
 * server's own environment wins and is shown locked; deployment wiring and
 * start-up tuning are listed for reference only. Secrets are write-only.
 */
interface Setting {
  key: string;
  group: string;
  label: string;
  hint: string;
  kind: 'text' | 'secret' | 'multiline' | 'bool' | 'number' | 'select';
  secret: boolean;
  editable: boolean;
  restart: boolean;
  options?: string[];
  fallback?: string;
  source: 'environment' | 'panel' | 'default';
  value: string | null;
}

const settings = ref<Setting[]>([]);
const draft = reactive<Record<string, string>>({});
const problems = ref<Record<string, string>>({});
const error = ref<string | null>(null);
const ok = ref<string | null>(null);
const busy = ref(false);

function take(list: Setting[]): void {
  settings.value = list;
  for (const s of list) draft[s.key] = s.kind === 'bool' ? (s.value === '1' ? '1' : '') : s.secret ? '' : (s.value ?? '');
}
onMounted(async () => {
  try {
    take(((await authFetch('/admin/settings')) as { settings: Setting[] }).settings);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the settings.';
  }
});

/** Editable settings by group, in the server's order; the rest for reference. */
const groups = computed(() => {
  const out = new Map<string, Setting[]>();
  for (const s of settings.value.filter((x) => x.editable || x.source === 'environment' && !['Deployment', 'Security tuning'].includes(x.group))) {
    out.set(s.group, [...(out.get(s.group) ?? []), s]);
  }
  return [...out.entries()];
});
const reference = computed(() => settings.value.filter((s) => !s.editable && ['Deployment', 'Security tuning'].includes(s.group)));

const changed = computed(() =>
  settings.value.filter((s) => s.editable && (s.secret ? draft[s.key] !== '' : draft[s.key] !== (s.kind === 'bool' ? (s.value === '1' ? '1' : '') : (s.value ?? '')))),
);
const needsRestart = computed(() => changed.value.some((s) => s.restart));

async function save(): Promise<void> {
  busy.value = true;
  error.value = ok.value = null;
  problems.value = {};
  try {
    const set = Object.fromEntries(changed.value.map((s) => [s.key, draft[s.key] ?? '']));
    const res = (await authFetch('/admin/settings', { method: 'PUT', body: JSON.stringify({ set }) })) as { settings: Setting[] };
    const restart = needsRestart.value;
    take(res.settings);
    ok.value = restart ? 'Saved. Email settings apply after the server restarts.' : 'Saved - in effect now.';
  } catch (err) {
    const body = (err as { body?: { problems?: Record<string, string>; message?: string } }).body;
    problems.value = body?.problems ?? {};
    error.value = body?.message ?? (err instanceof Error ? err.message : 'Could not save.');
  } finally {
    busy.value = false;
  }
}

async function clear(key: string): Promise<void> {
  try {
    take(((await authFetch('/admin/settings', { method: 'PUT', body: JSON.stringify({ clear: [key] }) })) as { settings: Setting[] }).settings);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not clear it.';
  }
}

const shown = (s: Setting): string => (s.source === 'default' ? (s.fallback ? `default: ${s.fallback}` : 'not set') : s.secret ? 'set' : (s.value ?? ''));
</script>

<template>
  <article class="card settings">
    <h3>Server settings</h3>
    <p class="hint">What used to need the .env file. Saved here, a setting applies at once and survives restarts. One set in the server's own environment wins, and shows as locked.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="ok" class="ok">{{ ok }}</p>

    <section v-for="[group, items] in groups" :key="group" class="group">
      <h4>{{ group }}</h4>
      <div v-for="s in items" :key="s.key" class="field">
        <div class="head">
          <label :for="`ss-${s.key}`">{{ s.label }}</label>
          <code>{{ s.key }}</code>
          <span v-if="s.source === 'environment'" class="tag locked">set in environment</span>
          <span v-else-if="s.source === 'panel' && s.secret" class="tag">saved</span>
          <span v-if="s.restart" class="tag">restart</span>
          <button v-if="s.source === 'panel'" type="button" class="linkbtn" @click="clear(s.key)">Clear</button>
        </div>
        <p class="hint">{{ s.hint }}</p>
        <template v-if="s.editable">
          <label v-if="s.kind === 'bool'" class="check"><input :id="`ss-${s.key}`" v-model="draft[s.key]" type="checkbox" true-value="1" false-value="" /> <span>On</span></label>
          <select v-else-if="s.kind === 'select'" :id="`ss-${s.key}`" v-model="draft[s.key]">
            <option value="">{{ s.fallback ? `Default (${s.fallback})` : 'Not set' }}</option>
            <option v-for="o in s.options" :key="o" :value="o">{{ o }}</option>
          </select>
          <textarea v-else-if="s.kind === 'multiline'" :id="`ss-${s.key}`" v-model="draft[s.key]" rows="3" spellcheck="false" :placeholder="s.secret && s.source === 'panel' ? 'Saved - paste a new one to replace it' : ''" />
          <input
            v-else
            :id="`ss-${s.key}`"
            v-model="draft[s.key]"
            :type="s.kind === 'secret' ? 'password' : s.kind === 'number' ? 'number' : 'text'"
            autocomplete="off"
            spellcheck="false"
            :placeholder="s.secret && s.source === 'panel' ? 'Saved - type a new one to replace it' : (s.fallback ?? '')"
          />
          <p v-if="problems[s.key]" class="error">{{ problems[s.key] }}</p>
        </template>
        <p v-else class="value">{{ shown(s) }}</p>
      </div>
    </section>

    <div class="actions">
      <button type="button" class="primary" :disabled="busy || !changed.length" @click="save">{{ busy ? 'Saving…' : changed.length ? `Save ${changed.length} change${changed.length === 1 ? '' : 's'}` : 'Save' }}</button>
    </div>

    <details class="reference">
      <summary>Deployment and start-up tuning <span class="hint">- environment only</span></summary>
      <p class="hint">Read once when the server starts, or part of how it is deployed: change these in the server's environment (.env) and restart.</p>
      <dl>
        <template v-for="s in reference" :key="s.key">
          <dt><code>{{ s.key }}</code> <span>{{ s.label }}</span></dt>
          <dd>{{ shown(s) }}<span v-if="s.hint" class="hint"> - {{ s.hint }}</span></dd>
        </template>
      </dl>
    </details>
  </article>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: .8rem; }
.group { display: flex; flex-direction: column; gap: .7rem; padding-top: .6rem; border-top: 1px solid var(--zfy-line); }
.group h4 { margin: 0; font-size: .9rem; }
.field { display: flex; flex-direction: column; gap: .25rem; }
.head { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
.head label { font-weight: 600; font-size: .875rem; }
code { font-size: .72rem; color: var(--zfy-muted); }
.tag { font-size: .66rem; text-transform: uppercase; letter-spacing: .06em; padding: .05rem .4rem; border-radius: 999px; background: var(--zfy-surface-2); color: var(--zfy-muted); }
.tag.locked { background: var(--zfy-signal-soft); color: var(--zfy-ink); }
.linkbtn { margin-left: auto; background: none; border: 0; padding: 0; min-height: 0; font: inherit; font-size: .8rem; color: var(--zfy-muted); text-decoration: underline; cursor: pointer; }
.hint { margin: 0; color: var(--zfy-muted); font-size: .8rem; }
.value { margin: 0; font-size: .875rem; }
.error { margin: 0; color: var(--zfy-danger); font-size: .82rem; }
.ok { margin: 0; color: var(--zfy-accent-ink); font-size: .875rem; }
.check { display: flex; align-items: center; gap: .4rem; font-size: .875rem; }
textarea { font-family: ui-monospace, monospace; font-size: .8rem; resize: vertical; }
.actions { display: flex; justify-content: flex-end; }
.reference summary { cursor: pointer; font-weight: 600; font-size: .9rem; }
.reference dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: .35rem 1rem; margin: .6rem 0 0; font-size: .82rem; }
.reference dt span { color: var(--zfy-muted); margin-left: .3rem; }
.reference dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 560px) { .reference dl { grid-template-columns: 1fr; } .reference dd { margin-bottom: .4rem; } }
</style>
