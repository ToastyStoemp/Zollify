<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { COUNTRIES, fmtDayRange, fmtPrice, type EventStock } from '@zollify/shared';
import { htmlToPdf } from '@zollify/ui';
import { sdk } from '../runtime';
import { buildCarnetList, carnetCsv, defaultCarnetState, generalListHtml, readCarnetState, returnCheckHtml, type CarnetState } from '../engine';

/**
 * One event's carnet: its number and validity (kept on the event under
 * `carnet`), the General List from what the event claims, and the return
 * check after the show. The list is a PDF, a page to print, or a CSV for
 * the chamber's online application.
 */
const route = useRoute();
const router = useRouter();
const routeEventId = computed(() => (typeof route.params.eventId === 'string' ? route.params.eventId : ''));
const events = computed(() => [...sdk().data.events.list()].filter((e) => e.kind !== 'store' && !e.deletedAt).sort((a, b) => (b.dateStart ?? '').localeCompare(a.dateStart ?? '')));
const pickedId = ref(routeEventId.value || sdk().data.events.active()?.id || '');
const event = computed(() => (pickedId.value ? sdk().data.events.get(pickedId.value) ?? null : null));
const stock = ref<EventStock[]>([]);
const form = reactive<CarnetState>(defaultCarnetState());
const error = ref<string | null>(null);
const ok = ref<string | null>(null);
const busy = ref(false);
const countryInput = ref('');

async function loadEvent(): Promise<void> {
  const e = event.value;
  if (!e) return;
  Object.assign(form, readCarnetState(e));
  stock.value = await sdk().data.events.stock(e.id);
}
onMounted(loadEvent);
watch(pickedId, async (id) => {
  if (id && id !== routeEventId.value) await router.replace({ name: 'ata-carnet:documents', params: { eventId: id } });
  await loadEvent();
});

const home = computed(() => sdk().account()?.profile.artist.countryOfOrigin ?? '');
const list = computed(() => (event.value ? buildCarnetList(event.value, sdk().data.products.list(), stock.value, sdk().data.transactions.recent(), form, home.value) : null));
const holder = computed(() => form.holder || sdk().account()?.profile.artist.companyName || sdk().account()?.profile.artist.fullName || sdk().account()?.accountName || '');
const meta = computed(() => ({ holder: holder.value, eventName: event.value?.name ?? '', dateStart: event.value?.dateStart ?? '', dateEnd: event.value?.dateEnd ?? event.value?.dateStart ?? '', countries: form.countries.map((c) => COUNTRIES.find((x) => x.code === c)?.name ?? c).join(', ') }));
const over = computed(() => !!event.value?.dateEnd && event.value.dateEnd < new Date().toISOString().slice(0, 10));
const otherEvents = computed(() => events.value.filter((e) => e.id !== pickedId.value));

function addCountry(): void {
  const code = countryInput.value.trim().toUpperCase().slice(0, 2);
  if (code.length === 2 && !form.countries.includes(code)) form.countries = [...form.countries, code];
  countryInput.value = '';
}
async function save(): Promise<void> {
  const e = event.value;
  if (!e) return;
  busy.value = true;
  error.value = ok.value = null;
  try {
    await sdk().data.events.upsert({ ...e, carnet: { ...form, countries: [...form.countries], combinedEventIds: [...form.combinedEventIds] }, updatedAt: Date.now() });
    ok.value = 'Saved on the event.';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save.';
  } finally {
    busy.value = false;
  }
}
const fileBase = computed(() => `carnet-${(event.value?.name ?? 'event').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
async function openDoc(kind: 'list' | 'return'): Promise<void> {
  if (!list.value) return;
  const html = kind === 'list' ? generalListHtml(list.value, form, meta.value) : returnCheckHtml(list.value, form, meta.value);
  if (!(await sdk().ui.openDocument(`${fileBase.value}-${kind}.html`, html, 'text/html'))) sdk().ui.toast('The window was blocked - allow pop-ups for this site.', { kind: 'warning' });
}
async function savePdf(kind: 'list' | 'return'): Promise<void> {
  if (!list.value) return;
  busy.value = true;
  try {
    const html = kind === 'list' ? generalListHtml(list.value, form, meta.value) : returnCheckHtml(list.value, form, meta.value);
    await sdk().ui.saveFile(`${fileBase.value}-${kind === 'list' ? 'general-list' : 'return-check'}.pdf`, await htmlToPdf(html), 'application/pdf');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not build the PDF.';
  } finally {
    busy.value = false;
  }
}
async function saveCsv(): Promise<void> {
  if (!list.value) return;
  await sdk().ui.saveFile(`${fileBase.value}-general-list.csv`, carnetCsv(list.value), 'text/csv');
}
</script>

<template>
  <section class="carnet">
    <header class="top">
      <div>
        <h1>ATA Carnet</h1>
        <p class="lede">For a show outside the EU: the General List from what the event claims, and the return check after it. Sold pieces are declared where the show was; the rest comes back against the list.</p>
      </div>
    </header>
    <label class="pick">Event
      <select v-model="pickedId">
        <option value="" disabled>Choose an event</option>
        <option v-for="e in events" :key="e.id" :value="e.id">{{ e.name }}{{ e.dateStart ? ` (${fmtDayRange(e.dateStart, e.dateEnd)})` : '' }}{{ e.venue?.country ? ` · ${e.venue.country}` : '' }}</option>
      </select>
    </label>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="ok" class="ok" role="status">{{ ok }}</p>

    <template v-if="event && list">
      <form class="card" @submit.prevent="save">
        <h2>The carnet</h2>
        <div class="grid">
          <label>Carnet number <input v-model="form.number" type="text" maxlength="40" placeholder="From the chamber of commerce" /></label>
          <label>Issued <input v-model="form.issuedAt" type="date" /></label>
          <label>Valid until <input v-model="form.validUntil" type="date" /></label>
          <label>Holder as printed <input v-model="form.holder" type="text" maxlength="160" :placeholder="holder" /></label>
          <label>Values <select v-model="form.valueBasis"><option value="price">List price (commercial value)</option><option value="cost">At cost where known</option></select></label>
          <label>Countries <span class="inline"><input v-model="countryInput" type="text" maxlength="2" placeholder="GB" @keydown.enter.prevent="addCountry" /><button type="button" @click="addCountry">Add</button></span>
            <span class="chips"><button v-for="c in form.countries" :key="c" type="button" class="chip" @click="form.countries = form.countries.filter((x) => x !== c)">{{ COUNTRIES.find((x) => x.code === c)?.name ?? c }} ×</button></span>
          </label>
          <label class="wide">Same stock also goes to
            <select multiple size="3" :value="form.combinedEventIds" @change="form.combinedEventIds = Array.from(($event.target as HTMLSelectElement).selectedOptions).map((o) => o.value)">
              <option v-for="e in otherEvents" :key="e.id" :value="e.id">{{ e.name }}{{ e.dateStart ? ` (${e.dateStart})` : '' }}</option>
            </select>
            <span class="hint">One trip, several shows on one carnet: their sales count against this list too.</span>
          </label>
          <label class="wide">Notes on the list <input v-model="form.notes" type="text" maxlength="300" /></label>
        </div>
        <div class="actions"><button type="submit" class="primary" :disabled="busy">Save</button></div>
      </form>

      <section class="card">
        <div class="formhead"><h2>General List</h2><span class="hint">{{ list.rows.length }} lines · {{ list.totals.pieces }} pieces · {{ list.totals.weightKg.toFixed(3) }} kg · {{ fmtPrice(list.totals.value, list.currency) }}</span></div>
        <p v-if="!list.rows.length" class="hint">Nothing is claimed for this event yet - claim stock for it under Events, and the list fills itself.</p>
        <p v-for="i in list.issues" :key="i" class="warn">{{ i }}</p>
        <div v-if="list.rows.length" class="table-scroll stack">
          <table>
            <thead><tr><th>#</th><th>Description</th><th class="num">Pieces</th><th class="num">kg</th><th class="num">Value</th><th>Origin</th><th class="num">Sold</th><th class="num">Due back</th></tr></thead>
            <tbody>
              <tr v-for="r in list.rows" :key="r.no" class="row">
                <td class="mono">{{ r.no }}</td>
                <td><strong>{{ r.description }}</strong><span v-if="r.sku" class="hint"> · {{ r.sku }}</span></td>
                <td class="num" data-label="Pieces">{{ r.pieces }}</td>
                <td class="num" data-label="kg">{{ r.weightKg.toFixed(3) }}</td>
                <td class="num" data-label="Value">{{ fmtPrice(r.value, list.currency) }} <small class="hint">{{ r.valuedAt === 'cost' ? 'cost' : '' }}</small></td>
                <td data-label="Origin">{{ r.origin || '-' }}</td>
                <td class="num" data-label="Sold">{{ r.sold }}</td>
                <td class="num" data-label="Due back"><strong>{{ r.returning }}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="actions">
          <button type="button" class="primary" :disabled="busy || !list.rows.length" @click="savePdf('list')">General List PDF</button>
          <button type="button" :disabled="!list.rows.length" @click="openDoc('list')">Open to print</button>
          <button type="button" :disabled="!list.rows.length" @click="saveCsv">CSV for the application</button>
        </div>
      </section>

      <section class="card">
        <div class="formhead"><h2>After the show</h2><span class="hint">{{ list.totals.sold }} sold · {{ fmtPrice(list.totals.soldValue, list.currency) }} · {{ list.totals.returning }} due back</span></div>
        <p class="hint">{{ over ? 'The event is over.' : 'The event is not over yet; the figures follow the sales as they come in.' }} Sold pieces did not return and are to be declared in the country of the show; the rest is presented at re-importation against the list.</p>
        <div class="actions">
          <button type="button" class="primary" :disabled="busy || !list.rows.length" @click="savePdf('return')">Return check PDF</button>
          <button type="button" :disabled="!list.rows.length" @click="openDoc('return')">Open to print</button>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.carnet { display: flex; flex-direction: column; gap: .9rem; }
.top { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: 1.05rem; }
.lede, .hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .9rem; max-width: 70ch; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
.warn { margin: 0; color: #9a3412; font-size: .875rem; }
.pick { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; max-width: 26rem; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .7rem; }
.formhead { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .6rem; }
.grid label { display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; }
.grid .wide { grid-column: 1 / -1; }
.inline { display: flex; gap: .3rem; }
.inline input { width: 5rem; }
.chips { display: flex; gap: .3rem; flex-wrap: wrap; margin-top: .2rem; }
.chip { font-size: .78rem; padding: .2rem .6rem; border-radius: 999px; min-height: 0; }
.actions { display: flex; gap: .5rem; flex-wrap: wrap; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); font-size: .9rem; white-space: nowrap; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.mono { font-variant-numeric: tabular-nums; color: var(--zfy-muted, #5a6472); }
</style>
