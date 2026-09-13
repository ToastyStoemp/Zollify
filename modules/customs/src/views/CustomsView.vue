<script setup lang="ts">
import { computed } from 'vue';
import { sdk } from '../runtime';

/**
 * Entry point for the Customs module. Events are core data, read through the
 * SDK rather than copied into a table of this module's own.
 */
const events = computed(() => sdk().data.events.list());
const activeId = computed(() => sdk().data.events.active()?.id ?? null);

function when(event: { dateStart?: string; dateEnd?: string }): string {
  if (!event.dateStart) return 'No dates yet';
  return event.dateEnd ? `${event.dateStart} → ${event.dateEnd}` : event.dateStart;
}
</script>

<template>
  <section class="customs-index">
    <h1>Customs</h1>
    <p class="lede">
      EDEC XML, Forms 1174 and 1187, a proforma invoice and goods lists — generated from an event's
      claimed stock and its sales.
    </p>

    <p v-if="events.length === 0" class="empty">
      No events yet. Create one in Events, then come back to prepare its paperwork.
    </p>

    <ul v-else class="events">
      <li v-for="event in events" :key="event.id">
        <router-link :to="{ name: 'customs:documents', params: { eventId: event.id } }">
          <span class="name">
            {{ event.name }}
            <span v-if="event.id === activeId" class="badge">Active</span>
          </span>
          <span class="when">{{ when(event) }} · {{ event.currency }}</span>
        </router-link>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.customs-index { display: flex; flex-direction: column; gap: 1rem; }
h1 { font-size: 1.35rem; margin: 0; }
.lede, .empty { color: var(--zfy-muted, #5a6472); margin: 0; }
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
