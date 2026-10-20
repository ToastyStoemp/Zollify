<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DevModeSummary } from '../electron/devmode';
import type { ImageInfo, Printer, Units } from '../electron/shared';
import { MM_PER, PAPER_OPTIONS, paperName, paperParam } from '../electron/shared';
import ScaleFields from './ScaleFields.vue';

/**
 * One item's PhotoCraft `file.print` params. The common ones are fields; the
 * rest (printerSettings from PhotoCraft's Print Settings dialog, position,
 * marks, profile...) go in the JSON box and are merged in as they are.
 *
 * `size` is the A size the item's name says, when it says one: it offers
 * "apply to all items of this size" next to "apply to all items".
 */
const props = defineProps<{ params: Record<string, unknown>; printers: Printer[]; size: string | null; noApply?: boolean; image?: ImageInfo | null; units: Units }>();
const emit = defineEmits<{ update: [params: Record<string, unknown>]; apply: [params: Record<string, unknown>, scope: 'all' | 'size']; units: [units: Units] }>();

const FIELDS = ['printer', 'paper', 'orientation', 'scaleToFit', 'scale', 'center', 'top', 'left', 'colorHandling', 'emulsionDown'] as const;

/** PhotoCraft takes top/left in inches from the paper's top-left corner; the form shows the app's unit. */
const inUnit = (inches: number): number => Math.round(((inches * 25.4) / MM_PER[props.units]) * 100) / 100;
const fromUnit = (value: number): number => Math.max(0, value || 0) * (MM_PER[props.units] / 25.4);

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

/** The JSON box, {} while it doesn't parse. */
const extraJson = computed((): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(extra.value || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
});
/** The ICC profile PhotoCraft converts with, when it manages colour. */
const profile = computed((): DevModeSummary[] => {
  const p = extraJson.value;
  if (form.value.colorHandling !== 'photocraftManages') return [];
  const file = typeof p.printerProfile === 'string' ? p.printerProfile.split(/[\\/]/).pop() : '';
  const intent = typeof p.intent === 'string' ? p.intent : 'relative';
  return [
    { label: 'ICC profile', value: file || 'none set (PhotoCraft needs printerProfile)' },
    { label: 'Profile intent', value: `${intent}${p.bpc === false ? '' : ', black point compensation'}` },
  ];
});
/** The driver settings in the JSON box, read out by name. */
const driver = ref<DevModeSummary[] | null>(null);
const driverHex = computed((): string => (typeof extraJson.value.printerSettings === 'string' ? extraJson.value.printerSettings : ''));
const readout = computed((): DevModeSummary[] => [...profile.value, ...(driver.value ?? [])]);
watch(
  driverHex,
  async (hex) => {
    driver.value = null;
    if (!hex) return;
    const lines = await window.printDesk.photocraft.describeSettings(hex).catch(() => null);
    if (hex === driverHex.value) driver.value = lines ?? [{ label: 'Driver settings', value: 'not readable as Windows driver settings' }];
  },
  { immediate: true },
);

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
    /** Inches, as PhotoCraft takes them; shown in the app's unit. */
    top: Number(p.top) || 0,
    left: Number(p.left) || 0,
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
    ...(f.center ? {} : { top: Math.max(0, f.top), left: Math.max(0, f.left) }),
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
    <ScaleFields v-if="!form.scaleToFit" v-model:scale="form.scale" :image="image ?? null" :units="units" @units="emit('units', $event)" />
    <label class="inline"><input v-model="form.center" type="checkbox" /> Center on paper</label>
    <template v-if="!form.center">
      <label><span>From top ({{ units }})</span><input :value="inUnit(form.top)" type="number" min="0" step="0.01" @change="form.top = fromUnit(($event.target as HTMLInputElement).valueAsNumber)" /></label>
      <label><span>From left ({{ units }})</span><input :value="inUnit(form.left)" type="number" min="0" step="0.01" @change="form.left = fromUnit(($event.target as HTMLInputElement).valueAsNumber)" /></label>
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
    <dl v-if="readout.length" class="driver wide" aria-label="Colour and driver settings">
      <template v-for="l in readout" :key="l.label"><dt>{{ l.label }}</dt><dd>{{ l.value }}</dd></template>
    </dl>
    <p v-if="extraError" class="error">{{ extraError }}</p>
    <p v-if="loaded" class="loaded" role="status">{{ loaded }}</p>
    <div class="actions">
      <button type="button" title="Fill this form with the settings of your last print in PhotoCraft (File › Print), driver settings included" @click="loadFromPhotoCraft">Load from PhotoCraft</button>
      <button type="submit" class="primary">Save settings</button>
      <button v-if="size && !noApply" type="button" @click="apply('size')">Apply to all {{ size.toUpperCase() }} items</button>
      <button v-if="!noApply" type="button" @click="apply('all')">Apply to all items</button>
    </div>
  </form>
</template>

<style scoped>
.settings { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: .6rem .9rem; align-items: end; padding: .3rem 0; }
.wide, .actions { grid-column: 1 / -1; }
.actions { display: flex; gap: .5rem; flex-wrap: wrap; }
.loaded, .error { grid-column: 1 / -1; margin: 0; }
.loaded { color: var(--zfy-success); }
.driver { display: grid; grid-template-columns: max-content 1fr; gap: .15rem .8rem; margin: 0; font-size: .85rem; }
.driver dt { color: var(--zfy-muted); }
.driver dd { margin: 0; }
textarea { font-family: ui-monospace, monospace; font-size: .8rem; }
</style>
