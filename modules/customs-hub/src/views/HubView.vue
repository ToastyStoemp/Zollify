<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
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

    <div v-else class="cards">
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
</style>
