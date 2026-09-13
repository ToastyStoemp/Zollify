<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import { buildAllVersionsHtml } from '../engine/all-versions';
import type { CustomsState } from '../engine/model';
import type { GoodsDocNum } from '../engine/goods-list';

const props = defineProps<{ state: CustomsState | null }>();

const docNum = ref<GoodsDocNum | null>(null);
const error = ref<string | null>(null);
const html = ref('');

const options: { value: GoodsDocNum | null; label: string }[] = [
  { value: null, label: 'All documents' },
  { value: 1, label: 'Goods list 1' },
  { value: 2, label: 'Goods list 2' },
  { value: 3, label: 'Goods list 3' },
];

/**
 * The engine is the ported ZollTool implementation and its output is verified
 * byte-for-byte against the legacy tool by the golden-file tests. This view
 * renders that output and adds nothing to it — any formatting done here would
 * be formatting the tests don't cover.
 */
watchEffect(() => {
  error.value = null;
  if (!props.state) {
    html.value = '';
    return;
  }
  try {
    html.value = buildAllVersionsHtml(props.state, docNum.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    html.value = '';
  }
});

const hasOutput = computed(() => html.value.length > 0);

function printDocuments(): void {
  const frame = document.getElementById('customs-output') as HTMLIFrameElement | null;
  frame?.contentWindow?.print();
}
</script>

<template>
  <section class="customs-documents">
    <header class="bar">
      <h1>Customs documents</h1>
      <div class="controls">
        <label class="field">
          <span>Show</span>
          <select v-model="docNum">
            <option v-for="opt in options" :key="String(opt.value)" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </label>
        <button type="button" :disabled="!hasOutput" @click="printDocuments">Print</button>
      </div>
    </header>

    <p v-if="!props.state" class="empty">Pick an event to generate its customs documents.</p>
    <p v-else-if="error" class="error" role="alert">{{ error }}</p>

    <!--
      Rendered in a sandboxed iframe rather than with v-html. The engine emits a
      complete document meant for print, and the sandbox keeps it from reaching
      the shell's DOM, storage or session even though we generated it ourselves.
    -->
    <iframe
      v-else-if="hasOutput"
      id="customs-output"
      class="output"
      title="Generated customs documents"
      sandbox="allow-same-origin allow-modals"
      :srcdoc="html"
    ></iframe>
  </section>
</template>

<style scoped>
.customs-documents { display: flex; flex-direction: column; gap: 1rem; height: 100%; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { font-size: 1.25rem; margin: 0; }
.controls { display: flex; align-items: center; gap: .75rem; }
.field { display: flex; align-items: center; gap: .5rem; font-size: .875rem; }
.output { flex: 1; min-height: 60vh; width: 100%; border: 1px solid var(--bly-line, #d6dde4); border-radius: 8px; background: #fff; }
.empty, .error { color: var(--bly-muted, #5a6472); }
.error { color: var(--bly-danger, #c6512f); }
</style>
