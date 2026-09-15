<script setup lang="ts">
import { computed } from 'vue';
import { sdk } from '../runtime';

/**
 * Entry point for the Customs module. Events are core data, read through the
 * SDK rather than copied into a table of this module's own.
 */
const events = computed(() => sdk().data.events.list());
const activeId = computed(() => sdk().data.events.active()?.id ?? null);

/** Same rule as inventory reservations: closed, or its last day has passed. */
const today = new Date().toISOString().slice(0, 10);
const isOver = (e: { status: string; dateStart?: string; dateEnd?: string }): boolean =>
  e.status === 'closed' || Boolean((e.dateEnd || e.dateStart || '') && (e.dateEnd || e.dateStart || '') < today);
const dateKey = (e: { dateStart?: string; dateEnd?: string }): string => e.dateStart || e.dateEnd || '';
const upcoming = computed(() => events.value.filter((e) => !isOver(e)).sort((a, b) => dateKey(a).localeCompare(dateKey(b))));
const past = computed(() => events.value.filter((e) => isOver(e)).sort((a, b) => dateKey(b).localeCompare(dateKey(a))));

function when(event: { dateStart?: string; dateEnd?: string }): string {
  if (!event.dateStart) return 'No dates yet';
  return event.dateEnd ? `${event.dateStart} → ${event.dateEnd}` : event.dateStart;
}
</script>

<template>
  <section class="page customs-index">
    <header><h1>Customs</h1></header>
    <p class="lede">
      EDEC XML, Forms 1174 and 1187, a proforma invoice and goods lists — generated from an event's
      claimed stock and its sales.
    </p>

    <p v-if="events.length === 0" class="empty">
      No events yet. Create one in Events, then come back to prepare its paperwork.
    </p>

    <template v-else>
      <template v-for="group in [{ label: 'Upcoming', list: upcoming }, { label: 'Past', list: past }]" :key="group.label">
        <template v-if="group.list.length">
          <h2>{{ group.label }}</h2>
          <ul class="events">
            <li v-for="event in group.list" :key="event.id">
              <router-link :to="{ name: 'customs:documents', params: { eventId: event.id } }">
                <span class="name">
                  {{ event.name }}
                  <span v-if="event.id === activeId" class="badge">Active</span>
                </span>
                <span class="when">{{ when(event) }} · {{ event.currency }}</span>
              </router-link>
            </li>
          </ul>
        </template>
      </template>
    </template>
  </section>
</template>

<style scoped>
h2 { margin: .25rem 0 -.5rem; font-size: .8rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--zfy-muted, #5a6472); }
.events { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .5rem; }
.events a {
  display: flex; flex-direction: column; gap: .15rem; text-decoration: none; color: inherit;
  border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .75rem 1rem;
  background: var(--zfy-surface, #fff);
}
.events a:hover { border-color: var(--zfy-accent, #0e7c66); }
.name { font-weight: 600; display: flex; align-items: center; gap: .5rem; }
.when { font-size: .8rem; color: var(--zfy-muted, #5a6472); font-variant-numeric: tabular-nums; }
.badge { font-size: .7rem; text-transform: uppercase; letter-spacing: .08em; color: var(--zfy-accent-ink, #0a5a4a); background: var(--zfy-accent-soft, #deeee9); border-radius: 999px; padding: .1rem .5rem; font-weight: 600; }
</style>
