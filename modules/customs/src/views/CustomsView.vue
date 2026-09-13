<script setup lang="ts">
import { ref } from 'vue';

/**
 * Entry point for the Customs module. Event selection is core data, so this
 * view reads it through the SDK rather than owning an events table of its own.
 */
const events = ref<{ id: string; name: string; startsAt: number }[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
</script>

<template>
  <section class="customs-index">
    <h1>Customs</h1>
    <p class="lede">
      Generate EDEC XML, Forms 1174 and 1187, proforma invoices and goods lists for an event.
    </p>

    <p v-if="loading">Loading events…</p>
    <p v-else-if="error" class="error" role="alert">{{ error }}</p>
    <p v-else-if="events.length === 0" class="empty">
      No events yet. Create one in Events, then come back to prepare its paperwork.
    </p>

    <ul v-else class="events">
      <li v-for="event in events" :key="event.id">
        <router-link :to="{ name: 'customs:documents', params: { eventId: event.id } }">
          {{ event.name }}
        </router-link>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.customs-index { display: flex; flex-direction: column; gap: 1rem; }
h1 { font-size: 1.25rem; margin: 0; }
.lede, .empty { color: var(--bly-muted, #5a6472); margin: 0; }
.error { color: var(--bly-danger, #c6512f); }
.events { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .5rem; }
</style>
