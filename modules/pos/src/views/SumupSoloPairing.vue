<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { loadSumupReaders, pairSumupReader, thisTillsReader, useReader, type SumupReader } from '../payments/sumup-cloud';

/**
 * Which Solo this till sends card payments to: the account's paired ones to
 * pick from, and pairing a new one from the code it shows. Used by Settings →
 * Payments and by first-run setup.
 */
const emit = defineEmits<{ picked: [reader: Pick<SumupReader, 'id' | 'name'>] }>();

const readers = ref<SumupReader[]>([]);
const chosen = ref('');
const code = ref('');
const name = ref('Counter');
const busy = ref(false);
const error = ref<string | null>(null);
const ok = ref<string | null>(null);

const errorText = (err: unknown, fallback: string): string => (err as { body?: { message?: string } } | null)?.body?.message ?? (err instanceof Error ? err.message : fallback);

async function refresh(): Promise<void> {
  try {
    readers.value = await loadSumupReaders();
  } catch (err) {
    error.value = errorText(err, 'Could not load your readers.');
  }
}
onMounted(async () => {
  chosen.value = (await thisTillsReader())?.id ?? '';
  await refresh();
});

async function pick(): Promise<void> {
  const r = readers.value.find((x) => x.id === chosen.value);
  if (!r) return;
  await useReader(r);
  ok.value = `Card payments on this till go to ${r.name}.`;
  emit('picked', r);
}

async function pair(): Promise<void> {
  busy.value = true;
  error.value = ok.value = null;
  try {
    const r = await pairSumupReader(code.value.trim(), name.value.trim() || 'Solo');
    await useReader(r);
    chosen.value = r.id;
    code.value = '';
    ok.value = `${r.name} is paired and used by this till.`;
    emit('picked', r);
    await refresh();
  } catch (err) {
    error.value = errorText(err, 'Could not pair the Solo.');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="solo">
    <label v-if="readers.length" class="field">
      <span>This till’s Solo</span>
      <select v-model="chosen" @change="pick">
        <option value="" disabled>Choose a reader…</option>
        <option v-for="r in readers" :key="r.id" :value="r.id">{{ r.name }}{{ r.status !== 'paired' ? ` (${r.status})` : '' }}</option>
      </select>
    </label>

    <details :open="!readers.length">
      <summary>Pair a new Solo</summary>
      <ol class="how">
        <li>If the Solo is signed in to SumUp, sign it out: <strong>Settings → About → Log out</strong>.</li>
        <li>Open <strong>Connections → API → Connect</strong>. The Solo shows a code, good for 5 minutes.</li>
        <li>Type the code here.</li>
      </ol>
      <form class="row" @submit.prevent="pair">
        <input v-model="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Code on the Solo" aria-label="Pairing code" />
        <input v-model="name" type="text" placeholder="Name" aria-label="Reader name" />
        <button type="submit" :disabled="busy || code.trim().length < 4">{{ busy ? 'Pairing…' : 'Pair' }}</button>
      </form>
    </details>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="ok" class="ok">{{ ok }}</p>
  </div>
</template>

<style scoped>
.solo { display: flex; flex-direction: column; gap: .6rem; }
.field { display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; }
.how { margin: .4rem 0; padding-left: 1.2rem; font-size: .85rem; color: var(--zfy-muted, #5a6472); display: flex; flex-direction: column; gap: .2rem; }
.row { display: flex; gap: .5rem; flex-wrap: wrap; }
.row input { flex: 1; min-width: 8rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); font-size: .875rem; }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
summary { cursor: pointer; font-size: .875rem; }
</style>
