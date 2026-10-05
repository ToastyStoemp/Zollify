<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import JsBarcode from 'jsbarcode';
import { saveFile } from '@zollify/platform';
import { Icon } from '@zollify/ui';

/**
 * A staff badge: name, shop and a Code 128 barcode, at credit-card size.
 * Any handheld scanner reads Code 128, and so does a phone camera. Printed
 * on its own page so it can go straight onto card stock or a lanyard.
 */
const props = defineProps<{ code: string; name: string; accountName: string }>();

const svg = ref<SVGSVGElement | null>(null);
function draw(): void {
  if (!svg.value) return;
  JsBarcode(svg.value, props.code, { format: 'CODE128', displayValue: false, margin: 0, width: 2, height: 56, background: '#ffffff', lineColor: '#000000' });
}
onMounted(draw);
watch(() => props.code, draw);

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The badge as a standalone page: fixed colours, no app styles, one card per page. */
function page(): string {
  const bars = svg.value?.outerHTML ?? '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Badge - ${esc(props.name)}</title><style>
@page { size: 85.6mm 54mm; margin: 0; }
html, body { margin: 0; background: #fff; color: #000; font-family: system-ui, sans-serif; }
.card { box-sizing: border-box; width: 85.6mm; height: 54mm; padding: 4mm 5mm; display: flex; flex-direction: column; gap: 1.5mm; }
.shop { font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; color: #444; }
.name { font-size: 15pt; font-weight: 700; text-transform: capitalize; }
.bars { flex: 1; display: flex; align-items: flex-end; }
.bars svg { width: 100%; height: 16mm; }
.code { font: 7pt ui-monospace, monospace; color: #444; }
</style></head><body><div class="card"><div class="shop">${esc(props.accountName)}</div><div class="name">${esc(props.name)}</div><div class="bars">${bars}</div><div class="code">Staff badge - scan to unlock the till</div></div></body></html>`;
}

function print(): void {
  const w = window.open('', '_blank', 'width=480,height=360');
  if (!w) return void download();
  w.document.write(page());
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 250);
}
async function download(): Promise<void> {
  await saveFile(`badge-${props.name.replace(/[^\w-]+/g, '-').toLowerCase()}.html`, page(), 'text/html');
}
</script>

<template>
  <div class="badge">
    <div class="card" aria-label="Staff badge preview">
      <span class="shop">{{ accountName }}</span>
      <strong class="name">{{ name }}</strong>
      <svg ref="svg" class="bars" role="img" :aria-label="`Barcode for ${name}`" />
      <small>Staff badge - scan to unlock the till</small>
    </div>
    <div class="actions">
      <button type="button" class="primary" @click="print"><Icon name="printer" :size="14" /> Print</button>
      <button type="button" @click="download"><Icon name="download" :size="14" /> Save</button>
    </div>
  </div>
</template>

<style scoped>
.badge { display: flex; flex-direction: column; gap: .7rem; align-items: center; }
.card { width: min(100%, 21rem); aspect-ratio: 85.6 / 54; box-sizing: border-box; padding: .9rem 1.1rem; border-radius: 12px; background: #fff; color: #000; border: 1px solid var(--zfy-line, #d6dde4); display: flex; flex-direction: column; gap: .3rem; box-shadow: 0 2px 8px var(--zfy-shadow, rgba(20, 26, 34, .12)); }
.shop { font-size: .66rem; letter-spacing: .08em; text-transform: uppercase; color: #444; }
.name { font-size: 1.15rem; text-transform: capitalize; }
.bars { width: 100%; height: 3.6rem; margin-top: auto; }
small { font-size: .62rem; color: #444; }
.actions { display: flex; gap: .5rem; }
.actions button { display: inline-flex; align-items: center; gap: .35rem; }
</style>
