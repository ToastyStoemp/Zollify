<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Printer } from '../electron/shared';

/**
 * One item's PhotoCraft `file.print` params. The common ones are fields; the
 * rest (printerSettings from PhotoCraft's Print Settings dialog, position,
 * marks, profile...) go in the JSON box and are merged in as they are.
 */
const props = defineProps<{ params: Record<string, unknown>; printers: Printer[]; papers: readonly string[] }>();
const emit = defineEmits<{ update: [params: Record<string, unknown>] }>();

const FIELDS = ['printer', 'paper', 'orientation', 'scaleToFit', 'scale', 'colorHandling', 'emulsionDown'] as const;

const form = ref(fromParams(props.params));
const extra = ref(extraOf(props.params));
const extraError = ref('');

watch(() => props.params, (p) => {
  form.value = fromParams(p);
  extra.value = extraOf(p);
});

function fromParams(p: Record<string, unknown>) {
  return {
    printer: String(p.printer ?? ''),
    paper: Array.isArray(p.paper) ? 'custom' : String(p.paper ?? 'letter'),
    customPaper: Array.isArray(p.paper) ? (p.paper as number[]).join(', ') : '',
    orientation: String(p.orientation ?? 'portrait'),
    scaleToFit: p.scaleToFit === true,
    scale: Number(p.scale ?? 100),
    colorHandling: String(p.colorHandling ?? 'printerManages'),
    emulsionDown: p.emulsionDown === true,
  };
}
function extraOf(p: Record<string, unknown>): string {
  const rest = Object.fromEntries(Object.entries(p).filter(([k]) => !(FIELDS as readonly string[]).includes(k)));
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
}

const customPaper = computed(() => {
  const nums = form.value.customPaper.split(/[,\sx]+/).map(Number).filter((n) => n > 36);
  return nums.length === 2 ? nums : null;
});

function save(): void {
  let rest: Record<string, unknown> = {};
  extraError.value = '';
  if (extra.value.trim()) {
    try {
      rest = JSON.parse(extra.value) as Record<string, unknown>;
    } catch (err) {
      extraError.value = `Extra settings are not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
  }
  const f = form.value;
  const paper = f.paper === 'custom' ? customPaper.value : f.paper;
  if (!paper) {
    extraError.value = 'Custom paper needs a width and a height in points, e.g. 420, 595';
    return;
  }
  emit('update', {
    ...rest,
    ...(f.printer ? { printer: f.printer } : {}),
    paper,
    orientation: f.orientation,
    scaleToFit: f.scaleToFit,
    ...(f.scaleToFit ? {} : { scale: f.scale > 0 ? f.scale : 100 }),
    colorHandling: f.colorHandling,
    ...(f.emulsionDown ? { emulsionDown: true } : {}),
  });
}
</script>

<template>
  <form class="settings" @submit.prevent="save">
    <label>
      <span>Printer</span>
      <select v-model="form.printer">
        <option value="">System default</option>
        <option v-for="p in printers" :key="p.name" :value="p.name">{{ p.name }}{{ p.default ? ' (default)' : '' }}</option>
        <option v-if="form.printer && !printers.some((p) => p.name === form.printer)" :value="form.printer">{{ form.printer }}</option>
      </select>
    </label>
    <label>
      <span>Paper</span>
      <select v-model="form.paper">
        <option v-for="p in papers" :key="p" :value="p">{{ p }}</option>
        <option value="custom">Custom (points)</option>
      </select>
    </label>
    <label v-if="form.paper === 'custom'"><span>Width, height (pt)</span><input v-model="form.customPaper" placeholder="420, 595" /></label>
    <label>
      <span>Orientation</span>
      <select v-model="form.orientation"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select>
    </label>
    <label class="inline"><input v-model="form.scaleToFit" type="checkbox" /> Scale to fit</label>
    <label v-if="!form.scaleToFit"><span>Scale %</span><input v-model.number="form.scale" type="number" min="1" max="1000" /></label>
    <label>
      <span>Colour</span>
      <select v-model="form.colorHandling">
        <option value="printerManages">Printer manages colours</option>
        <option value="photocraftManages">PhotoCraft manages (needs printerProfile below)</option>
        <option value="noColorManagement">No colour management</option>
      </select>
    </label>
    <label class="inline"><input v-model="form.emulsionDown" type="checkbox" /> Mirror (emulsion down)</label>
    <label class="wide">
      <span>Extra PhotoCraft print settings (JSON): printerSettings, printerProfile, intent, top/left, cornerCropMarks...</span>
      <textarea v-model="extra" rows="3" spellcheck="false" placeholder='{"printerSettings": "…hex from PhotoCraft Print Settings…"}'></textarea>
    </label>
    <p v-if="extraError" class="error">{{ extraError }}</p>
    <div><button type="submit" class="primary">Save settings</button></div>
  </form>
</template>

<style scoped>
.settings { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: .6rem .9rem; align-items: end; padding: .3rem 0; }
.wide { grid-column: 1 / -1; }
textarea { font-family: ui-monospace, monospace; font-size: .8rem; }
</style>
