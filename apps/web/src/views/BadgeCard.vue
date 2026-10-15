<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { saveFile } from '@zollify/platform';
import { Icon } from '@zollify/ui';
import { events } from '../boot';
import { BADGE_SIZES, renderBadge, type BadgeSize } from '../badge-render';

/**
 * A staff badge, ready to print: on a card through the browser, on a label
 * printer installed on this computer (pick its label size and print), or
 * straight to the Label Printer module's Bluetooth printer. The preview is
 * the exact image that prints.
 */
const props = defineProps<{ code: string; name: string; accountName: string }>();

const SIZE_KEY = 'zollify.badge.size';
const stored = (() => {
  try {
    return localStorage.getItem(SIZE_KEY);
  } catch {
    return null;
  }
})();
const sizeId = ref(BADGE_SIZES.some((s) => s.id === stored) ? stored! : 'card');
const size = computed<BadgeSize>(() => BADGE_SIZES.find((s) => s.id === sizeId.value) ?? BADGE_SIZES[0]!);
watch(sizeId, (id) => {
  try {
    localStorage.setItem(SIZE_KEY, id);
  } catch {
    /* remembered for this visit only */
  }
});

const displayName = computed(() => props.name.replace(/\b\w/g, (c) => c.toUpperCase()));
const canvas = ref<HTMLCanvasElement | null>(null);
function draw(): void {
  if (canvas.value) renderBadge(canvas.value, size.value, { name: displayName.value, shop: props.accountName, code: props.code });
}
onMounted(draw);
watch([size, () => props.code], draw);

/** One badge per page, the page exactly the label's size, the image at its true size. */
function print(): void {
  if (!canvas.value) return;
  const s = size.value;
  const png = canvas.value.toDataURL('image/png');
  const w = window.open('', '_blank', 'width=480,height=360');
  if (!w) return void savePng();
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Badge</title><style>
@page { size: ${s.widthMm}mm ${s.heightMm}mm; margin: 0; }
html, body { margin: 0; background: #fff; }
img { display: block; width: ${s.widthMm}mm; height: ${s.heightMm}mm; image-rendering: pixelated; }
</style></head><body><img src="${png}" alt=""></body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

async function savePng(): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.value?.toBlob(resolve, 'image/png') ?? resolve(null));
  if (blob) await saveFile(`badge-${props.name.replace(/[^\w-]+/g, '-').toLowerCase()}-${size.value.id}.png`, blob, 'image/png');
}

// The Label Printer module, when it is on, prints to its Bluetooth printer.
const router = useRouter();
const labelPrinter = computed(() => router.hasRoute('label-printer:index'));
function toLabelPrinter(): void {
  events.emit('label:print', { title: displayName.value, subtitle: props.accountName, caption: 'Staff badge', barcode: props.code });
  void router.push({ name: 'label-printer:index' });
}
</script>

<template>
  <div class="badge">
    <label class="size">
      <span>Print on</span>
      <select v-model="sizeId">
        <option v-for="s in BADGE_SIZES" :key="s.id" :value="s.id">{{ s.label }}</option>
      </select>
    </label>
    <canvas ref="canvas" class="preview" :style="{ aspectRatio: `${size.widthMm} / ${size.heightMm}`, width: `min(100%, ${size.widthMm * 0.25}rem)` }" role="img" :aria-label="`Staff badge for ${displayName}`" />
    <div class="actions">
      <button type="button" class="primary" @click="print"><Icon name="printer" :size="14" /> Print</button>
      <button type="button" @click="savePng"><Icon name="download" :size="14" /> Save image</button>
      <button v-if="labelPrinter" type="button" @click="toLabelPrinter"><Icon name="tag" :size="14" /> Label printer</button>
    </div>
    <p class="hint">
      For a label printer on this computer, pick its label size, then Print and choose the printer. "Save image" gives a picture at label-printer resolution for a printer's own app<template v-if="labelPrinter">; "Label printer" sends it to the Bluetooth printer in Print labels</template>.
    </p>
  </div>
</template>

<style scoped>
.badge { display: flex; flex-direction: column; gap: .7rem; align-items: center; }
.size { display: flex; align-items: center; gap: .5rem; font-size: .85rem; align-self: stretch; }
.size select { flex: 1; }
.preview { display: block; border-radius: 6px; border: 1px solid var(--zfy-line, #d6dde4); box-shadow: 0 2px 8px var(--zfy-shadow, rgba(20, 26, 34, .12)); background: #fff; }
.actions { display: flex; gap: .5rem; flex-wrap: wrap; justify-content: center; }
.actions button { display: inline-flex; align-items: center; gap: .35rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .78rem; text-align: center; }
</style>
