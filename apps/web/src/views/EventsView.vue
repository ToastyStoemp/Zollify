<script setup lang="ts">
import { computed, ref } from 'vue';
import { toLocalPrice } from '@boothly/shared';
import type { SalesEvent } from '@boothly/shared';
import {
  activeEventId,
  currentAccount,
  deleteSalesEvent,
  setActiveEvent,
  upsertSalesEvent,
  visibleEvents,
} from '@boothly/platform';

const account = currentAccount;
const editing = ref<SalesEvent | null>(null);
const error = ref<string | null>(null);

const canEdit = computed(
  () => account.value?.role === 'owner' || account.value?.role === 'admin',
);

const isHelper = computed(() => (account.value?.allowedEventIds?.length ?? 0) > 0);

/**
 * A worked example of the conversion.
 *
 * Exchange rate and rounding are easy to enter backwards, and the cost of
 * getting it wrong is charging every customer the wrong amount all weekend.
 * Showing what a round number becomes makes a reversed rate obvious.
 */
const localExample = computed(() => {
  const e = editing.value;
  if (!e?.localCurrency || !e.exchangeRate) return '';
  const converted = toLocalPrice(100, e.exchangeRate, e.roundingIncrement ?? 0);
  return `${e.currency || 'base'} 100 is charged as ${e.localCurrency} ${converted.toFixed(2)}`;
});

function blank(): SalesEvent {
  return {
    id: crypto.randomUUID(),
    name: '',
    venue: {} as SalesEvent['venue'],
    currency: 'CHF',
    status: 'planned',
    updatedAt: Date.now(),
  } as SalesEvent;
}

async function save(): Promise<void> {
  if (!editing.value) return;
  if (!editing.value.name.trim()) {
    error.value = 'Give the event a name before saving.';
    return;
  }
  error.value = null;
  try {
    await upsertSalesEvent({ ...editing.value, name: editing.value.name.trim() });
    editing.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save that event.';
  }
}

async function activate(id: string): Promise<void> {
  error.value = null;
  try {
    await setActiveEvent(activeEventId.value === id ? null : id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not change the active event.';
  }
}

async function remove(id: string): Promise<void> {
  try {
    await deleteSalesEvent(id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not remove that event.';
  }
}
</script>

<template>
  <section class="events">
    <header>
      <h1>Events</h1>
      <button v-if="canEdit" type="button" @click="editing = blank()">New event</button>
    </header>

    <p v-if="isHelper" class="scoped">
      You're set up as a helper, so you only see the events you've been given.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <form v-if="editing" class="editor" @submit.prevent="save">
      <div class="grid">
        <label><span>Name</span><input v-model="editing.name" type="text" required /></label>
        <label>
          <span>Base currency</span>
          <input v-model="editing.currency" type="text" maxlength="3" />
        </label>
        <label><span>Starts</span><input v-model="editing.dateStart" type="date" /></label>
        <label><span>Ends</span><input v-model="editing.dateEnd" type="date" /></label>
      </div>

      <fieldset class="local">
        <legend>Charging in another currency</legend>
        <p class="hint">
          For a convention abroad. Prices stay in the base currency for your books; the till charges
          the converted amount.
        </p>
        <div class="grid">
          <label>
            <span>Local currency</span>
            <input v-model="editing.localCurrency" type="text" maxlength="3" placeholder="SEK" />
          </label>
          <label>
            <span>1 {{ editing.currency || 'base' }} =</span>
            <input v-model.number="editing.exchangeRate" type="number" min="0" step="0.0001" />
          </label>
          <label>
            <span>Round to nearest</span>
            <input v-model.number="editing.roundingIncrement" type="number" min="0" step="1" placeholder="0" />
          </label>
        </div>
        <p v-if="localExample" class="hint">{{ localExample }}</p>
      </fieldset>
      <div class="actions">
        <button type="button" @click="editing = null">Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>

    <p v-if="!visibleEvents.length" class="empty">
      No events yet. Create one to start selling — every sale is recorded against the active event.
    </p>

    <ul v-else class="list">
      <li v-for="event in visibleEvents" :key="event.id" :class="{ active: activeEventId === event.id }">
        <div class="meta">
          <strong>{{ event.name }}</strong>
          <span class="when">
            {{ event.dateStart ?? '—' }}<template v-if="event.dateEnd"> → {{ event.dateEnd }}</template>
            · {{ event.currency }}
            <template v-if="event.localCurrency">
              → {{ event.localCurrency }} @ {{ event.exchangeRate ?? '?' }}
            </template>
          </span>
        </div>
        <div class="row-actions">
          <span v-if="activeEventId === event.id" class="badge">Active</span>
          <button type="button" @click="activate(event.id)">
            {{ activeEventId === event.id ? 'Stand down' : 'Make active' }}
          </button>
          <button v-if="canEdit" type="button" @click="editing = { ...event }">Edit</button>
          <button v-if="canEdit" type="button" @click="remove(event.id)">Remove</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.events { display: flex; flex-direction: column; gap: 1rem; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
h1 { margin: 0; font-size: 1.35rem; }
.empty, .scoped { color: var(--bly-muted, #5a6472); margin: 0; }
.error { color: var(--bly-danger, #c6512f); margin: 0; }
.editor { border: 1px solid var(--bly-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--bly-surface, #fff); display: flex; flex-direction: column; gap: .75rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .75rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.actions { display: flex; gap: .5rem; justify-content: flex-end; }
.local { border: 1px solid var(--bly-line, #d6dde4); border-radius: 8px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .5rem; }
.local legend { font-size: .8rem; padding: 0 .3rem; color: var(--bly-muted, #5a6472); }
.hint { color: var(--bly-muted, #5a6472); margin: 0; font-size: .8rem; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.list li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--bly-line, #d6dde4); border-radius: 10px; padding: .75rem 1rem; background: var(--bly-surface, #fff); }
.list li.active { border-color: var(--bly-accent, #0e7c66); }
.meta { display: flex; flex-direction: column; gap: .1rem; }
.when { font-size: .8rem; color: var(--bly-muted, #5a6472); font-variant-numeric: tabular-nums; }
.row-actions { display: flex; align-items: center; gap: .4rem; }
.badge { font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; color: var(--bly-accent-ink, #0a5a4a); background: var(--bly-accent-soft, #deeee9); border-radius: 999px; padding: .15rem .5rem; }
</style>
