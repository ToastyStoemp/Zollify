<script setup lang="ts">
import { computed, onMounted, ref, watchEffect } from 'vue';
import { useRoute } from 'vue-router';
import { buildAllVersionsHtml } from '../engine/all-versions';
import { buildCustomsState } from '../engine/adapter';
import type { CustomsArtist, CustomsState } from '../engine/model';
import type { GoodsDocNum } from '../engine/goods-list';
import { DECLARANT_KEY } from './declarant';
import { sdk } from '../runtime';

const route = useRoute();
const eventId = computed(() => String(route.params.eventId ?? ''));

const docNum = ref<GoodsDocNum | null>(null);
const error = ref<string | null>(null);
const html = ref('');
const state = ref<CustomsState | null>(null);
const loading = ref(true);

const event = computed(() => sdk().data.events.get(eventId.value) ?? null);

/**
 * The document state is assembled from core data every time this screen
 * opens: the event, the catalogue, what the event claimed, and what it sold.
 * Nothing is cached, so the paperwork always reflects the till.
 */
async function build(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const ev = event.value;
    if (!ev) {
      state.value = null;
      return;
    }
    const api = sdk().data;
    const [stock, declarant] = await Promise.all([
      api.events.stock(ev.id),
      sdk().config.get<Partial<CustomsArtist>>(DECLARANT_KEY),
    ]);
    const built = buildCustomsState(ev, api.products.list(), stock, api.transactions.recent());
    // Layered, most specific last: an imported event's own record, then the
    // account's booth profile, then this module's declarant override.
    const layers = [sdk().account()?.profile.artist ?? {}, declarant ?? {}];
    for (const layer of layers) {
      for (const [key, value] of Object.entries(layer)) {
        if (value) built.artist[key as keyof CustomsArtist] = value;
      }
    }
    state.value = built;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    state.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(build);

/**
 * The engine is the ported ZollTool implementation and its output is verified
 * byte-for-byte against the legacy tool by the golden-file tests. This view
 * renders that output and adds nothing to it — any formatting done here would
 * be formatting the tests don't cover.
 */
watchEffect(() => {
  if (!state.value) {
    html.value = '';
    return;
  }
  try {
    html.value = buildAllVersionsHtml(state.value, docNum.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    html.value = '';
  }
});

const hasOutput = computed(() => html.value.length > 0);

const claimedUnits = computed(
  () => state.value?.products.reduce(
    (n, p) => n + (p.amount ?? 0) + (p.variants ?? []).reduce((m, v) => m + (v.amount ?? 0), 0),
    0,
  ) ?? 0,
);

const options: { value: GoodsDocNum | null; label: string }[] = [
  { value: null, label: 'All documents' },
  { value: 1, label: 'Goods list 1' },
  { value: 2, label: 'Goods list 2' },
  { value: 3, label: 'Goods list 3' },
];

function printDocuments(): void {
  const frame = document.getElementById('customs-output') as HTMLIFrameElement | null;
  frame?.contentWindow?.print();
}
</script>

<template>
  <section class="customs-documents">
    <header class="bar">
      <div class="lead">
        <router-link :to="{ name: 'customs:index' }" class="back">← Customs</router-link>
        <h1>{{ event?.name ?? 'Customs documents' }}</h1>
      </div>
      <div class="controls">
        <label class="field">
          <span>Show</span>
          <select v-model="docNum">
            <option v-for="opt in options" :key="String(opt.value)" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </label>
        <button type="button" class="primary" :disabled="!hasOutput" @click="printDocuments">Print</button>
      </div>
    </header>

    <p v-if="loading" class="empty">Preparing documents…</p>
    <p v-else-if="!event" class="empty">That event no longer exists.</p>
    <p v-else-if="error" class="error" role="alert">{{ error }}</p>
    <template v-else>
      <p v-if="claimedUnits === 0" class="warn" role="status">
        This event has no stock claimed, so the goods lists are empty. Claim what you're taking under
        Inventory → Claimed for an event.
      </p>

      <!--
        Rendered in a sandboxed iframe rather than with v-html. The engine emits a
        complete document meant for print, and the sandbox keeps it from reaching
        the shell's DOM, storage or session even though we generated it ourselves.
      -->
      <iframe
        v-if="hasOutput"
        id="customs-output"
        class="output"
        title="Generated customs documents"
        sandbox="allow-same-origin allow-modals"
        :srcdoc="html"
      ></iframe>
    </template>
  </section>
</template>

<style scoped>
.customs-documents { display: flex; flex-direction: column; gap: 1rem; height: 100%; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.lead { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.back { color: var(--zfy-muted, #5a6472); text-decoration: none; font-size: .875rem; }
.back:hover { color: var(--zfy-ink, #141a22); }
h1 { font-size: 1.35rem; margin: 0; }
.controls { display: flex; align-items: center; gap: .75rem; }
.field { display: flex; align-items: center; gap: .5rem; font-size: .875rem; }
.output { flex: 1; min-height: 60vh; width: 100%; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; background: #fff; }
.empty, .error, .warn { margin: 0; color: var(--zfy-muted, #5a6472); }
.error { color: var(--zfy-danger, #c6512f); }
.warn { color: var(--zfy-warning-ink, #8a5a1e); font-size: .9rem; }
</style>
