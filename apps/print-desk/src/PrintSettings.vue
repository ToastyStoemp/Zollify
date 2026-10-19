<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Printer } from '../electron/shared';
import { PAPER_OPTIONS, paperName, paperParam } from '../electron/shared';

/**
 * One item's PhotoCraft `file.print` params. The common ones are fields; the
 * rest (printerSettings from PhotoCraft's Print Settings dialog, position,
 * marks, profile...) go in the JSON box and are merged in as they are.
 *
 * `size` is the A size the item's name says, when it says one: it offers
 * "apply to all items of this size" next to "apply to all items".
 */
const props = defineProps<{ params: Record<string, unknown>; printers: Printer[]; size: string | null }>();
const emit = defineEmits<{ update: [params: Record<string, unknown>]; apply: [params: Record<string, unknown>, scope: 'all' | 'size'] }>();

const FIELDS = ['printer', 'paper', 'orientation', 'scaleToFit', 'scale', 'center', 'top', 'left', 'colorHandling', 'emulsionDown'] as const;

/** PhotoCraft takes top/left in inches from the paper's top-left corner; the form shows millimetres. */
const MM_PER_IN = 25.4;
const toMm = (inches: unknown): number => Math.round((Number(inches) || 0) * MM_PER_IN * 10) / 10;

const form = ref(fromParams(props.params));
const extra = ref(extraOf(props.params));
const extraError = ref('');
/** What "Load from PhotoCraft" put in the form, until it is saved. */
const loaded = ref('');

/** Fills the form with the settings of PhotoCraft's last print; saving or applying them is the user's call. */
async function loadFromPhotoCraft(): Promise<void> {
  extraError.value = '';
  loaded.value = '';
  try {
    const p = await window.printDesk.photocraft.lastPrint();
    form.value = fromParams(p);
    extra.value = extraOf(p);
    const paper = paperName(p.paper);
    const what = [p.printer || 'the default printer', paper ? (/^a\d$/.test(paper) ? paper.toUpperCase() : paper) : 'custom paper', p.orientation === 'landscape' ? 'landscape' : 'portrait', p.printerSettings ? 'with driver settings' : 'no driver settings'];
    loaded.value = `Loaded PhotoCraft's last print: ${what.join(', ')}. Save, or apply it, to keep it.`;
  } catch (err) {
    extraError.value = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
  }
}

// By content: an item without settings gets fresh defaults on every render, which must not wipe the form.
watch(
  () => JSON.stringify(props.params),
  () => {
    form.value = fromParams(props.params);
    extra.value = extraOf(props.params);
  },
);

function fromParams(p: Record<string, unknown>) {
  return {
    printer: String(p.printer ?? ''),
    paper: paperName(p.paper ?? 'letter') ?? 'custom',
    customPaper: Array.isArray(p.paper) && !paperName(p.paper) ? (p.paper as number[]).join(', ') : '',
    orientation: String(p.orientation ?? 'portrait'),
    scaleToFit: p.scaleToFit === true,
    scale: Number(p.scale ?? 100),
    // PhotoCraft centres unless told otherwise.
    center: p.center !== false,
    topMm: toMm(p.top),
    leftMm: toMm(p.left),
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

/** The form as `file.print` params, or null (with the reason on screen) when it does not add up. */
function collect(): Record<string, unknown> | null {
  let rest: Record<string, unknown> = {};
  extraError.value = '';
  if (extra.value.trim()) {
    try {
      rest = JSON.parse(extra.value) as Record<string, unknown>;
    } catch (err) {
      extraError.value = `Extra settings are not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
      return null;
    }
  }
  const f = form.value;
  const paper = f.paper === 'custom' ? customPaper.value : paperParam(f.paper);
  if (!paper) {
    extraError.value = 'Custom paper needs a width and a height in points, e.g. 420, 595';
    return null;
  }
  return {
    ...rest,
    ...(f.printer ? { printer: f.printer } : {}),
    paper,
    orientation: f.orientation,
    scaleToFit: f.scaleToFit,
    ...(f.scaleToFit ? {} : { scale: f.scale > 0 ? f.scale : 100 }),
    center: f.center,
    ...(f.center ? {} : { top: Math.max(0, f.topMm || 0) / MM_PER_IN, left: Math.max(0, f.leftMm || 0) / MM_PER_IN }),
    colorHandling: f.colorHandling,
    ...(f.emulsionDown ? { emulsionDown: true } : {}),
  };
}
function save(): void {
  const params = collect();
  if (!params) return;
  loaded.value = '';
  emit('update', params);
}
function apply(scope: 'all' | 'size'): void {
  const params = collect();
  if (!params) return;
  loaded.value = '';
  emit('apply', params, scope);
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
        <option v-for="p in PAPER_OPTIONS" :key="p" :value="p">{{ /^a\d$/.test(p) ? p.toUpperCase() : p }}</option>
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
    <label class="inline"><input v-model="form.center" type="checkbox" /> Center on paper</label>
    <template v-if="!form.center">
      <label><span>From top (mm)</span><input v-model.number="form.topMm" type="number" min="0" step="0.5" /></label>
      <label><span>From left (mm)</span><input v-model.number="form.leftMm" type="number" min="0" step="0.5" /></label>
    </template>
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
      <span>Extra PhotoCraft print settings (JSON): printerSettings, printerProfile, intent, cornerCropMarks...</span>
      <textarea v-model="extra" rows="3" spellcheck="false" placeholder='{"printerSettings": "…hex from PhotoCraft Print Settings…"}'></textarea>
    </label>
    <p v-if="extraError" class="error">{{ extraError }}</p>
    <p v-if="loaded" class="loaded" role="status">{{ loaded }}</p>
    <div class="actions">
      <button type="button" title="Fill this form with the settings of your last print in PhotoCraft (File › Print), driver settings included" @click="loadFromPhotoCraft">Load from PhotoCraft</button>
      <button type="submit" class="primary">Save settings</button>
      <button v-if="size" type="button" @click="apply('size')">Apply to all {{ size.toUpperCase() }} items</button>
      <button type="button" @click="apply('all')">Apply to all items</button>
    </div>
  </form>
</template>

<style scoped>
.settings { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: .6rem .9rem; align-items: end; padding: .3rem 0; }
.wide, .actions { grid-column: 1 / -1; }
.actions { display: flex; gap: .5rem; flex-wrap: wrap; }
.loaded, .error { grid-column: 1 / -1; margin: 0; }
.loaded { color: var(--zfy-success); }
textarea { font-family: ui-monospace, monospace; font-size: .8rem; }
</style>
