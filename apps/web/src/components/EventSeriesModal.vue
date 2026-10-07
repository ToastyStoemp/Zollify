<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { editionLabelOf, suggestEditionLabels } from '@zollify/shared';
import { DateRangePicker, ModalShell } from '@zollify/ui';
import {
  createNextEdition,
  editionsOf,
  eventIsOver,
  getSalesEvent,
  linkToSeries,
  setEditionLabel,
  unlinkFromSeries,
  visibleEvents,
} from '@zollify/platform';

/**
 * An event's series: the other editions of the same convention, a way to
 * jump between them, to link an existing event in, and to create the next
 * edition as a copy. An event with no series is a one-off until it is linked.
 */
const props = defineProps<{ eventId: string; canEdit: boolean }>();
const emit = defineEmits<{ close: []; planner: [eventId: string] }>();

/** The edition being looked at; "Switch" moves it without closing the modal. */
const currentId = ref(props.eventId);
const event = computed(() => visibleEvents.value.find((e) => e.id === currentId.value));
const editions = computed(() => editionsOf(currentId.value));
const error = ref<string | null>(null);
const busy = ref(false);

const label = ref('');
const fmtDates = (e: { dateStart?: string; dateEnd?: string }): string =>
  e.dateStart && e.dateEnd && e.dateStart !== e.dateEnd ? `${e.dateStart} → ${e.dateEnd}` : e.dateStart || e.dateEnd || 'No dates';

// Rename this edition
const editLabel = ref(event.value?.edition ?? '');
watch(currentId, () => {
  editLabel.value = event.value?.edition ?? '';
});

// Next edition
const next = ref({ label: '', dateStart: '', dateEnd: '', stock: 'none' as 'none' | 'same' });
const suggestions = computed(() => (event.value ? suggestEditionLabels(event.value, next.value.dateStart) : []));
let lastAuto = '';
watch(
  [currentId, () => next.value.dateStart],
  () => {
    // Follow the suggestion until the user has typed their own.
    if (!next.value.label || suggestions.value.includes(next.value.label) || next.value.label === lastAuto) {
      lastAuto = suggestions.value[0] ?? '';
      next.value.label = lastAuto;
    }
  },
  { immediate: true },
);
const sourceRunning = computed(() => Boolean(event.value) && !eventIsOver(event.value));

// Link an existing event
const linkTarget = ref('');
const linkable = computed(() =>
  visibleEvents.value.filter((e) => e.id !== currentId.value && (!e.seriesId || e.seriesId !== event.value?.seriesId)),
);

async function guard(work: () => Promise<void>): Promise<void> {
  error.value = null;
  busy.value = true;
  try {
    await work();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Something went wrong.';
  } finally {
    busy.value = false;
  }
}
const saveLabel = () => guard(() => setEditionLabel(currentId.value, editLabel.value));
const unlink = () => guard(() => unlinkFromSeries(currentId.value));
const link = () =>
  guard(async () => {
    // The picked event is the anchor: this event joins its series.
    await linkToSeries(currentId.value, linkTarget.value, label.value);
    linkTarget.value = '';
  });
const create = () =>
  guard(async () => {
    const created = await createNextEdition(currentId.value, { label: next.value.label, dateStart: next.value.dateStart, dateEnd: next.value.dateEnd, stock: next.value.stock });
    next.value = { label: '', dateStart: '', dateEnd: '', stock: 'none' };
    currentId.value = created.id;
  });
</script>

<template>
  <ModalShell :title="`${event?.name ?? 'Event'} - editions`" @close="emit('close')">
    <div v-if="event" class="series">
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <section v-if="event.seriesId">
        <h3>Editions</h3>
        <ul class="editions">
          <li v-for="e in editions" :key="e.id" :class="{ here: e.id === currentId }">
            <span class="ed"><strong>{{ editionLabelOf(e) || e.name }}</strong> <span class="when">{{ fmtDates(e) }}</span></span>
            <button v-if="e.id !== currentId" type="button" @click="currentId = e.id">Switch</button>
            <span v-else class="pill">viewing</span>
          </li>
        </ul>
        <div class="row">
          <button type="button" @click="emit('planner', currentId)">Prep planner</button>
          <template v-if="canEdit">
            <input v-model="editLabel" type="text" placeholder="Edition label" aria-label="Edition label" />
            <button type="button" :disabled="busy || editLabel.trim() === (event.edition ?? '')" @click="saveLabel">Rename</button>
            <button type="button" :disabled="busy" @click="unlink">Leave series</button>
          </template>
        </div>
      </section>
      <p v-else class="hint">This event is a one-off. Create a next edition or link it to an earlier one to start a series.</p>

      <section v-if="canEdit">
        <h3>Create next edition</h3>
        <p class="hint">Copies the venue, currency, local prices, VAT and notes. Dates, label and (optionally) stock claims are for the new edition; customs paperwork and files stay with this one.</p>
        <label><span>Dates</span><DateRangePicker v-model:start="next.dateStart" v-model:end="next.dateEnd" /></label>
        <label>
          <span>Edition label</span>
          <input v-model="next.label" type="text" placeholder="2027 or Spring 2027" />
        </label>
        <div v-if="suggestions.length" class="chips">
          <button v-for="s in suggestions" :key="s" type="button" class="chip" @click="next.label = s">{{ s }}</button>
        </div>
        <div class="choice">
          <label class="radio"><input v-model="next.stock" type="radio" value="none" /> Start with no claims</label>
          <label class="radio"><input v-model="next.stock" type="radio" value="same" /> Same claims as this edition</label>
        </div>
        <p v-if="next.stock === 'same' && sourceRunning" class="warn">This edition is still running, so its claims keep reserving stock and the same items are held twice until it is over.</p>
        <div class="row"><button type="button" class="primary" :disabled="busy || !next.label.trim()" @click="create">Create next edition</button></div>
      </section>

      <section v-if="canEdit && !event.seriesId">
        <h3>Link to an existing event</h3>
        <label>
          <span>Same convention as</span>
          <select v-model="linkTarget">
            <option value="">- pick an event -</option>
            <option v-for="e in linkable" :key="e.id" :value="e.id">{{ e.name }}{{ editionLabelOf(e) ? ` (${editionLabelOf(e)})` : '' }}</option>
          </select>
        </label>
        <label><span>This event's edition label</span><input v-model="label" type="text" :placeholder="editionLabelOf(event) || '2027 or Spring 2027'" /></label>
        <div class="row"><button type="button" :disabled="busy || !linkTarget" @click="link">Link</button></div>
      </section>
    </div>
    <p v-else class="hint">That event is no longer available.</p>
  </ModalShell>
</template>

<style scoped>
.series { display: flex; flex-direction: column; gap: 1rem; }
section { display: flex; flex-direction: column; gap: .6rem; }
h3 { margin: 0; font-size: .95rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .82rem; }
.warn { color: var(--zfy-warning-ink, #8a5a1e); font-size: .82rem; margin: 0; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.editions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
.editions li { display: flex; align-items: center; justify-content: space-between; gap: .6rem; padding: .45rem .7rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; }
.editions li.here { border-color: var(--zfy-accent, #0e7c66); }
.when { color: var(--zfy-muted, #5a6472); font-size: .8rem; font-variant-numeric: tabular-nums; }
.pill { font-size: .66rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; border-radius: 999px; padding: .15rem .5rem; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.row input { flex: 1; min-width: 8rem; }
.chips { display: flex; flex-wrap: wrap; gap: .4rem; }
.chip { min-height: 2rem; padding: .1rem .7rem; border-radius: 999px; font-size: .8rem; }
.choice { display: flex; gap: 1rem; flex-wrap: wrap; }
.radio { flex-direction: row; align-items: center; gap: .4rem; }
</style>
