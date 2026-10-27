<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Icon } from '@zollify/ui';
import { printerKeys, type PrinterKey } from '../api';
import { sdk } from '../runtime';

/**
 * Printer keys - how the printing app on a computer logs the paper it uses,
 * so what is on hand here follows every print. A key can only list the
 * materials and log a use; its secret is shown once, when it is made.
 */
const emit = defineEmits<{ error: [message: string] }>();
const keys = ref<PrinterKey[]>([]);
const label = ref('');
const fresh = ref<{ label: string; secret: string } | null>(null);
const busy = ref(false);
const endpoint = sdk().display.publicUrl('/p/sourcing/usage');
const listUrl = sdk().display.publicUrl('/p/sourcing/materials');

async function load(): Promise<void> {
  try {
    keys.value = await printerKeys.list();
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not load the printer keys.');
  }
}
onMounted(load);

async function create(): Promise<void> {
  if (!label.value.trim()) return emit('error', 'Name the printer or computer the key is for.');
  busy.value = true;
  try {
    const res = await printerKeys.create(label.value.trim());
    fresh.value = { label: res.key.label, secret: res.secret };
    label.value = '';
    await load();
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not make the key.');
  } finally {
    busy.value = false;
  }
}
async function revoke(k: PrinterKey): Promise<void> {
  if (!(await sdk().ui.confirm(`The printing app using "${k.label}" stops logging paper until it gets a new key.`, 'Revoke this key?', { confirm: 'Revoke' }))) return;
  await printerKeys.revoke(k.id);
  await load();
}
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    sdk().ui.toast('Copied.', { kind: 'success' });
  } catch {
    sdk().ui.toast('Could not copy - select it and copy by hand.', { kind: 'error' });
  }
}
const when = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never');
</script>

<template>
  <details class="card keys">
    <summary><Icon name="printer" :size="14" /> Printing app <small>{{ keys.length }} key{{ keys.length === 1 ? '' : 's' }}</small></summary>
    <p class="hint">Give the printing app on your computer a key, and every print it makes is taken off what you have on hand here - 10 sheets of A3 printed, 10 fewer in stock. A key can only see your materials and log what was used.</p>

    <div v-if="fresh" class="fresh">
      <strong>Key for {{ fresh.label }} - copy it now, it is not shown again</strong>
      <div class="secret"><code>{{ fresh.secret }}</code><button type="button" @click="copy(fresh.secret)">Copy</button></div>
      <button type="button" class="quiet" @click="fresh = null">Done</button>
    </div>

    <ul v-if="keys.length" class="list">
      <li v-for="k in keys" :key="k.id">
        <span class="main"><strong>{{ k.label }}</strong><small>made {{ when(k.createdAt) }} · last used {{ when(k.lastUsedAt) }}</small></span>
        <button type="button" class="quiet danger" @click="revoke(k)">Revoke</button>
      </li>
    </ul>
    <div class="row">
      <input v-model="label" type="text" maxlength="60" placeholder="Studio PC" aria-label="Key name" @keydown.enter.prevent="create" />
      <button type="button" class="primary" :disabled="busy" @click="create">New key</button>
    </div>

    <div class="howto">
      <strong>For the printing app</strong>
      <p class="hint">Send each print as it happens. The material is its name as written here (or its id); sending the same job id again counts once.</p>
      <pre>POST {{ endpoint }}
Authorization: Bearer zpk_…
Content-Type: application/json

{ "material": "Hahnemühle A3", "qty": 10, "id": "job-1234", "note": "Harbour print run" }</pre>
      <p class="hint">Or say what was printed, and every material of its dossier's recipe - paper and ink - is taken off at once:</p>
      <pre>{ "print": "Harbour at dusk A3", "copies": 10, "id": "job-1235" }</pre>
      <p class="hint">A misprint is still used up, but counted as waste - add <code>"waste": true</code> to either call. Materials with what is on hand: <code>GET {{ listUrl }}</code> with the same header.</p>
    </div>
  </details>
</template>

<style scoped>
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .6rem .9rem; display: flex; flex-direction: column; gap: .5rem; }
summary { cursor: pointer; font-weight: 600; display: flex; align-items: center; gap: .4rem; }
summary small { color: var(--zfy-muted, #5a6472); font-weight: 400; }
.keys[open] { gap: .6rem; }
.hint { margin: .3rem 0 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; max-width: 70ch; }
.fresh { display: flex; flex-direction: column; gap: .35rem; padding: .6rem; border: 1px solid var(--zfy-accent, #0e7c66); border-radius: 10px; background: var(--zfy-accent-soft, #e6f3f0); font-size: .85rem; }
.secret { display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; }
.secret code { font-size: .8rem; word-break: break-all; background: var(--zfy-surface, #fff); padding: .25rem .4rem; border-radius: 6px; }
.list { list-style: none; margin: .4rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.list li { display: flex; align-items: center; gap: .5rem; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: .85rem; }
.main small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
.row { display: flex; gap: .4rem; margin-top: .4rem; }
.row input { flex: 1; min-width: 0; }
.howto { margin-top: .5rem; font-size: .85rem; }
pre { margin: .35rem 0 0; padding: .55rem .7rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); font-size: .74rem; overflow-x: auto; white-space: pre; }
code { font-size: .78rem; }
</style>
