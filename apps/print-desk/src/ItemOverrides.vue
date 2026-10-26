<script setup lang="ts">
import { computed } from 'vue';
import type { ImageInfo, Units } from '../electron/shared';
import { PAPER_OPTIONS, paperName, paperParam } from '../electron/shared';
import ScaleFields from './ScaleFields.vue';

/**
 * An item that prints with the global settings, with its own paper, orientation and scaling
 * where it says so. `base` is what it prints with without overrides (global settings, paper
 * from its name, orientation from its image); `overrides` holds only what the item changes.
 */
const props = defineProps<{ base: Record<string, unknown>; overrides: Record<string, unknown>; image: ImageInfo | null; units: Units; sizeFromName: string | null; fromImage: boolean }>();
const emit = defineEmits<{ update: [overrides: Record<string, unknown>]; units: [units: Units]; own: [] }>();

const label = (paper: unknown): string => {
  const n = paperName(paper);
  return n ? (/^a\d$/.test(n) ? n.toUpperCase() : n) : 'custom paper';
};
const paperSource = computed(() => (props.sizeFromName ? 'from its name' : 'global'));
const orientationSource = computed(() => (props.fromImage ? 'from its image' : 'global'));

const paper = computed(() => (props.overrides.paper === undefined ? '' : (paperName(props.overrides.paper) ?? '')));
const orientation = computed(() => String(props.overrides.orientation ?? ''));
/** '' global, 'fit' scale to fit, 'size' an exact scale or size. */
const scaling = computed(() => (props.overrides.scaleToFit === undefined ? '' : props.overrides.scaleToFit ? 'fit' : 'size'));
const scale = computed(() => Number(props.overrides.scale ?? props.base.scale ?? 100));

/** The overrides with `key` set to `value`, or without it for undefined. */
function set(changes: Record<string, unknown>): void {
  const next = { ...props.overrides };
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  emit('update', next);
}
function setScaling(value: string): void {
  if (value === '') set({ scaleToFit: undefined, scale: undefined, center: undefined });
  else if (value === 'fit') set({ scaleToFit: true, scale: undefined, center: undefined });
  else set({ scaleToFit: false, scale: scale.value, center: true });
}
</script>

<template>
  <div class="overrides">
    <p class="muted">Prints with the global print settings. Change the paper, orientation or scaling for this item only:</p>
    <div class="fields">
      <label>
        <span>Paper</span>
        <select :value="paper" @change="set({ paper: ($event.target as HTMLSelectElement).value ? paperParam(($event.target as HTMLSelectElement).value) : undefined })">
          <option value="">{{ label(base.paper) }} ({{ paperSource }})</option>
          <option v-for="p in PAPER_OPTIONS" :key="p" :value="p">{{ /^a\d$/.test(p) ? p.toUpperCase() : p }}</option>
        </select>
      </label>
      <label>
        <span>Orientation</span>
        <select :value="orientation" @change="set({ orientation: ($event.target as HTMLSelectElement).value || undefined })">
          <option value="">{{ base.orientation || 'portrait' }} ({{ orientationSource }})</option>
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
      </label>
      <label>
        <span>Scaling</span>
        <select :value="scaling" @change="setScaling(($event.target as HTMLSelectElement).value)">
          <option value="">{{ base.scaleToFit ? 'Scale to fit' : `${base.scale ?? 100}%` }} (global)</option>
          <option value="fit">Scale to fit</option>
          <option value="size">Exact size</option>
        </select>
      </label>
      <ScaleFields v-if="scaling === 'size'" :scale="scale" :image="image" :units="units" @update:scale="set({ scale: $event })" @units="emit('units', $event)" />
    </div>
    <div class="actions">
      <button v-if="Object.keys(overrides).length" type="button" class="quiet" @click="emit('update', {})">Back to the global settings</button>
      <button type="button" class="quiet" @click="emit('own')">All settings of its own</button>
    </div>
  </div>
</template>

<style scoped>
.overrides > p { margin: 0 0 .4rem; }
.fields { display: flex; flex-wrap: wrap; gap: .6rem .9rem; align-items: end; }
.actions { display: flex; gap: .5rem; margin-top: .4rem; }
</style>
