<script setup lang="ts">
import { computed, ref } from 'vue';
import { catalogueCards, fmtPrice, unitPriceFor, type CatalogueRow, type TradeCustomer, type TradeDetails } from '@zollify/shared';
import { htmlToPdf } from '@zollify/ui';
import { sdk } from '../runtime';

/**
 * The catalogue to hand out: every product offered to the trade, with its
 * photo, the words from its trade details and the tiers - or a customer's
 * own prices. Built here from the catalogue and the photos on this device,
 * as a PDF or a page to print. A variant that is an item of its own (the
 * zodiac chicken of a keychain) gets its own card; sizes of one item (A4,
 * A3) are rows on its card, each at its own price - see catalogueCards.
 */
const props = defineProps<{ details: Record<string, TradeDetails>; customers: TradeCustomer[] }>();

const currency = computed(() => sdk().account()?.profile.defaultCurrency ?? 'EUR');
const all = computed(() => sdk().data.products.forSale().filter((p) => props.details[p.id]?.enabled !== false));
const types = computed(() => [...new Set(all.value.map((p) => p.type || 'Other'))].sort());
const pickedTypes = ref<Set<string>>(new Set());
const customerId = ref('');
const withPhotos = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const toggleType = (t: string): void => {
  const next = new Set(pickedTypes.value);
  if (next.has(t)) next.delete(t);
  else next.add(t);
  pickedTypes.value = next;
};
const chosen = computed(() => all.value.filter((p) => !pickedTypes.value.size || pickedTypes.value.has(p.type || 'Other')).sort((a, b) => (a.type || 'Other').localeCompare(b.type || 'Other') || a.title.localeCompare(b.title)));
const customer = computed(() => props.customers.find((c) => c.id === customerId.value));
/** Cards in the catalogue: a variant that is an item of its own counts as one. */
const items = computed(() => chosen.value.reduce((n, p) => n + catalogueCards(p, props.details[p.id]).length, 0));
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * A photo written into the page itself. The catalogue opens in another
 * window, the Android viewer or the PDF renderer, none of which can reach
 * this device's object URLs - so they showed nothing. The full photo where
 * this device has it (thumbnails are too soft to print), else the thumbnail.
 */
async function photo(imageId: string | undefined, cache: Map<string, string | null>): Promise<string | null> {
  if (!imageId) return null;
  if (cache.has(imageId)) return cache.get(imageId)!;
  let data: string | null = null;
  try {
    const url = (await sdk().data.images.url(imageId, 'full')) ?? (await sdk().data.images.url(imageId, 'thumb'));
    if (url) {
      const blob = await (await fetch(url)).blob();
      data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }
  } catch {
    data = null;
  }
  cache.set(imageId, data);
  return data;
}

/** The price table: a column per quantity tier, a row per size when there are several. */
function priceTable(rows: CatalogueRow[], moq: number, discount: number, cur: string): string {
  const steps = [...new Set(rows.flatMap((r) => r.tiers.map((t) => t.minQty)))].sort((a, b) => a - b);
  const qtys = steps.length ? steps : [moq];
  const named = rows.length > 1 || rows.some((r) => r.label);
  const head = `<tr>${named ? '<th></th>' : ''}${qtys.map((q) => `<th class="n">${q}+</th>`).join('')}</tr>`;
  const body = rows
    .map((r) => `<tr>${named ? `<td>${esc(r.label)}${r.sku ? ` <span class="meta">${esc(r.sku)}</span>` : ''}</td>` : ''}${qtys.map((q) => `<td class="n">${esc(fmtPrice(unitPriceFor(r.tiers, q, r.listPrice, discount), cur))}</td>`).join('')}</tr>`)
    .join('');
  return `<table>${head}${body}</table>`;
}

async function html(): Promise<string> {
  const shop = sdk().account()?.accountName ?? '';
  const cur = customer.value?.currency ?? currency.value;
  const disc = customer.value?.discountPct ?? 0;
  const cards: string[] = [];
  const photos = new Map<string, string | null>();
  for (const p of chosen.value) {
    const d = props.details[p.id];
    for (const card of catalogueCards(p, d)) {
      const img = withPhotos.value ? await photo(card.imageId, photos) : null;
      const sku = card.rows.length > 1 || card.rows[0]?.label ? p.sku : card.sku;
      cards.push(`<article class="card"><div class="photo">${img ? `<img src="${img}" alt="">` : ''}</div><div class="body"><h3>${esc(card.title)}</h3>
      <p class="meta">${esc([sku, p.type].filter(Boolean).join(' · '))}</p>
      ${d?.description ? `<p>${esc(d.description)}</p>` : ''}
      <p class="meta">${esc([d?.materials || p.material, d?.dimensions, p.weightG ? `${p.weightG} g` : ''].filter(Boolean).join(' · '))}</p>
      ${priceTable(card.rows, d?.moq ?? 1, disc, cur)}
      <p class="meta">${esc([d && d.moq > 1 ? `min ${d.moq}` : '', d && d.packSize > 1 ? `packs of ${d.packSize}` : '', d?.leadDays ? `${d.leadDays} working days` : 'from stock'].filter(Boolean).join(' · '))}</p></div></article>`);
    }
  }
  const profile = sdk().account()?.profile.artist;
  const contact = [profile?.companyName || profile?.fullName, profile?.email, profile?.phone].filter(Boolean).map((s) => esc(String(s))).join(' · ');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(shop)} wholesale</title><style>
  body{font-family:system-ui,sans-serif;color:#111;margin:0;padding:10mm}h1{font-size:20pt;margin:0}h2{font-size:10pt;color:#555;margin:0 0 6mm;font-weight:400}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5mm}.card{border:1px solid #ccc;border-radius:6px;overflow:hidden;break-inside:avoid;page-break-inside:avoid;display:flex;flex-direction:column}
  .photo{width:100%;aspect-ratio:1;background:#f2f2f2;display:flex;align-items:center;justify-content:center;overflow:hidden}.photo img{max-width:100%;max-height:100%;display:block}.body{padding:3mm;display:flex;flex-direction:column;gap:1.5mm}h3{margin:0;font-size:11pt}p{margin:0;font-size:8.5pt}.meta{color:#555;font-size:8pt}
  table{border-collapse:collapse;font-size:9pt;margin-top:1mm}td,th{padding:.5mm 2mm .5mm 0;text-align:left}th{font-weight:400;color:#555;font-size:8pt}td.n{text-align:right;font-weight:700}th.n{text-align:right}
  </style></head><body><h1>${esc(shop)} · wholesale${customer.value ? ` · prices for ${esc(customer.value.company)}` : ''}</h1><h2>${contact}${contact ? ' · ' : ''}${new Date().toLocaleDateString()}${customer.value?.terms ? ` · ${esc(customer.value.terms)}` : ''}</h2><div class="grid">${cards.join('')}</div></body></html>`;
}
async function open(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    if (!(await sdk().ui.openDocument('wholesale-catalogue.html', await html(), 'text/html'))) sdk().ui.toast('The window was blocked - allow pop-ups for this site.', { kind: 'warning' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not build the catalogue.';
  } finally {
    busy.value = false;
  }
}
async function pdf(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const blob = await htmlToPdf(await html());
    await sdk().ui.saveFile(`wholesale-catalogue${customer.value ? `-${customer.value.company.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : ''}.pdf`, blob, 'application/pdf');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not build the PDF.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="catalogue">
    <p class="hint">Every product offered to the trade, with its photo from this device, the trade description and the tiers. Pick types to narrow it, or a customer to print their own prices.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="chips" role="group" aria-label="Types">
      <button v-for="t in types" :key="t" type="button" class="chip" :class="{ on: pickedTypes.has(t) }" @click="toggleType(t)">{{ t }}</button>
    </div>
    <div class="bar">
      <label>Prices for <select v-model="customerId"><option value="">everyone (tier prices)</option><option v-for="c in customers.filter((x) => !x.archived)" :key="c.id" :value="c.id">{{ c.company }}{{ c.discountPct ? ` (${c.discountPct}% off)` : '' }}</option></select></label>
      <label class="check"><input v-model="withPhotos" type="checkbox" /> With photos</label>
    </div>
    <p class="hint">{{ items }} item{{ items === 1 ? '' : 's' }}{{ items !== chosen.length ? ` from ${chosen.length} product${chosen.length === 1 ? '' : 's'}` : '' }}.</p>
    <div class="actions">
      <button type="button" class="primary" :disabled="busy || !chosen.length" @click="pdf">Save as PDF</button>
      <button type="button" :disabled="busy || !chosen.length" @click="open">Open to print</button>
    </div>
  </div>
</template>

<style scoped>
.catalogue { display: flex; flex-direction: column; gap: .7rem; }
.hint { color: var(--zfy-muted, #5a6472); font-size: .84rem; margin: 0; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.chips { display: flex; gap: .3rem; flex-wrap: wrap; }
.chip { font-size: .78rem; padding: .2rem .6rem; border-radius: 999px; min-height: 0; }
.chip.on { background: var(--zfy-accent, #0e7c66); color: #fff; }
.bar { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .875rem; }
label.check { flex-direction: row; align-items: center; gap: .4rem; }
.actions { display: flex; gap: .5rem; flex-wrap: wrap; }
</style>
