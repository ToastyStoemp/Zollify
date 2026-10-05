<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { collectBundleProviders, type CustomsPhase } from '@zollify/customs-core';
import { htmlDocsToPdf, Icon } from '@zollify/ui';
import { sdk } from '../runtime';

interface CountryCard {
  key: string;
  flag: string;
  title: string;
  description: string;
  indexRoute: string;
  documentsRoute: string;
  declarantPanel: string;
}

const COUNTRIES: CountryCard[] = [
  {
    key: 'ch',
    flag: '🇨🇭',
    title: 'Switzerland',
    description: 'e-dec XML, Forms 11.74 and 11.87, sold/return goods lists, proforma invoices.',
    indexRoute: 'customs-ch:index',
    documentsRoute: 'customs-ch:documents',
    declarantPanel: 'customs-ch.declarant',
  },
  {
    key: 'de',
    flag: '🇩🇪',
    title: 'Germany',
    description: 'Export/re-import packing lists, DEXPDF XML, IAA-Plus filing sheet, proforma invoice.',
    indexRoute: 'customs-de:index',
    documentsRoute: 'customs-de:documents',
    declarantPanel: 'customs-de.declarant',
  },
];

const router = useRouter();
const route = useRoute();
const countries = computed(() => COUNTRIES.filter((c) => router.hasRoute(c.indexRoute)));

/**
 * Set when arriving from an event's "Customs" button: picking a country then
 * opens that event's paperwork directly instead of the country's event list.
 */
const eventId = computed(() => (typeof route.query.event === 'string' ? route.query.event : null));
const event = computed(() => (eventId.value ? sdk().data.events.get(eventId.value) ?? null : null));

function openTarget(c: CountryCard) {
  return eventId.value && router.hasRoute(c.documentsRoute)
    ? { name: c.documentsRoute, params: { eventId: eventId.value } }
    : { name: c.indexRoute };
}

// ── Export all documents ─────────────────────────────────────────────────────
// Each installed country module builds its own documents, in its own
// currency (see CustomsBundleProvider); this page only renders them into one
// PDF per country and hands the files over.

/** Without an event from the URL, pick one here - the active event first. */
const events = computed(() =>
  [...sdk().data.events.list()].sort((a, b) => (b.dateStart || '').localeCompare(a.dateStart || '') || a.name.localeCompare(b.name)),
);
const pickedEventId = ref(sdk().data.events.active()?.id ?? '');
const exportEventId = computed(() => eventId.value ?? (pickedEventId.value || null));

interface ExportResult {
  phase: CustomsPhase;
  saved: string[];
  links: { label: string; url: string }[];
  notes: string[];
}
const exporting = ref<CustomsPhase | null>(null);
const exportError = ref<string | null>(null);
const result = ref<ExportResult | null>(null);

async function exportAll(phase: CustomsPhase): Promise<void> {
  const id = exportEventId.value;
  if (!id) return;
  exporting.value = phase;
  exportError.value = null;
  result.value = null;
  const out: ExportResult = { phase, saved: [], links: [], notes: [] };
  try {
    const providers = collectBundleProviders(sdk().events);
    if (!providers.length) throw new Error('No customs country module is running on this device.');
    for (const provider of providers) {
      const bundle = await provider.build(id, phase);
      if (!bundle) continue;
      if (bundle.docs.length) {
        const name = `${bundle.fileBase}_${phase}_${provider.country}_${bundle.currency}.pdf`;
        const pdf = await htmlDocsToPdf(bundle.docs.map((d) => d.html));
        await sdk().ui.saveFile(name, pdf, 'application/pdf');
        out.saved.push(`${name} - ${bundle.country}, ${bundle.currency}: ${bundle.docs.map((d) => d.title).join(', ')}`);
      }
      for (const f of bundle.files) {
        await sdk().ui.saveFile(f.filename, f.content, f.mimeType);
        out.saved.push(`${f.filename} - ${bundle.country}`);
      }
      out.links.push(...bundle.links);
      out.notes.push(...bundle.notes.map((n) => `${bundle.country}: ${n}`));
    }
    result.value = out;
  } catch (err) {
    exportError.value = err instanceof Error ? err.message : 'Could not export the documents.';
    if (out.saved.length) result.value = out;
  } finally {
    exporting.value = null;
  }
}
</script>

<template>
  <section class="page customs-hub">
    <header><h1>Customs</h1></header>
    <p v-if="eventId" class="lede">
      Which country's paperwork do you need<template v-if="event"> for <strong>{{ event.name }}</strong></template>?
    </p>
    <p v-else class="lede">Pick a country to open its events and generate paperwork, or jump to its declarant settings.</p>

    <p v-if="countries.length === 0" class="empty">
      Neither the Switzerland nor Germany customs module is installed. Add one under Settings → Modules.
    </p>

    <article v-if="countries.length" class="card export">
      <h2>Export all documents</h2>
      <p class="desc">
        Every installed country's paperwork at once - one PDF per country, in that country's currency.
        <strong>Before</strong>: packing list and proforma invoice. <strong>After</strong>: return / re-import and sold goods lists, plus the Swiss e-dec XML.
      </p>
      <label v-if="!eventId" class="pick">
        <span>Event</span>
        <select v-model="pickedEventId">
          <option value="" disabled>Choose an event</option>
          <option v-for="e in events" :key="e.id" :value="e.id">{{ e.name }}{{ e.dateStart ? ` (${e.dateStart})` : '' }}</option>
        </select>
      </label>
      <div class="row">
        <button type="button" class="btn-primary" :disabled="!exportEventId || exporting !== null" @click="exportAll('before')">
          <Icon name="download" :size="14" /> {{ exporting === 'before' ? 'Exporting…' : 'Before the event' }}
        </button>
        <button type="button" class="btn-primary" :disabled="!exportEventId || exporting !== null" @click="exportAll('after')">
          <Icon name="download" :size="14" /> {{ exporting === 'after' ? 'Exporting…' : 'After the event' }}
        </button>
      </div>
      <p v-if="exportError" class="error" role="alert">{{ exportError }}</p>
      <div v-if="result" class="result" role="status">
        <p class="ok"><Icon name="check" :size="14" /> {{ result.phase === 'before' ? 'Before-event' : 'After-event' }} documents saved:</p>
        <ul>
          <li v-for="s in result.saved" :key="s">{{ s }}</li>
        </ul>
        <p v-for="n in result.notes" :key="n" class="desc">{{ n }}</p>
        <a v-for="l in result.links" :key="l.url" :href="l.url" target="_blank" rel="noopener" class="link-btn">
          <Icon name="external-link" :size="14" /> {{ l.label }}
        </a>
      </div>
    </article>

    <div v-if="countries.length" class="cards">
      <article v-for="c in countries" :key="c.key" class="card">
        <div class="flag">{{ c.flag }}</div>
        <h2>{{ c.title }}</h2>
        <p class="desc">{{ c.description }}</p>
        <div class="actions">
          <router-link :to="openTarget(c)" class="primary">{{ eventId ? 'Open documents' : 'Open events' }}</router-link>
          <router-link :to="{ name: 'settings', query: { panel: c.declarantPanel } }" class="secondary">Declarant settings</router-link>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.lede { color: var(--zfy-muted, #5a6472); margin: -.25rem 0 1rem; }
.empty { color: var(--zfy-muted, #5a6472); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; }
.card {
  border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1.25rem;
  background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .5rem;
}
.flag { font-size: 2rem; line-height: 1; }
.card h2 { margin: 0; font-size: 1.05rem; }
.desc { color: var(--zfy-muted, #5a6472); font-size: .85rem; margin: 0; flex: 1; }
.actions { display: flex; flex-direction: column; gap: .5rem; margin-top: .5rem; }
.actions a { text-decoration: none; text-align: center; border-radius: 8px; padding: .55rem 1rem; font-weight: 600; font-size: .9rem; }
.primary { background: var(--zfy-accent, #0e7c66); color: #fff; }
.primary:hover { background: var(--zfy-accent-ink, #0a5a4a); }
.secondary { border: 1px solid var(--zfy-line, #d6dde4); color: inherit; }
.secondary:hover { border-color: var(--zfy-accent, #0e7c66); }
.export { margin-bottom: 1rem; }
.pick { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; max-width: 22rem; }
.row { display: flex; gap: .5rem; flex-wrap: wrap; }
.btn-primary { display: inline-flex; align-items: center; gap: .4rem; background: var(--zfy-accent, #0e7c66); border-color: var(--zfy-accent, #0e7c66); color: var(--zfy-on-accent, #fff); }
.btn-primary:hover:not(:disabled) { filter: brightness(.92); background: var(--zfy-accent, #0e7c66); }
.error { color: var(--zfy-danger, #c6512f); margin: 0; font-size: .875rem; }
.result { display: flex; flex-direction: column; gap: .4rem; align-items: flex-start; }
.result ul { margin: 0; padding-left: 1.1rem; font-size: .85rem; }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); display: inline-flex; align-items: center; gap: .35rem; font-weight: 600; }
.link-btn { display: inline-flex; align-items: center; gap: .4rem; text-decoration: none; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; padding: .45rem .95rem; color: inherit; font-weight: 500; font-size: .875rem; }
.link-btn:hover { background: var(--zfy-surface-2, #e9edf1); }
</style>
