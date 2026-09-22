<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { EventStock, SalesEvent } from '@zollify/shared';
import { htmlToPdf } from '@zollify/ui';
import { buildCustomsDeState, readCustomsDeBlob } from '../engine/adapter';
import { calcDeProduct, fmtWeightKg } from '../engine/calc';
import { buildPackingListHtml, type PackingListFormat } from '../engine/packing-list';
import { buildProformaHtml } from '../engine/proforma';
import { buildIaaPlusSheetData, buildIaaPlusSheetHtml } from '../engine/iaa-plus-sheet';
import { buildDexpdfXml } from '../engine/dexpdf-xml';
import { defaultCustomsDeDeclarant, type CustomsDeDeclarant } from '../engine/model';
import { DECLARANT_KEY, type StoredDeclarant } from './declarant';
import { sdk } from '../runtime';

/**
 * One event's German-side paperwork. Everything typed here is saved into
 * `event.customsDe`, kept apart from the Swiss `event.customs` blob so
 * installing or removing either module never touches the other's data.
 */

const route = useRoute();
const eventId = computed(() => String(route.params.eventId ?? ''));
const event = computed(() => sdk().data.events.get(eventId.value) ?? null);
const error = ref<string | null>(null);

const declarant = ref<CustomsDeDeclarant>(defaultCustomsDeDeclarant());
const precheckOffice = ref('');
const eori = ref('');
const exportMrn = ref('');
const destinationCountry = ref('');
const transportMode = ref('3 - Road');
const vehicleReg = ref('');
const totalPackages = ref(1);
const referenceNumber = ref('');
const transportNationality = ref('DE');
const exitOffice = ref('');
const placeOfDeclaration = ref('');
const incoterms = ref('');
const stock = ref<EventStock[]>([]);
let loadedEventId: string | null = null;
let loading = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function stripEmpty<T extends object>(obj: Partial<T> | undefined): Partial<T> {
  if (!obj) return {};
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v != null)) as Partial<T>;
}

async function load(ev: SalesEvent): Promise<void> {
  loading = true;
  loadedEventId = ev.id;
  const blob = readCustomsDeBlob(ev);
  const stored = await sdk().config.get<Partial<StoredDeclarant>>(DECLARANT_KEY);
  // Layered, most specific last: booth profile, the module's saved declarant, this event's own record.
  declarant.value = {
    ...defaultCustomsDeDeclarant(),
    ...stripEmpty<CustomsDeDeclarant>(sdk().account()?.profile.artist),
    ...stripEmpty<CustomsDeDeclarant>(stored ?? undefined),
    ...stripEmpty<CustomsDeDeclarant>(blob.declarant),
  };
  // EORI and the precheck office belong to the company, not the event - the event can still override.
  // `||`, not `??`: an event that autosaved these blank (every save writes every field) must
  // still fall through to the settings/profile default, not get stuck on its own empty string.
  precheckOffice.value = blob.meta?.precheckOffice || stored?.precheckOffice || '';
  eori.value = blob.meta?.eori || stored?.eori || sdk().account()?.profile.artist.eori || '';
  exportMrn.value = blob.meta?.exportMrn ?? '';
  destinationCountry.value = blob.meta?.destinationCountry || ev.venue?.country || '';
  transportMode.value = blob.meta?.transportMode ?? '3 - Road';
  vehicleReg.value = blob.meta?.vehicleReg ?? '';
  totalPackages.value = blob.meta?.totalPackages ?? 1;
  referenceNumber.value = blob.meta?.referenceNumber ?? '';
  transportNationality.value = blob.meta?.transportNationality ?? 'DE';
  exitOffice.value = blob.meta?.exitOffice ?? '';
  placeOfDeclaration.value = blob.meta?.placeOfDeclaration ?? '';
  incoterms.value = blob.meta?.incoterms ?? '';
  stock.value = await sdk().data.events.stock(ev.id);
  setTimeout(() => (loading = false));
}

watch(event, (ev) => { if (ev && ev.id !== loadedEventId) void load(ev); }, { immediate: true });
onMounted(() => { if (event.value && event.value.id !== loadedEventId) void load(event.value); });
onUnmounted(() => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    void save();
  }
});

function scheduleSave(): void {
  if (loading || !event.value) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
}
async function save(): Promise<void> {
  const ev = event.value;
  if (!ev) return;
  saveTimer = undefined;
  const blob = readCustomsDeBlob(ev);
  try {
    await sdk().data.events.upsert({
      ...ev,
      customsDe: {
        ...ev.customsDe,
        declarant: { ...declarant.value },
        meta: {
          ...blob.meta,
          precheckOffice: precheckOffice.value,
          eori: eori.value,
          exportMrn: exportMrn.value,
          destinationCountry: destinationCountry.value,
          transportMode: transportMode.value,
          vehicleReg: vehicleReg.value,
          totalPackages: totalPackages.value,
          referenceNumber: referenceNumber.value,
          transportNationality: transportNationality.value,
          exitOffice: exitOffice.value,
          placeOfDeclaration: placeOfDeclaration.value,
          incoterms: incoterms.value,
        },
      },
      updatedAt: Date.now(),
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the customs details.';
  }
}
watch(
  [declarant, precheckOffice, eori, exportMrn, destinationCountry, transportMode, vehicleReg, totalPackages, referenceNumber, transportNationality, exitOffice, placeOfDeclaration, incoterms],
  scheduleSave,
  { deep: true },
);

const state = computed(() => {
  const ev = event.value;
  if (!ev) return null;
  const withEdits: SalesEvent = {
    ...ev,
    customsDe: {
      declarant: declarant.value,
      meta: {
        precheckOffice: precheckOffice.value,
        eori: eori.value,
        exportMrn: exportMrn.value,
        destinationCountry: destinationCountry.value,
        transportMode: transportMode.value,
        vehicleReg: vehicleReg.value,
        totalPackages: totalPackages.value,
        referenceNumber: referenceNumber.value,
        transportNationality: transportNationality.value,
        exitOffice: exitOffice.value,
        placeOfDeclaration: placeOfDeclaration.value,
        incoterms: incoterms.value,
      },
    },
  };
  const api = sdk().data;
  return buildCustomsDeState(withEdits, api.products.list(), stock.value, api.transactions.recent());
});

const broughtUnits = computed(() => state.value?.products.reduce((n, p) => n + p.amount, 0) ?? 0);
const reimportTotals = computed(() => {
  const products = state.value?.products ?? [];
  let qty = 0, weightKg = 0, value = 0;
  for (const p of products) {
    const c = calcDeProduct(p);
    qty += c.reimportQty;
    weightKg += c.reimportWeightKg;
    value += c.reimportValue ?? 0;
  }
  return { qty, weightKg, value };
});

const safeName = (suffix: string): string => `${(event.value?.name || 'event').replace(/[^\w-]+/g, '_')}_${suffix}`;
/** Inline fallback for when the browser blocks the new-tab popup - same behaviour as the CH module. */
const preview = ref('');
/**
 * "Save as PDF" generates a real PDF client-side instead of relying on the
 * browser's print dialog, which has no equivalent in the Android app's
 * Capacitor WebView (window.print() is a no-op there) - see htmlToPdf() in
 * @zollify/ui for the mechanism, shared with the Swiss customs module.
 */
const saveAsPdf = ref(false);
const pdfBusy = ref(false);
async function openHtml(source: string, name: string): Promise<void> {
  if (saveAsPdf.value) {
    pdfBusy.value = true;
    error.value = null;
    try {
      const pdf = await htmlToPdf(source);
      await sdk().ui.saveFile(`${name}.pdf`, pdf, 'application/pdf');
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Could not generate the PDF.';
    } finally {
      pdfBusy.value = false;
    }
    return;
  }
  const opened = await sdk().ui.openDocument(`${name}.html`, source);
  preview.value = opened ? '' : source;
}
async function openXml(source: string, name: string): Promise<void> {
  const opened = await sdk().ui.openDocument(`${name}.xml`, source, 'application/xml');
  if (!opened) await sdk().ui.saveFile(`${name}.xml`, source, 'application/xml');
}
const packingFormat = ref<PackingListFormat>('detailed');
const hasVariantProducts = computed(() => state.value?.products.some((p) => !p.unlisted && (p.variants?.length ?? 0) > 0) ?? false);
const packingFormatOptions = computed<{ value: PackingListFormat; label: string }[]>(() =>
  hasVariantProducts.value
    ? [
        { value: 'detailed', label: 'Detailed' },
        { value: 'compressed', label: 'Compressed' },
        { value: 'bytype', label: 'By type' },
      ]
    : [
        { value: 'detailed', label: 'Per product' },
        { value: 'bytype', label: 'By type' },
      ],
);
watch(hasVariantProducts, (has) => {
  if (!has && packingFormat.value === 'compressed') packingFormat.value = 'detailed';
});

const openExportList = () => state.value && openHtml(buildPackingListHtml(state.value, 'export', packingFormat.value), safeName('de_export'));
const openReimportList = () => state.value && openHtml(buildPackingListHtml(state.value, 'reimport', packingFormat.value), safeName('de_reimport'));
const openProforma = () => state.value && openHtml(buildProformaHtml(state.value), safeName('de_proforma'));
const printIaaPlusSheet = () => state.value && openHtml(buildIaaPlusSheetHtml(state.value), safeName('iaa_plus'));

const sheetOpen = ref(false);
const filingOpen = ref(false);
const sheet = computed(() => (state.value ? buildIaaPlusSheetData(state.value) : null));
const dexpdf = computed(() => (state.value ? buildDexpdfXml(state.value) : null));
const openDexpdfXml = () => dexpdf.value && openXml(dexpdf.value.xml, safeName('dexpdf'));
</script>

<template>
  <section class="customs">
    <header class="bar">
      <router-link :to="{ name: 'customs-de:index' }" class="back">← Customs (Germany)</router-link>
      <h1>{{ event?.name ?? 'Customs (Germany) documents' }}</h1>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!event" class="empty">Event not found - open this from an event card under Events.</p>

    <template v-else>
      <article class="card notice">
        <p>
          This module prepares paperwork for your declarant or customs broker to file with ATLAS - it does not
          submit an ATLAS export or re-import message itself. Nobody on this team has verified ATLAS test access
          yet, so treat the checklist below as a starting point and confirm the actual filing steps with your broker.
        </p>
      </article>

      <article class="card">
        <h2>Declaration details</h2>
        <div class="grid">
          <label><span>Precheck office</span><input v-model="precheckOffice" type="text" placeholder="Hauptzollamt Berlin" /></label>
          <label><span>EORI number</span><input v-model="eori" type="text" class="mono" /></label>
          <label><span>Export MRN</span><input v-model="exportMrn" type="text" class="mono" placeholder="filled in after precheck" /></label>
          <label><span>Destination country</span><input v-model="destinationCountry" type="text" placeholder="Switzerland" /></label>
          <label><span>Transport mode</span><input v-model="transportMode" type="text" placeholder="3 - Road" /></label>
          <label><span>Vehicle registration</span><input v-model="vehicleReg" type="text" /></label>
          <label><span>Vehicle nationality</span><input v-model="transportNationality" type="text" placeholder="DE" /></label>
          <label><span>Total packages</span><input v-model.number="totalPackages" type="number" min="1" inputmode="numeric" /></label>
          <label><span>Office of exit</span><input v-model="exitOffice" type="text" placeholder="border crossing, if different from precheck" /></label>
          <label><span>Place of declaration</span><input v-model="placeOfDeclaration" type="text" placeholder="Berlin" /></label>
          <label><span>Your reference (optional)</span><input v-model="referenceNumber" type="text" /></label>
          <label><span>Delivery term (Incoterms)</span><input v-model="incoterms" type="text" placeholder="EXW Berlin" /></label>
        </div>
        <p class="hint">Delivery term is only shown on the proforma invoice - your broker's mail asks for it stated on the invoice.</p>
      </article>

      <article class="card">
        <h2>Declarant</h2>
        <div class="grid">
          <label><span>Company name</span><input v-model="declarant.companyName" type="text" /></label>
          <label><span>Full name</span><input v-model="declarant.fullName" type="text" /></label>
          <label><span>Street &amp; house number</span><input v-model="declarant.street" type="text" /></label>
          <label><span>Postcode &amp; city</span><input v-model="declarant.postCodeCity" type="text" placeholder="10115 Berlin" /></label>
          <label><span>Country</span><input v-model="declarant.countryOfOrigin" type="text" /></label>
          <label><span>Phone</span><input v-model="declarant.phone" type="tel" /></label>
          <label><span>Email</span><input v-model="declarant.email" type="email" /></label>
          <label><span>VAT / tax ID</span><input v-model="declarant.vatId" type="text" class="mono" placeholder="DE123456789" /></label>
        </div>
        <p class="hint">Prefilled from the booth profile and the declarant under Settings; what you change here applies to this event only.</p>
        <p class="hint">VAT/tax ID is only shown on the proforma invoice - required by German export brokers as a seller identifier, distinct from the EORI.</p>
      </article>

      <article class="card">
        <h2>Goods</h2>
        <p class="hint">
          {{ broughtUnits }} units claimed for export · {{ reimportTotals.qty }} unsold, expected back
          ({{ fmtWeightKg(reimportTotals.weightKg) }}, {{ Math.floor(reimportTotals.value) }} {{ event.currency }}).
        </p>
      </article>

      <article class="card sheet" v-if="sheet">
        <div class="sheet-head">
          <h2>IAA-Plus filing sheet</h2>
          <div class="docs">
            <button type="button" class="ghost" :disabled="pdfBusy" @click="printIaaPlusSheet">Print / save copy</button>
            <button type="button" class="chevron" :class="{ open: sheetOpen }" @click="sheetOpen = !sheetOpen" aria-label="Toggle IAA-Plus filing sheet"><span>▸</span></button>
          </div>
        </div>
        <template v-if="sheetOpen">
          <p class="hint">Box numbers match the standard EU export declaration (SAD) fields IAA-Plus is built on. Copy each value into the field carrying the same box number on the live form.</p>

          <table class="boxes">
            <tbody>
              <tr v-for="b in sheet.boxes" :key="b.no" :class="{ missing: !b.lines.length }">
                <td class="no">{{ b.no }}</td>
                <td class="label">{{ b.label }}</td>
                <td>
                  <template v-if="b.lines.length">
                    <span v-for="(line, i) in b.lines" :key="i">{{ line }}<br v-if="i < b.lines.length - 1" /></span>
                  </template>
                  <em v-else>missing</em>
                </td>
              </tr>
            </tbody>
          </table>

          <table class="goods-table">
            <thead>
              <tr>
                <th class="r">32 · Item</th>
                <th>31 · Description</th>
                <th>33 · Commodity code</th>
                <th>34a · Origin</th>
                <th class="r">35 · Gross mass</th>
                <th class="r">38 · Net mass</th>
                <th class="r">46 · Value ({{ sheet.currency }})</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!sheet.goods.length"><td colspan="7" class="empty-row">Nothing claimed for this event</td></tr>
              <tr v-for="g in sheet.goods" :key="g.no">
                <td class="r">{{ g.no }}</td>
                <td>{{ g.title }}</td>
                <td>{{ g.tariffNo }}</td>
                <td>{{ g.origin }}</td>
                <td class="r">{{ fmtWeightKg(g.grossKg) }}</td>
                <td class="r">{{ fmtWeightKg(g.netKg) }}</td>
                <td class="r">{{ g.value != null ? g.value : '-' }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="4" class="r">TOTALS</td>
                <td class="r">{{ fmtWeightKg(sheet.totals.weightKg) }}</td>
                <td class="r">{{ fmtWeightKg(sheet.totals.weightKg) }}</td>
                <td class="r">{{ Math.floor(sheet.totals.value) }}</td>
              </tr>
            </tfoot>
          </table>

          <p class="hint">Box 37 (Procedure/CPC) is left off this sheet on purpose - ask your Hauptzollamt or broker for the correct code; it's the one field here with real legal weight and no safe default.</p>
          <p class="hint">{{ sheet.massNote }}</p>
        </template>
      </article>

      <article class="card">
        <div class="sheet-head">
          <h2>Filing at IAA-Plus - two ways</h2>
          <button type="button" class="chevron" :class="{ open: filingOpen }" @click="filingOpen = !filingOpen" aria-label="Toggle filing instructions"><span>▸</span></button>
        </div>
        <template v-if="filingOpen">
          <p class="hint">Either fill the web form by hand using the filing sheet above, or upload the XML file directly. Both end at the same place: a precheck MRN.</p>

          <h3>Option A - manual entry</h3>
          <ol class="checklist">
            <li>Open the export packing list above, then work through the filing sheet above, copying each box into IAA-Plus.</li>
            <li>File at <a href="https://www.zoll.de" target="_blank" rel="noopener">zoll.de → ATLAS-Ausfuhr Internet (IAA-Plus)</a>, copying each box from the filing sheet - it shows the box number next to each field.</li>
            <li>Precheck the export at {{ precheckOffice || 'your local Hauptzollamt' }} before leaving Germany. IAA-Plus gives you the MRN and accompanying document on acceptance - record the MRN above.</li>
          </ol>

          <h3>Option B - XML upload</h3>
          <ol class="checklist">
            <li>Download the DEXPDF XML below.</li>
            <li>In IAA-Plus, left tree → Ausfuhrzollstelle → Ausfuhranmeldung → "... AM in die IAA-Plus laden", then upload the file.</li>
            <li>IAA-Plus loads every box from the file - check them against the filing sheet, fix anything flagged below, then submit the same way as option A.</li>
          </ol>
          <div class="docs">
            <button type="button" @click="openDexpdfXml">Download DEXPDF XML</button>
          </div>
          <ul v-if="dexpdf && dexpdf.warnings.length" class="warnings">
            <li v-for="(w, i) in dexpdf.warnings" :key="i">{{ w }}</li>
          </ul>
          <p class="hint">
            Not verified against a live ATLAS test environment - the file is schema-correct, not filing-confirmed.
            Check every warning above before uploading.
          </p>

          <h3>Both options</h3>
          <ol class="checklist" start="4">
            <li>Open ZAVV in Switzerland with the Swiss import list (Customs (Switzerland) module).</li>
            <li>Sell at the event; unsold stock is tracked automatically above.</li>
            <li>File the Swiss e-dec definitive import for what sold, and close ZAVV.</li>
            <li>Re-import the unsold goods into Germany, referencing the export MRN, using the re-import packing list above.</li>
          </ol>
        </template>
      </article>

      <article class="card">
        <h2>Documents</h2>
        <div class="fmt">
          <span class="hint">Packing list format</span>
          <div class="seg">
            <button v-for="o in packingFormatOptions" :key="o.value" type="button" :class="{ on: packingFormat === o.value }" @click="packingFormat = o.value">{{ o.label }}</button>
          </div>
        </div>
        <div class="fmt">
          <span class="hint">On open</span>
          <div class="seg">
            <button type="button" :class="{ on: !saveAsPdf }" @click="saveAsPdf = false">View</button>
            <button type="button" :class="{ on: saveAsPdf }" @click="saveAsPdf = true">Save as PDF</button>
          </div>
          <span v-if="saveAsPdf" class="hint">Generates a PDF file directly and hands it to you - a download here, the save/share sheet in the Android app.</span>
        </div>
        <p v-if="pdfBusy" class="hint">Generating PDF…</p>
        <div class="docs">
          <button type="button" :disabled="pdfBusy" @click="openExportList">Export packing list</button>
          <button type="button" :disabled="pdfBusy" @click="openReimportList">Re-import packing list</button>
          <button type="button" class="primary" :disabled="pdfBusy" @click="openProforma">Proforma invoice</button>
        </div>
      </article>

      <article class="card" v-if="preview">
        <div class="sheet-head">
          <h2>Preview</h2>
          <button type="button" class="ghost" @click="preview = ''">Close</button>
        </div>
        <p class="hint">Your browser blocked the new tab - showing the document here instead.</p>
        <!-- Sandboxed: the engine emits a complete print document, and it must not reach the shell's DOM or session. -->
        <iframe class="output" title="Generated customs document" sandbox="allow-same-origin allow-modals" :srcdoc="preview"></iframe>
      </article>
    </template>
  </section>
</template>

<style scoped>
.customs { display: flex; flex-direction: column; gap: 1rem; max-width: 55rem; }
.bar { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.back { color: var(--zfy-muted, #5a6472); text-decoration: none; font-size: .875rem; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: .95rem; }
h3 { margin: .2rem 0 0; font-size: .85rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.warnings { margin: 0; padding-left: 1.2rem; display: flex; flex-direction: column; gap: .3rem; font-size: .78rem; color: var(--zfy-warning, #a06a10); }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .9rem 1rem; display: flex; flex-direction: column; gap: .7rem; }
.card.notice { background: var(--zfy-warning-soft, #fdf3e3); border-color: var(--zfy-warning, #e0a83a); font-size: .85rem; }
.card.notice p { margin: 0; color: var(--zfy-warning-ink, #8a5a1e); }
.docs { display: flex; gap: .5rem; flex-wrap: wrap; }
.fmt { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: .6rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label > span { font-size: .78rem; color: var(--zfy-muted, #5a6472); }
label.wide { grid-column: 1 / -1; }
.mono { font-family: ui-monospace, monospace; font-size: .85rem; }
.checklist { margin: 0; padding-left: 1.2rem; display: flex; flex-direction: column; gap: .4rem; font-size: .875rem; }

.sheet-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; flex-wrap: wrap; }
.ghost { background: transparent; border: 1px solid var(--zfy-line, #d6dde4); color: var(--zfy-muted, #5a6472); }
.chevron { background: transparent; border: 1px solid var(--zfy-line, #d6dde4); color: var(--zfy-muted, #5a6472); line-height: 1; padding: .3rem .6rem; }
.chevron > * { display: inline-block; transition: transform .15s ease; }
.chevron.open > * { transform: rotate(90deg); }
table.boxes, table.goods-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
table.boxes td { border: 1px solid var(--zfy-line, #d6dde4); padding: .4rem .55rem; vertical-align: top; }
table.boxes td.no { width: 3em; font-weight: 600; color: var(--zfy-muted, #5a6472); background: var(--zfy-bg, #f3f5f7); text-align: center; }
table.boxes td.label { width: 12em; color: var(--zfy-muted, #5a6472); }
table.boxes tr.missing td:last-child { color: var(--zfy-danger, #c6512f); }
table.boxes tr.missing td:last-child em { font-style: normal; }
table.goods-table th { background: var(--zfy-bg, #f1f4f6); color: var(--zfy-muted, #5a6472); font-weight: 600; padding: .35rem .5rem; text-align: left; font-size: .72rem; white-space: nowrap; }
table.goods-table th.r { text-align: right; }
table.goods-table td { border-bottom: 1px solid var(--zfy-line, #d6dde4); padding: .35rem .5rem; }
table.goods-table tbody tr:nth-child(even) td { background: var(--zfy-bg, #f3f5f7); }
table.goods-table tfoot td { background: var(--zfy-bg, #f3f5f7); font-weight: 600; border-top: 2px solid var(--zfy-line, #d6dde4); }
table.goods-table .empty-row { text-align: center; padding: .6rem; color: var(--zfy-muted, #5a6472); }
.r { text-align: right; }
.output { min-height: 60vh; width: 100%; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; background: #fff; }
</style>
