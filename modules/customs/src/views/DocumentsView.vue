<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { EventStock, SalesEvent } from '@zollify/shared';
import { CountryPicker, Icon } from '@zollify/ui';
import { buildAllVersionsHtml } from '../engine/all-versions';
import { buildCustomsState, readCustomsBlob } from '../engine/adapter';
import { compute1174Groups, computeLRP, fmtWeightKg } from '../engine/calc';
import { buildEdecXml } from '../engine/edec-xml';
import { build1174Html } from '../engine/form1174';
import { build1187Html } from '../engine/form1187';
import { buildGoodsListHtml, type GoodsDocNum, type GoodsFormat } from '../engine/goods-list';
import { buildProformaHtml } from '../engine/proforma';
import {
  defaultCustomsArtist,
  defaultCustomsEdec,
  defaultCustomsForm1174,
  type CustomsArtist,
  type CustomsEdec,
  type CustomsForm1174,
} from '../engine/model';
import { DECLARANT_KEY } from './declarant';
import { sdk } from '../runtime';

/**
 * One event's customs paperwork — ZollTool's screen. Everything typed here is
 * saved into `event.customs` a moment later and syncs with the event, so the
 * declaration a booth prepares at home is the one it carries to the border.
 *
 * The generators are the golden-tested ZollTool engine; this view feeds them
 * and adds nothing to their output.
 */

const route = useRoute();
const eventId = computed(() => String(route.params.eventId ?? ''));
const event = computed(() => sdk().data.events.get(eventId.value) ?? null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string): void {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = null), 2500);
}

// ── Editable customs settings (persisted into event.customs) ────────────────
const artist = ref<CustomsArtist>(defaultCustomsArtist());
const edec = ref<CustomsEdec>(defaultCustomsEdec());
const form1174 = ref<CustomsForm1174>(defaultCustomsForm1174());
const companyCode = ref('');
const documentNumber = ref(1);
const venueName = ref('');
const eventLocation = ref('');
const venueTIN = ref('');
const stock = ref<EventStock[]>([]);
let loadedEventId: string | null = null;
let loading = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Only filled-in fields, so defaults are not clobbered by blanks. */
function stripEmpty<T extends object>(obj: Partial<T> | undefined): Partial<T> {
  if (!obj) return {};
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v != null)) as Partial<T>;
}

async function load(ev: SalesEvent): Promise<void> {
  loading = true;
  loadedEventId = ev.id;
  const blob = readCustomsBlob(ev);
  // Layered, most specific last: booth profile, the module's declarant, this event's own record.
  const declarant = await sdk().config.get<Partial<CustomsArtist>>(DECLARANT_KEY);
  artist.value = { ...defaultCustomsArtist(), ...stripEmpty<CustomsArtist>(sdk().account()?.profile.artist), ...stripEmpty<CustomsArtist>(declarant ?? undefined), ...stripEmpty<CustomsArtist>(blob.artist) };
  edec.value = { ...defaultCustomsEdec(), ...(blob.edec ?? {}) };
  const f = { ...defaultCustomsForm1174(), ...(blob.form1174 ?? {}) };
  if (!Array.isArray(f.assignments)) f.assignments = [];
  form1174.value = f;
  companyCode.value = blob.meta?.companyCode ?? '';
  documentNumber.value = blob.meta?.documentNumber ?? 1;
  venueName.value = blob.meta?.venueName ?? '';
  eventLocation.value = blob.meta?.eventLocation ?? '';
  venueTIN.value = blob.meta?.venueTIN ?? ev.venue?.tin ?? '';
  stock.value = await sdk().data.events.stock(ev.id);
  setTimeout(() => (loading = false));
}

watch(
  event,
  (ev) => {
    if (ev && ev.id !== loadedEventId) void load(ev);
  },
  { immediate: true },
);
onMounted(() => {
  if (event.value && event.value.id !== loadedEventId) void load(event.value);
});
onUnmounted(() => {
  clearTimeout(noticeTimer);
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
  const blob = readCustomsBlob(ev);
  try {
    await sdk().data.events.upsert({
      ...ev,
      customs: {
        ...ev.customs,
        artist: { ...artist.value },
        edec: { ...edec.value },
        form1174: JSON.parse(JSON.stringify(form1174.value)),
        meta: {
          ...blob.meta,
          companyCode: companyCode.value,
          documentNumber: documentNumber.value,
          venueName: venueName.value,
          eventLocation: eventLocation.value,
          venueTIN: venueTIN.value,
        },
      },
      updatedAt: Date.now(),
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the customs details.';
  }
}
watch([artist, edec, form1174, companyCode, documentNumber, venueName, eventLocation, venueTIN], scheduleSave, { deep: true });

/** Company code from the artist's initials — "Phuong Ninjin" → "PN". */
const autoCompanyCode = computed(() => {
  const name = (artist.value.companyName || artist.value.fullName || '').trim();
  if (!name) return '';
  const words = name.split(/\s+/).filter(Boolean);
  const raw = words.length > 1 ? words.map((w) => w[0]).join('') : name.slice(0, 3);
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
});
const effectiveCompanyCode = computed(() => companyCode.value.trim() || autoCompanyCode.value);

// ── Live state for the generators ───────────────────────────────────────────
const state = computed(() => {
  const ev = event.value;
  if (!ev) return null;
  const withEdits: SalesEvent = {
    ...ev,
    customs: {
      artist: artist.value,
      edec: edec.value,
      form1174: form1174.value,
      meta: {
        companyCode: effectiveCompanyCode.value,
        documentNumber: documentNumber.value,
        venueName: venueName.value,
        eventLocation: eventLocation.value,
        venueTIN: venueTIN.value,
      },
    },
  };
  const api = sdk().data;
  return buildCustomsState(withEdits, api.products.list(), stock.value, api.transactions.recent());
});
const lrp = computed(() => (state.value ? computeLRP(state.value, documentNumber.value) : ''));
const claimedUnits = computed(() => state.value?.products.reduce((n, p) => n + (p.amount ?? 0) + (p.variants ?? []).reduce((m, v) => m + (v.amount ?? 0), 0), 0) ?? 0);
const groups = computed(() => (state.value ? compute1174Groups(JSON.parse(JSON.stringify(state.value))) : null));

function setAssignment(index: number, group: 1 | 2): void {
  const asn = [...form1174.value.assignments];
  while (asn.length < (state.value?.products.length ?? 0)) asn.push(0);
  asn[index] = group;
  form1174.value = { ...form1174.value, assignments: asn };
}

// ── Documents ───────────────────────────────────────────────────────────────
const goodsFormat = ref<GoodsFormat>('detailed');
const hasVariantProducts = computed(() => state.value?.products.some((p) => !p.unlisted && (p.variants?.length ?? 0) > 0) ?? false);
const formatOptions = computed<{ value: GoodsFormat; label: string }[]>(() =>
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
  if (!has && goodsFormat.value === 'compressed') goodsFormat.value = 'detailed';
});

const safeName = (suffix: string): string => `${(event.value?.name || 'event').replace(/[^\w-]+/g, '_')}_${suffix}`;

/** Opens a generated document in its own tab — that is where it gets printed or saved as PDF. */
function openHtml(html: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const win = window.open(url, '_blank');
  if (!win) preview.value = html;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
const openGoodsList = (docNum: GoodsDocNum) => state.value && openHtml(buildGoodsListHtml(state.value, docNum, goodsFormat.value));
const openAll = () => state.value && openHtml(buildAllVersionsHtml(state.value));
const openProforma = () => state.value && openHtml(buildProformaHtml(state.value));
const open1174 = () => state.value && openHtml(build1174Html(state.value));
const open1187 = () => state.value && openHtml(build1187Html(state.value));
function exportEdec(): void {
  if (!state.value) return;
  const result = buildEdecXml(state.value);
  if (!result) return toast('No products have sold quantities > 0 yet.');
  download(result.filename, result.xml, 'application/xml');
}

/** Inline preview, for when a pop-up is blocked or to check before printing. */
const preview = ref('');
const previewChoice = ref<'all' | '1' | '2' | '3' | 'proforma' | '1174' | '1187'>('all');
watch(
  [state, previewChoice, goodsFormat],
  () => {
    if (!state.value) return (preview.value = '');
    try {
      const c = previewChoice.value;
      preview.value =
        c === 'all' ? buildAllVersionsHtml(state.value) : c === 'proforma' ? buildProformaHtml(state.value) : c === '1174' ? build1174Html(state.value) : c === '1187' ? build1187Html(state.value) : buildGoodsListHtml(state.value, Number(c) as GoodsDocNum, goodsFormat.value);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      preview.value = '';
    }
  },
  { immediate: true },
);
function printPreview(): void {
  (document.getElementById('customs-output') as HTMLIFrameElement | null)?.contentWindow?.print();
}

const TRANSPORT_MODES = [
  ['1', '1 - Sea'],
  ['2', '2 - Rail'],
  ['3', '3 - Road'],
  ['4', '4 - Air'],
  ['5', '5 - Postal / Mail'],
  ['9', '9 - Own propulsion'],
] as const;
</script>

<template>
  <section class="customs">
    <header class="bar">
      <router-link :to="{ name: 'customs:index' }" class="back"><Icon name="arrow-left" :size="14" /> Customs</router-link>
      <h1>{{ event?.name ?? 'Customs documents' }}</h1>
      <span v-if="event?.dateStart" class="muted">{{ event.dateStart }}<template v-if="event.dateEnd"> → {{ event.dateEnd }}</template></span>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="!event" class="empty">Event not found — open Customs from an event card under Events. Customs details are stored per event.</p>

    <template v-else>
      <p v-if="claimedUnits === 0" class="warn" role="status">This event has no stock claimed, so the goods lists are empty. Claim what you're taking under Inventory → Claimed for an event.</p>

      <article class="card">
        <h2>Documents</h2>
        <p class="hint">LRP: <code>{{ lrp }}</code> · Documents open in a new tab — print or save as PDF from there.</p>
        <div class="fmt">
          <span class="hint">Goods list format</span>
          <div class="seg">
            <button v-for="o in formatOptions" :key="o.value" type="button" :class="{ on: goodsFormat === o.value }" @click="goodsFormat = o.value">{{ o.label }}</button>
          </div>
        </div>
        <div class="docs">
          <button type="button" @click="openGoodsList(1)"><Icon name="download" :size="14" /> Import list</button>
          <button type="button" @click="openGoodsList(2)"><Icon name="coins" :size="14" /> Sold goods list</button>
          <button type="button" @click="openGoodsList(3)"><Icon name="upload" :size="14" /> Return goods list</button>
          <button type="button" @click="openAll"><Icon name="layers" :size="14" /> All formats bundle</button>
          <button type="button" @click="openProforma"><Icon name="file-text" :size="14" /> Proforma invoice</button>
          <button type="button" @click="open1174"><Icon name="file-text" :size="14" /> Form 11.74</button>
          <button type="button" @click="open1187"><Icon name="file-text" :size="14" /> Form 11.87</button>
          <button type="button" class="primary" @click="exportEdec"><Icon name="download" :size="14" /> e-dec XML</button>
        </div>
      </article>

      <article class="card">
        <h2>Artist / sender</h2>
        <div class="grid">
          <label><span>Company name</span><input v-model="artist.companyName" type="text" /></label>
          <label><span>Full name</span><input v-model="artist.fullName" type="text" /></label>
          <label><span>Street &amp; house number</span><input v-model="artist.street" type="text" /></label>
          <label><span>Postcode &amp; city</span><input v-model="artist.postCodeCity" type="text" placeholder="9000 Gent" /></label>
          <label><span>Country of origin</span><CountryPicker v-model="artist.countryOfOrigin" store="name" placeholder="Belgium" /></label>
          <label><span>Phone</span><input v-model="artist.phone" type="tel" /></label>
          <label class="wide"><span>Email</span><input v-model="artist.email" type="email" /></label>
        </div>
        <p class="hint">Prefilled from the booth profile and the declarant under Settings; what you change here applies to this event only.</p>
      </article>

      <article class="card">
        <h2>Declaration details</h2>
        <div class="grid">
          <label>
            <span>Company code (for LRP) <em v-if="!companyCode.trim() && autoCompanyCode">— auto: {{ autoCompanyCode }}</em></span>
            <input v-model="companyCode" type="text" :placeholder="autoCompanyCode || 'GUG'" />
          </label>
          <label><span>Document number</span><input v-model.number="documentNumber" type="number" min="1" inputmode="numeric" /></label>
          <label><span>Venue / organiser name</span><input v-model="venueName" type="text" placeholder="Messe Basel" /></label>
          <label><span>Venue TIN</span><input v-model="venueTIN" type="text" class="mono" /></label>
          <label class="wide"><span>Event location (shown on documents)</span><input v-model="eventLocation" type="text" /></label>
        </div>
        <p class="hint">Venue address and event dates come from the event itself — edit them under Events.</p>
      </article>

      <article class="card">
        <h2>Transport (e-dec / forms)</h2>
        <div class="grid">
          <label>
            <span>Transport mode</span>
            <select v-model="edec.transportMode"><option v-for="[v, l] in TRANSPORT_MODES" :key="v" :value="v">{{ l }}</option></select>
          </label>
          <label><span>Vehicle country</span><CountryPicker v-model="edec.transportationCountry" store="code" placeholder="BE" /></label>
          <label><span>Vehicle / plate number</span><input v-model="edec.transportationNumber" type="text" placeholder="1-KDE-308" /></label>
          <label v-if="edec.transportMode === '4'"><span>Flight number (form 11.74 field 6)</span><input v-model="edec.flightNumber" type="text" placeholder="LX1234" /></label>
        </div>
      </article>

      <article class="card">
        <h2>Form 11.74 / 11.87 goods grouping</h2>
        <div class="seg narrow">
          <button type="button" :class="{ on: form1174.groupMode === 'auto' }" @click="form1174 = { ...form1174, groupMode: 'auto' }">Automatic</button>
          <button type="button" :class="{ on: form1174.groupMode === 'manual' }" @click="form1174 = { ...form1174, groupMode: 'manual' }">Manual</button>
        </div>
        <div v-if="groups" class="groups">
          <div class="g"><strong>Group 1 · {{ groups.g1.tariffNo }}</strong><span>{{ groups.g1.qty }} items · {{ fmtWeightKg(groups.g1.weightKg) }} · {{ Math.floor(groups.g1.value) }} {{ event.currency }}</span></div>
          <div class="g" :class="{ dim: !groups.hasG2 }"><strong>Group 2 · {{ groups.g2.tariffNo }}</strong><span>{{ groups.g2.qty }} items · {{ fmtWeightKg(groups.g2.weightKg) }} · {{ Math.floor(groups.g2.value) }} {{ event.currency }}</span></div>
        </div>
        <ul v-if="form1174.groupMode === 'manual' && state" class="assign">
          <li v-for="(p, i) in state.products" :key="p.id ?? i">
            <span class="name">{{ p.title }}</span>
            <span class="muted">{{ p.tariffNo || '—' }}</span>
            <div class="seg">
              <button type="button" :class="{ on: form1174.assignments[i] === 1 }" @click="setAssignment(i, 1)">G1</button>
              <button type="button" :class="{ on: form1174.assignments[i] !== 1 }" @click="setAssignment(i, 2)">G2</button>
            </div>
          </li>
        </ul>
        <p v-else class="hint">Automatic: the tariff group with the highest value becomes group 1, everything else group 2.</p>
      </article>

      <article class="card preview">
        <div class="fmt">
          <h2>Preview</h2>
          <select v-model="previewChoice" aria-label="Document">
            <option value="all">All documents</option>
            <option value="1">Import list</option>
            <option value="2">Sold goods list</option>
            <option value="3">Return goods list</option>
            <option value="proforma">Proforma invoice</option>
            <option value="1174">Form 11.74</option>
            <option value="1187">Form 11.87</option>
          </select>
          <button type="button" :disabled="!preview" @click="printPreview"><Icon name="printer" :size="14" /> Print</button>
        </div>
        <!-- Sandboxed: the engine emits a complete print document, and it must not reach the shell's DOM or session. -->
        <iframe v-if="preview" id="customs-output" class="output" title="Generated customs documents" sandbox="allow-same-origin allow-modals" :srcdoc="preview"></iframe>
      </article>
    </template>
  </section>
</template>

<style scoped>
.customs { display: flex; flex-direction: column; gap: 1rem; max-width: 60rem; }
.bar { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.back { display: inline-flex; align-items: center; gap: .25rem; color: var(--zfy-muted, #5a6472); text-decoration: none; font-size: .875rem; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: .95rem; }
.muted { color: var(--zfy-muted, #5a6472); font-size: .85rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.hint code { font-family: ui-monospace, monospace; color: var(--zfy-ink, #1a2230); }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.notice { margin: 0; padding: .45rem .75rem; border-radius: 8px; font-size: .85rem; background: var(--zfy-signal-soft, #f6e5df); color: var(--zfy-danger, #c6512f); }
.warn { margin: 0; color: var(--zfy-warning-ink, #8a5a1e); font-size: .9rem; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .9rem 1rem; display: flex; flex-direction: column; gap: .7rem; }
.fmt { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.fmt h2 { flex: 1; }
.seg.narrow { align-self: flex-start; }
.seg.narrow button { min-width: 6rem; }
.docs { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .5rem; }
.docs button { display: inline-flex; align-items: center; justify-content: center; gap: .4rem; font-size: .85rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: .6rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label > span { font-size: .78rem; color: var(--zfy-muted, #5a6472); }
label em { font-style: normal; color: var(--zfy-accent-ink, #0a5a4a); }
label.wide { grid-column: 1 / -1; }
.mono { font-family: ui-monospace, monospace; font-size: .85rem; }
.groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: .5rem; }
.g { display: flex; flex-direction: column; gap: .15rem; padding: .6rem .8rem; border-radius: 10px; background: var(--zfy-bg, #f1f4f6); font-size: .8rem; }
.g span { color: var(--zfy-muted, #5a6472); }
.g.dim { opacity: .45; }
.assign { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.assign li { display: flex; align-items: center; gap: .6rem; padding: .3rem .6rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); font-size: .875rem; }
.assign .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview .fmt button { display: inline-flex; align-items: center; gap: .3rem; }
.output { min-height: 60vh; width: 100%; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; background: #fff; }
</style>
