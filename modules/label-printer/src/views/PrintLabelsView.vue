<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch, type Directive } from 'vue';
import { Capacitor } from '@capacitor/core';
import { shortBarcode } from '@zollify/shared';
import { DEFAULT_LABEL_SIZE, renderLabel, type LabelSize } from '../engine/label';
import { rasterizeCanvas } from '../engine/raster';
import { PhomemoPrinter, type PrintMode } from '../engine/phomemo';
import { sdk } from '../runtime';

/**
 * Prints SKU-barcode + product-name labels to a Phomemo M110 over Bluetooth.
 * Works two ways, both through @capacitor-community/bluetooth-le (see
 * engine/phomemo.ts): as the Android app, via its native BLE plugin; as a
 * website, via Web Bluetooth (Chrome/Edge, desktop or Android - not
 * Safari/iOS, which has none). See engine/phomemo.ts for what in this
 * protocol is confirmed vs. reverse-engineered-but-unverified.
 *
 * Selection is a type > product > variant tree - a label is printed per
 * variant SKU (or per plain product when it has none), which is what a
 * barcode actually has to identify. "Select claimed" is the fast path: the
 * active event's claimed stock, one click, then deselect what you don't want.
 */

// ── Leaf model: one printable label per row ─────────────────────────────────
interface Leaf {
  key: string; // `${productId}:${variantId}`
  productId: string;
  variantId: string; // '' for a plain product
  sku: string;
  title: string;
  /** Just the variant's own name, for the indented row - `title` carries the full "Product - Variant" for the printed label and the preview. */
  variantName?: string;
  /** The product's normalized type ('Other' fallback) - fed to shortBarcode() as a cosmetic prefix, not part of what makes the code unique. */
  type: string;
}
interface ProductGroup {
  productId: string;
  title: string;
  leaves: Leaf[]; // length 1 for a plain product, one per listed variant otherwise
}
interface TypeGroup {
  type: string;
  products: ProductGroup[];
}

const typeGroups = computed<TypeGroup[]>(() => {
  const byType = new Map<string, ProductGroup[]>();
  for (const p of sdk().data.products.list()) {
    const type = p.type?.trim() || 'Other';
    const leaves: Leaf[] =
      p.variants.length > 0
        ? p.variants
            .filter((v) => !v.unlisted)
            .map((v) => {
              const variantName = v.name?.trim() || '(unnamed)';
              return { key: `${p.id}:${v.id}`, productId: p.id, variantId: v.id, sku: (v.sku?.trim() || p.sku?.trim() || ''), title: `${p.title || '(untitled)'} - ${variantName}`, variantName, type };
            })
            .filter((l) => l.sku)
        : (p.sku?.trim() ? [{ key: `${p.id}:`, productId: p.id, variantId: '', sku: p.sku.trim(), title: p.title || '(untitled)', type }] : []);
    if (!leaves.length) continue;
    const group: ProductGroup = { productId: p.id, title: p.title || '(untitled)', leaves };
    (byType.get(type) ?? byType.set(type, []).get(type)!).push(group);
  }
  return [...byType.entries()].map(([type, products]) => ({ type, products }));
});
const allLeaves = computed(() => typeGroups.value.flatMap((g) => g.products.flatMap((p) => p.leaves)));
const skippedCount = computed(() => sdk().data.products.list().length - typeGroups.value.reduce((n, g) => n + g.products.length, 0));

// ── Search ───────────────────────────────────────────────────────────────────
const search = ref('');
const visibleGroups = computed<TypeGroup[]>(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return typeGroups.value;
  return typeGroups.value
    .map((g) => ({ type: g.type, products: g.products.filter((p) => p.title.toLowerCase().includes(q) || p.leaves.some((l) => l.title.toLowerCase().includes(q) || l.sku.toLowerCase().includes(q))) }))
    .filter((g) => g.products.length);
});

// ── Selection (tri-state at type and product level) ─────────────────────────
const selected = ref<Set<string>>(new Set());
const qty = reactive<Record<string, number>>({});
const expanded = ref<Set<string>>(new Set());

function leafState(keys: string[]): 'all' | 'none' | 'some' {
  const n = keys.filter((k) => selected.value.has(k)).length;
  return n === 0 ? 'none' : n === keys.length ? 'all' : 'some';
}
const typeKeys = (g: TypeGroup) => g.products.flatMap((p) => p.leaves.map((l) => l.key));
const productKeys = (p: ProductGroup) => p.leaves.map((l) => l.key);

function setKeys(keys: string[], on: boolean): void {
  const next = new Set(selected.value);
  for (const k of keys) {
    if (on) {
      next.add(k);
      if (!qty[k]) qty[k] = 1;
    } else next.delete(k);
  }
  selected.value = next;
}
function toggleType(g: TypeGroup): void {
  setKeys(typeKeys(g), leafState(typeKeys(g)) !== 'all');
}
function toggleProduct(p: ProductGroup): void {
  setKeys(productKeys(p), leafState(productKeys(p)) !== 'all');
}
function toggleLeaf(l: Leaf): void {
  setKeys([l.key], !selected.value.has(l.key));
}
function toggleExpanded(productId: string): void {
  const next = new Set(expanded.value);
  if (next.has(productId)) next.delete(productId);
  else next.add(productId);
  expanded.value = next;
}

function selectAll(): void {
  setKeys(allLeaves.value.map((l) => l.key), true);
}
function selectNone(): void {
  selected.value = new Set();
}
/**
 * The fast path: whatever the active event has claimed - one label per unit
 * claimed, not per SKU, since the point is a label for every physical item
 * going out. Falls back to on-hand stock if no event is active.
 */
async function selectClaimed(): Promise<void> {
  const event = sdk().data.events.active();
  const counts = new Map<string, number>();
  if (event) {
    const availability = sdk().data.inventory.availability(event.id);
    const claimed = new Map(availability.map((a) => [`${a.productId}:${a.variantId}`, a.claimed]));
    for (const l of allLeaves.value) {
      const n = claimed.get(l.key) ?? 0;
      if (n > 0) counts.set(l.key, n);
    }
  } else {
    for (const l of allLeaves.value) {
      const n = sdk().data.inventory.onHand(l.productId, l.variantId || null);
      if (n > 0) counts.set(l.key, n);
    }
  }
  selectNone();
  setKeys([...counts.keys()], true);
  for (const [key, n] of counts) qty[key] = n;
  // A product with only some variants claimed reads clearer expanded.
  expanded.value = new Set(typeGroups.value.flatMap((g) => g.products).filter((p) => leafState(productKeys(p)) === 'some').map((p) => p.productId));
}
const activeEventName = computed(() => sdk().data.events.active()?.name ?? null);

/** Native checkboxes have no tri-state attribute - this keeps `.indeterminate` in sync with the "some selected" state. */
const vIndeterminate: Directive<HTMLInputElement, boolean> = {
  mounted(el, binding) { el.indeterminate = binding.value; },
  updated(el, binding) { el.indeterminate = binding.value; },
};

const chosen = computed(() => allLeaves.value.filter((l) => selected.value.has(l.key)));
const totalLabels = computed(() => chosen.value.reduce((n, l) => n + (qty[l.key] ?? 1), 0));

// ── Label size / print settings, persisted ───────────────────────────────────
const labelSize = ref<LabelSize>({ ...DEFAULT_LABEL_SIZE });
const speed = ref(4);
const density = ref(8);
/** See PrintMode in phomemo.ts - 'safe' paces off the printer's ff03 notifications when available. */
const printMode = ref<PrintMode>('continuous');
/** 50-150%, multiplies the title's auto-fit starting size - see RenderLabelOptions in label.ts. */
const titleScale = ref(1);
/** See RenderLabelOptions.showSkuText in label.ts - defaults on, matching the previous unconditional behaviour. */
const showSkuText = ref(true);

onMounted(async () => {
  const stored = await sdk().config.get<LabelSize>('labelSize');
  if (stored) labelSize.value = stored;
  speed.value = (await sdk().config.get<number>('speed')) ?? 4;
  density.value = (await sdk().config.get<number>('density')) ?? 8;
  printMode.value = (await sdk().config.get<PrintMode>('printMode')) ?? 'continuous';
  titleScale.value = (await sdk().config.get<number>('titleScale')) ?? 1;
  showSkuText.value = (await sdk().config.get<boolean>('showSkuText')) ?? true;
});
watch(labelSize, (v) => void sdk().config.set('labelSize', v), { deep: true });
watch(speed, (v) => void sdk().config.set('speed', v));
watch(density, (v) => void sdk().config.set('density', v));
watch(printMode, (v) => void sdk().config.set('printMode', v));
watch(titleScale, (v) => void sdk().config.set('titleScale', v));
watch(showSkuText, (v) => void sdk().config.set('showSkuText', v));

// ── Test label: preview/print without picking a real product ────────────────
const TEST_LEAF: Leaf = { key: '__test__', productId: '__test__', variantId: '', sku: 'TEST-0000001', title: 'Test Label', type: 'Test' };
const showTestPreview = ref(false);

// ── Preview: redraws whenever the first chosen leaf or the label size changes ──
const previewCanvas = ref<HTMLCanvasElement | null>(null);
const previewLeaf = computed(() => (showTestPreview.value ? TEST_LEAF : chosen.value[0] ?? null));
function redrawPreview(): void {
  const canvas = previewCanvas.value;
  const l = previewLeaf.value;
  if (!canvas) return;
  if (!l) {
    canvas.width = 0;
    canvas.height = 0;
    return;
  }
  renderLabel(canvas, labelSize.value, l.sku, l.title, {
    titleScale: titleScale.value,
    barcodeValue: shortBarcode(l.type, l.productId, l.variantId || undefined),
    showSkuText: showSkuText.value,
  });
}
watch([previewLeaf, labelSize, titleScale, showSkuText], redrawPreview, { flush: 'post' });
onMounted(redrawPreview);

// ── Printer connection ───────────────────────────────────────────────────────
const printer = new PhomemoPrinter();
const printerName = ref<string | null>(null);
// The Android app has no navigator.bluetooth (no Web Bluetooth in a
// Capacitor WebView) but bluetooth-le's native plugin covers it there instead.
const bluetoothSupported = Capacitor.isNativePlatform() || (typeof navigator !== 'undefined' && 'bluetooth' in navigator);
const busy = ref(false);
const progress = ref<{ done: number; total: number } | null>(null);
const error = ref<string | null>(null);
const deviceInfo = ref<string | null>(null);
const cancelRequested = ref(false);

async function connect(): Promise<void> {
  error.value = null;
  deviceInfo.value = null;
  try {
    await printer.connect();
    printerName.value = printer.name ?? 'Printer';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not connect to the printer.';
  }
}
function disconnect(): void {
  printer.disconnect();
  printerName.value = null;
  deviceInfo.value = null;
}
onUnmounted(() => printer.disconnect());

/**
 * Web Bluetooth has no "list nearby devices" API - only the native picker
 * `connect()` opens can show that, for privacy reasons every browser
 * enforces. This is the next best thing once connected: what GATT services
 * and characteristics this specific device actually has, so a "nothing
 * prints" failure can be told apart from "wrong service UUID entirely".
 */
async function showDeviceInfo(): Promise<void> {
  error.value = null;
  try {
    deviceInfo.value = await printer.listServices();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not read the device info.';
  }
}

const workCanvas = document.createElement('canvas');

async function printAll(): Promise<void> {
  if (!printer.connected) {
    error.value = 'Connect the printer first.';
    return;
  }
  error.value = null;
  busy.value = true;
  cancelRequested.value = false;
  progress.value = { done: 0, total: totalLabels.value };
  try {
    outer: for (const l of chosen.value) {
      const copies = Math.max(1, qty[l.key] ?? 1);
      renderLabel(workCanvas, labelSize.value, l.sku, l.title, {
        titleScale: titleScale.value,
        barcodeValue: shortBarcode(l.type, l.productId, l.variantId || undefined),
        showSkuText: showSkuText.value,
      });
      const rows = rasterizeCanvas(workCanvas);
      for (let i = 0; i < copies; i++) {
        // Only checked between whole labels, never mid-transmission - stopping
        // partway through one would leave the printer's buffer holding a
        // half-sent job that corrupts whatever prints next.
        if (cancelRequested.value) break outer;
        await printer.printRaster(rows, { speed: speed.value, density: density.value, mode: printMode.value });
        progress.value = { done: progress.value!.done + 1, total: progress.value!.total };
      }
    }
    if (cancelRequested.value) error.value = `Stopped after ${progress.value!.done} of ${progress.value!.total} labels.`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Printing failed partway through.';
  } finally {
    busy.value = false;
    cancelRequested.value = false;
    progress.value = null;
  }
}

function cancelPrint(): void {
  cancelRequested.value = true;
}

// ── Export as images ─────────────────────────────────────────────────────────
// A fallback path that needs no printer connection at all: one PNG per
// selected label, pixel-for-pixel what would otherwise be sent to the
// Phomemo - for printing a different way (e.g. imported into another app's
// own "custom label from picture" feature, which drives the printer through
// its own connection instead of this one).
const exporting = ref(false);
const exportProgress = ref<{ done: number; total: number } | null>(null);

async function exportPngs(): Promise<void> {
  error.value = null;
  exporting.value = true;
  exportProgress.value = { done: 0, total: chosen.value.length };
  try {
    for (const l of chosen.value) {
      renderLabel(workCanvas, labelSize.value, l.sku, l.title, {
        titleScale: titleScale.value,
        barcodeValue: shortBarcode(l.type, l.productId, l.variantId || undefined),
        showSkuText: showSkuText.value,
      });
      const blob = await new Promise<Blob | null>((resolve) => workCanvas.toBlob(resolve, 'image/png'));
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(l.sku || l.key).replace(/[^a-z0-9_-]+/gi, '_')}.png`;
        a.click();
        URL.revokeObjectURL(url);
      }
      exportProgress.value = { done: exportProgress.value!.done + 1, total: exportProgress.value!.total };
      // One tick between files - firing every download synchronously in the
      // same frame is what gets a browser's multi-download prompt to drop
      // some of them instead of queuing all.
      await new Promise((r) => setTimeout(r, 150));
    }
  } finally {
    exporting.value = false;
    exportProgress.value = null;
  }
}

async function printTestLabel(): Promise<void> {
  if (!printer.connected) {
    error.value = 'Connect the printer first.';
    return;
  }
  error.value = null;
  busy.value = true;
  try {
    renderLabel(workCanvas, labelSize.value, TEST_LEAF.sku, TEST_LEAF.title, {
      titleScale: titleScale.value,
      barcodeValue: shortBarcode(TEST_LEAF.type, TEST_LEAF.productId, TEST_LEAF.variantId || undefined),
      showSkuText: showSkuText.value,
    });
    const rows = rasterizeCanvas(workCanvas);
    await printer.printRaster(rows, { speed: speed.value, density: density.value, mode: printMode.value });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Test print failed.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="page labels">
    <header>
      <h1>Print labels</h1>
      <div class="tools">
        <input v-model="search" type="search" placeholder="Search products…" aria-label="Search products" />
      </div>
    </header>

    <p v-if="!bluetoothSupported" class="warn">
      This browser has no Web Bluetooth support. Use Chrome or Edge on desktop, Chrome on Android, or the Android app - not Safari or iOS.
    </p>

    <div class="grid">
      <article class="card products">
        <div class="quick">
          <button type="button" class="primary" @click="selectClaimed">
            Select claimed{{ activeEventName ? ` · ${activeEventName}` : '' }}
          </button>
          <button type="button" class="quiet" @click="selectAll">All</button>
          <button type="button" class="quiet" @click="selectNone">None</button>
          <span class="count">{{ selected.size }} selected</span>
        </div>
        <p v-if="!activeEventName" class="hint">No active event - "Select claimed" falls back to everything with on-hand stock.</p>
        <p v-if="skippedCount" class="hint">{{ skippedCount }} product{{ skippedCount === 1 ? '' : 's' }} without a SKU can't be listed - a barcode needs one.</p>

        <p v-if="!typeGroups.length" class="empty">No products with a SKU yet. Set one under Products.</p>
        <ul v-else class="tree">
          <li v-for="g in visibleGroups" :key="g.type" class="type-row">
            <label class="row group">
              <input type="checkbox" :checked="leafState(typeKeys(g)) === 'all'" v-indeterminate="leafState(typeKeys(g)) === 'some'" @change="toggleType(g)" />
              <span class="label">{{ g.type }}</span>
              <span class="sub">{{ typeKeys(g).length }}</span>
            </label>
            <ul class="products-in-type">
              <li v-for="p in g.products" :key="p.productId">
                <div class="row product">
                  <button v-if="p.leaves.length > 1" type="button" class="chevron" :class="{ open: expanded.has(p.productId) }" @click="toggleExpanded(p.productId)" aria-label="Toggle variants"><span>▸</span></button>
                  <span v-else class="chevron-spacer"></span>
                  <label class="pick">
                    <input type="checkbox" :checked="leafState(productKeys(p)) === 'all'" v-indeterminate="leafState(productKeys(p)) === 'some'" @change="toggleProduct(p)" />
                    <span class="label">{{ p.title }}</span>
                    <span v-if="p.leaves.length === 1" class="sku">{{ p.leaves[0]!.sku }}</span>
                    <span v-else class="sub">{{ p.leaves.length }} variants</span>
                  </label>
                  <input v-if="p.leaves.length === 1 && selected.has(p.leaves[0]!.key)" v-model.number="qty[p.leaves[0]!.key]" type="number" min="1" inputmode="numeric" class="qty" aria-label="Copies" />
                </div>
                <ul v-if="p.leaves.length > 1 && expanded.has(p.productId)" class="variants">
                  <li v-for="l in p.leaves" :key="l.key" class="row variant">
                    <label class="pick">
                      <input type="checkbox" :checked="selected.has(l.key)" @change="toggleLeaf(l)" />
                      <span class="label">{{ l.variantName }}</span>
                      <span class="sku">{{ l.sku }}</span>
                    </label>
                    <input v-if="selected.has(l.key)" v-model.number="qty[l.key]" type="number" min="1" inputmode="numeric" class="qty" aria-label="Copies" />
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      </article>

      <article class="card">
        <h2>Label size</h2>
        <div class="two">
          <label class="field"><span>Width (mm)</span><input v-model.number="labelSize.widthMm" type="number" min="10" max="43" inputmode="numeric" /></label>
          <label class="field"><span>Height (mm)</span><input v-model.number="labelSize.heightMm" type="number" min="10" max="200" inputmode="numeric" /></label>
        </div>
        <p class="hint">Print head is fixed at 43mm wide - width above that is clamped. Match this to the label roll actually loaded.</p>

        <h2>Print settings</h2>
        <div class="two">
          <label class="field"><span>Speed (1-5)</span><input v-model.number="speed" type="number" min="1" max="5" inputmode="numeric" /></label>
          <label class="field"><span>Density (1-15)</span><input v-model.number="density" type="number" min="1" max="15" inputmode="numeric" /></label>
        </div>
        <label class="field">
          <span>Batch pacing</span>
          <select v-model="printMode">
            <option value="continuous">Continuous - fixed delay, fastest</option>
            <option value="safe">Safe - waits on printer feedback when available</option>
          </select>
        </label>
        <p class="hint">Safe paces off the printer's own notifications between labels instead of a fixed guess - try it if batches come out ghosted or misaligned.</p>
        <p class="hint">Not verified against real hardware - adjust if prints come out too light, dark, or fast to feed cleanly.</p>

        <label class="field">
          <span>Title size ({{ Math.round(titleScale * 100) }}%)</span>
          <input v-model.number="titleScale" type="range" min="0.5" max="1.5" step="0.05" />
        </label>

        <label class="field inline">
          <input v-model="showSkuText" type="checkbox" />
          <span>Print SKU number under the barcode</span>
        </label>

        <h2>Preview</h2>
        <label class="field inline">
          <input v-model="showTestPreview" type="checkbox" />
          <span>Show a test label instead</span>
        </label>
        <p v-if="!previewLeaf" class="empty">Pick a product to preview its label.</p>
        <div v-else class="preview"><canvas ref="previewCanvas"></canvas></div>

        <h2>Export</h2>
        <p class="hint">Printer trouble? Export the selected labels as PNG images instead - pixel-for-pixel what would print, importable into another app's own "custom label from picture" feature (e.g. LabelLife) to print through its own connection.</p>
        <button type="button" class="quiet" :disabled="!chosen.length || exporting" @click="exportPngs">
          {{ exporting ? `Exporting ${exportProgress?.done ?? 0} / ${exportProgress?.total ?? 0}…` : `Export ${chosen.length} image${chosen.length === 1 ? '' : 's'}` }}
        </button>

        <h2>Printer</h2>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div class="row printer-row">
          <template v-if="!printerName">
            <button type="button" class="primary full" :disabled="!bluetoothSupported" @click="connect">Connect Phomemo M110</button>
          </template>
          <template v-else>
            <span class="ok">Connected: {{ printerName }}</span>
            <button type="button" class="quiet" @click="disconnect">Disconnect</button>
          </template>
        </div>
        <div class="row printer-row">
          <button type="button" class="primary" :disabled="!printerName || !chosen.length || busy" @click="printAll">
            {{ busy ? `Printing ${progress?.done ?? 0} / ${progress?.total ?? 0}…` : `Print ${totalLabels} label${totalLabels === 1 ? '' : 's'}` }}
          </button>
          <button type="button" class="quiet" v-if="busy" :disabled="cancelRequested" @click="cancelPrint">
            {{ cancelRequested ? 'Stopping…' : 'Cancel' }}
          </button>
          <button type="button" class="quiet" :disabled="!printerName || busy" @click="printTestLabel">Print test label</button>
        </div>

        <template v-if="printerName">
          <button type="button" class="quiet" @click="showDeviceInfo">Show device info</button>
          <p class="hint">Nothing prints? This lists what GATT services this exact device has - if 0xff00 isn't in there, this driver's assumptions don't match your unit's firmware.</p>
          <pre v-if="deviceInfo" class="device-info">{{ deviceInfo }}</pre>
        </template>
      </article>
    </div>
  </section>
</template>

<style scoped>
.labels { display: flex; flex-direction: column; gap: 1rem; max-width: 64rem; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: .95rem; }
.warn { color: var(--zfy-warning-ink, #8a5a1e); margin: 0; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.ok { color: var(--zfy-accent-ink, #0a5a4a); font-size: .9rem; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.grid { display: grid; grid-template-columns: minmax(20rem, 2fr) minmax(16rem, 1fr); gap: 1rem; align-items: start; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .9rem 1rem; display: flex; flex-direction: column; gap: .6rem; }
.products { max-height: 40rem; }

.quick { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.quick .count { margin-left: auto; font-size: .8rem; color: var(--zfy-muted, #5a6472); }

.tree { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .2rem; overflow: auto; }
.type-row { border-top: 1px solid var(--zfy-line, #d6dde4); padding-top: .3rem; }
.type-row:first-child { border-top: none; padding-top: 0; }
.row { display: flex; flex-direction: row; align-items: center; gap: .5rem; min-height: 2.3rem; }
.row.group { font-weight: 600; font-size: .9rem; cursor: pointer; }
.row.product { padding-left: .1rem; }
.products-in-type { list-style: none; margin: 0; padding: 0 0 0 .2rem; }
.variants { list-style: none; margin: 0; padding: 0 0 .3rem 1.9rem; display: flex; flex-direction: column; }
/* `.pick`/`.row.group` are <label> elements - flex-direction is set explicitly
   here so the generic `.field` (column) layout below can never leak into them. */
.pick { display: flex; flex-direction: row; align-items: baseline; gap: .6rem; flex: 1; min-width: 0; font-size: .9rem; cursor: pointer; }
.pick .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick .sku { color: var(--zfy-ink, #1a2230); font-family: ui-monospace, monospace; font-size: .9rem; font-weight: 600; white-space: nowrap; }
.pick .sub { color: var(--zfy-muted, #5a6472); font-size: .8rem; white-space: nowrap; }
.qty { width: 3.5rem; flex: none; }
.chevron { background: transparent; border: 1px solid var(--zfy-line, #d6dde4); color: var(--zfy-muted, #5a6472); line-height: 1; padding: .15rem .35rem; border-radius: 6px; flex: none; }
.chevron > * { display: inline-block; transition: transform .15s ease; }
.chevron.open > * { transform: rotate(90deg); }
.chevron-spacer { width: 1.6rem; display: inline-block; flex: none; }

.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.field { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.field > span { font-size: .78rem; color: var(--zfy-muted, #5a6472); }
.field.inline { flex-direction: row; align-items: center; gap: .5rem; cursor: pointer; }
.field.inline > span { font-size: .875rem; color: inherit; }
.preview { display: flex; justify-content: center; padding: .5rem; background: var(--zfy-bg, #f1f4f6); border-radius: 8px; }
.preview canvas { image-rendering: pixelated; max-width: 100%; border: 1px solid var(--zfy-line, #d6dde4); }
.printer-row { display: flex; align-items: center; gap: .6rem; }
.printer-row .full { flex: 1; width: 100%; }
.device-info { margin: 0; padding: .6rem .7rem; background: var(--zfy-bg, #f1f4f6); border-radius: 8px; font-size: .78rem; white-space: pre-wrap; word-break: break-word; max-height: 14rem; overflow: auto; }

/* The grid's column minimums (20rem + 16rem + gap) never fit a phone width,
   so the columns overflowed the viewport instead of shrinking - confirmed
   from a phone screenshot showing the product list bleeding off the left
   edge and the settings card floating over it rather than stacking below. */
@media (max-width: 640px) {
  /* A 1fr track still won't shrink below its content's intrinsic min-width
     by default (grid items get an implicit min-width:auto) - confirmed
     live, the card was 425px wide forcing horizontal scroll on a 375px
     phone even after this collapsed to one column, because the SKU column's
     nowrap text set that minimum. min-width:0 here is what actually lets it
     shrink to the viewport; ellipsis further down still keeps SKUs legible. */
  .grid, .grid > .card { min-width: 0; }
  .grid { grid-template-columns: 1fr; }
  .products { max-height: none; }
}
</style>
