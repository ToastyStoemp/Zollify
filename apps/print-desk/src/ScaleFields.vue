<script setup lang="ts">
import { computed } from 'vue';
import type { ImageInfo, Units } from '../electron/shared';
import { MM_PER, printSizeMm, scaleForMm } from '../electron/shared';

/**
 * How big the image prints when it is not scaled to fit: a scale, and with the image known, its
 * width and height in the chosen unit (editing either sets the scale; the image keeps its shape).
 * The unit is the app's, shared by every form.
 */
const props = defineProps<{ scale: number; image: ImageInfo | null; units: Units }>();
const emit = defineEmits<{ 'update:scale': [scale: number]; units: [units: Units] }>();

const round = (n: number): number => Math.round(n * 100) / 100;
const size = computed(() => (props.image ? printSizeMm(props.image, props.scale).map((mm) => round(mm / MM_PER[props.units])) : null));

/** Kept to 4 decimals, so a size typed in round-trips exactly (20 cm stays 200 mm). */
function setScale(value: number): void {
  if (value > 0) emit('update:scale', Math.round(value * 10000) / 10000);
}
/** A width (side 0) or height (side 1) in the unit, as the scale that prints it. */
function setSide(side: 0 | 1, value: number): void {
  if (!props.image || !(value > 0)) return;
  const px = side === 0 ? props.image.width : props.image.height;
  setScale(scaleForMm(px, props.image.resolution, value * MM_PER[props.units]));
}
</script>

<template>
  <label><span>Scale %</span><input :value="scale" type="number" min="1" max="1000" step="0.01" @change="setScale(($event.target as HTMLInputElement).valueAsNumber)" /></label>
  <template v-if="size">
    <label><span>Width ({{ units }})</span><input :value="size[0]" type="number" min="0.01" step="0.01" @change="setSide(0, ($event.target as HTMLInputElement).valueAsNumber)" /></label>
    <label><span>Height ({{ units }})</span><input :value="size[1]" type="number" min="0.01" step="0.01" @change="setSide(1, ($event.target as HTMLInputElement).valueAsNumber)" /></label>
  </template>
  <p v-else class="muted no-size">Width and height follow from the scale and each image's own size; link a file to set them here.</p>
  <label>
    <span>Unit</span>
    <select :value="units" @change="emit('units', ($event.target as HTMLSelectElement).value as Units)">
      <option value="cm">cm</option>
      <option value="mm">mm</option>
      <option value="in">inches</option>
    </select>
  </label>
</template>

<style scoped>
.no-size { margin: 0; align-self: center; font-size: .85rem; }
input[type='number'] { width: 6rem; }
</style>
