<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { SalesEvent } from '@zollify/shared';
import { editionLabelOf, fmtDayRange, isStore, suggestEditionLabels } from '@zollify/shared';
import { DateRangePicker, Icon, ModalShell } from '@zollify/ui';
import {
  activeEventId,
  claimsForEvent,
  createNextEdition,
  deleteSalesEvent,
  editionsOf,
  eventIsOver,
  linkToSeries,
  removeAllEventFiles,
  setEditionLabel,
  shellConfirm,
  unlinkFromSeries,
  visibleEvents,
} from '@zollify/platform';

/**
 * The editions of one convention: Comic Con 2025, Comic Con 2026, the fall
 * run after the spring one. Each edition is an ordinary event on the Events
 * page; this sheet is where they are listed together, where the next one is
 * made as a copy, where an event made separately joins the series, and
 * where one is renamed, taken out again or deleted.
 *
 * Editing an edition's details (dates, venue, VAT...) is the normal event
 * editor, so "Edit details" hands the edition back to the Events page.
 */
const props = defineProps<{ eventId: string; canEdit: boolean }>();
const emit = defineEmits<{ close: []; planner: [eventId: string]; edit: [eventId: string] }>();

/** The event this sheet was opened from. */
const event = computed(() => visibleEvents.value.find((e) => e.id === props.eventId));
const editions = computed(() => editionsOf(props.eventId));
/** The edition whose actions are open, if any. */
const openId = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

const fmtDates = (e: SalesEvent): string => fmtDayRange(e.dateStart, e.dateEnd) || 'No dates yet';
const labelOf = (e: SalesEvent): string => editionLabelOf(e) || e.name;
function state(e: SalesEvent): string {
  if (e.id === activeEventId.value) return 'Selling now';
  if (e.status === 'closed') return 'Finished';
  if (e.status === 'active') return 'Open';
  return eventIsOver(e) ? 'Ended' : 'Upcoming';
}

// ── Rename ──────────────────────────────────────────────────────────────────
const renaming = ref<string | null>(null);
const renameTo = ref('');
function startRename(e: SalesEvent): void {
  renaming.value = e.id;
  renameTo.value = e.edition ?? editionLabelOf(e);
}
const saveRename = () =>
  guard(async () => {
    if (!renaming.value) return;
    await setEditionLabel(renaming.value, renameTo.value);
    renaming.value = null;
  });

// ── Take out / delete ───────────────────────────────────────────────────────
async function takeOut(e: SalesEvent): Promise<void> {
  await guard(async () => {
    await unlinkFromSeries(e.id);
    notice.value = `${labelOf(e)} is a separate event again. Nothing else changed.`;
    openId.value = null;
  });
}
async function destroy(e: SalesEvent): Promise<void> {
  const ok = await shellConfirm(
    `"${e.name}${e.edition ? ` ${e.edition}` : ''}" disappears from every device. Recorded sales are kept in History under "Removed event", but its claims and customs details go with it. The other editions stay.`,
    'Delete this edition?',
  );
  if (!ok) return;
  await guard(async () => {
    await removeAllEventFiles(e);
    await deleteSalesEvent(e.id);
    notice.value = `Deleted ${labelOf(e)}.`;
    openId.value = null;
  });
}

// ── Add an edition ──────────────────────────────────────────────────────────
type Mode = 'copy' | 'link';
const mode = ref<Mode>('copy');
/** The edition the new one is copied from: the latest by date, so the next one follows on from it. */
const copyFrom = ref(props.eventId);
const source = computed(() => editions.value.find((e) => e.id === copyFrom.value) ?? event.value);
watch(editions, (list) => {
  if (!list.some((e) => e.id === copyFrom.value)) copyFrom.value = props.eventId;
});

const next = ref({ label: '', dateStart: '', dateEnd: '', stock: 'none' as 'none' | 'same' });
const suggestions = computed(() => (source.value ? suggestEditionLabels(source.value, next.value.dateStart) : []));
let lastAuto = '';
watch(
  [source, () => next.value.dateStart],
  () => {
    // Follow the suggestion until the person has typed a label of their own.
    if (!next.value.label || suggestions.value.includes(next.value.label) || next.value.label === lastAuto) {
      lastAuto = suggestions.value[0] ?? '';
      next.value.label = lastAuto;
    }
  },
  { immediate: true },
);
const sourceRunning = computed(() => Boolean(source.value) && !eventIsOver(source.value));
const sourceHasClaims = computed(() => Boolean(source.value) && claimsForEvent(source.value!.id).length > 0);
const create = () =>
  guard(async () => {
    if (!source.value) return;
    const created = await createNextEdition(source.value.id, { label: next.value.label, dateStart: next.value.dateStart, dateEnd: next.value.dateEnd, stock: next.value.stock });
    notice.value = `${created.name} ${created.edition} is on the Events page as Upcoming${next.value.dateStart ? '' : ' - add its dates when you know them'}.`;
    next.value = { label: '', dateStart: '', dateEnd: '', stock: 'none' };
    lastAuto = '';
    openId.value = created.id;
  });

// Link an event made separately - it joins this series, whichever edition the sheet was opened from.
const linkTarget = ref('');
const linkLabel = ref('');
const linkable = computed(() => visibleEvents.value.filter((e) => e.id !== props.eventId && !e.seriesId && !isStore(e)));
const linkPick = computed(() => linkable.value.find((e) => e.id === linkTarget.value));
const link = () =>
  guard(async () => {
    if (!linkPick.value) return;
    const joined = linkPick.value;
    await linkToSeries(joined.id, props.eventId, linkLabel.value);
    notice.value = `${joined.name} is now the ${linkLabel.value.trim() || editionLabelOf(joined) || 'linked'} edition.`;
    linkTarget.value = '';
    linkLabel.value = '';
    openId.value = joined.id;
  });

async function guard(work: () => Promise<void>): Promise<void> {
  error.value = null;
  notice.value = null;
  busy.value = true;
  try {
    await work();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Something went wrong.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ModalShell :title="`${event?.name ?? 'Event'} - editions`" @close="emit('close')">
    <div v-if="event" class="series">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" class="ok" role="status">{{ notice }}</p>

      <section v-if="editions.length > 1">
        <p class="hint">Editions are the same convention in different years or seasons. Each is its own event; linking them lets the prep planner use earlier editions' sales. Tap one for its actions.</p>
        <ul class="editions">
          <li v-for="e in editions" :key="e.id" :class="{ here: e.id === eventId, open: e.id === openId }">
            <button type="button" class="edrow" :aria-expanded="e.id === openId" @click="openId = openId === e.id ? null : e.id">
              <span class="ed"><strong>{{ labelOf(e) }}</strong><span class="when">{{ fmtDates(e) }}</span></span>
              <span class="pill">{{ state(e) }}</span>
              <Icon :name="openId === e.id ? 'chevron-up' : 'chevron-down'" :size="14" />
            </button>
            <div v-if="openId === e.id" class="acts">
              <form v-if="renaming === e.id" class="rename" @submit.prevent="saveRename">
                <input v-model="renameTo" type="text" aria-label="Edition label" placeholder="2027 or Spring 2027" />
                <button type="submit" class="primary" :disabled="busy">Save</button>
                <button type="button" :disabled="busy" @click="renaming = null">Cancel</button>
              </form>
              <template v-else>
                <button v-if="canEdit" type="button" @click="emit('edit', e.id)"><Icon name="settings" :size="14" /> Edit details</button>
                <button v-if="canEdit" type="button" @click="startRename(e)"><Icon name="tag" :size="14" /> Rename</button>
                <button type="button" @click="emit('planner', e.id)"><Icon name="layers" :size="14" /> Prep planner</button>
                <button v-if="canEdit" type="button" :disabled="busy" @click="takeOut(e)"><Icon name="x" :size="14" /> Take out of the series</button>
                <button v-if="canEdit && e.status !== 'active'" type="button" class="danger" :disabled="busy" @click="destroy(e)"><Icon name="trash" :size="14" /> Delete</button>
                <small v-else-if="canEdit" class="hint">Close it on the Events page before deleting it.</small>
              </template>
            </div>
          </li>
        </ul>
      </section>
      <section v-else>
        <p class="hint">
          <strong>{{ event.name }}</strong> is on its own so far. Editions are the same convention in different years or seasons - make next year's as a copy below, or link an event you already made. Each edition stays its own event on the Events page; linking them lets the prep planner use earlier editions' sales.
        </p>
      </section>

      <section v-if="canEdit" class="add">
        <div class="tabs" role="tablist">
          <button type="button" role="tab" :aria-selected="mode === 'copy'" :class="{ on: mode === 'copy' }" @click="mode = 'copy'">New edition</button>
          <button type="button" role="tab" :aria-selected="mode === 'link'" :class="{ on: mode === 'link' }" :disabled="!linkable.length" @click="mode = 'link'">Link an existing event</button>
        </div>

        <template v-if="mode === 'copy'">
          <p class="hint">
            A new event for the next time {{ event.name }} runs. Venue, currency, prices, VAT and notes are copied from the edition you pick; dates and stock start fresh. Files and customs papers stay with the old one.
          </p>
          <label v-if="editions.length > 1">
            <span>Copy from</span>
            <select v-model="copyFrom">
              <option v-for="e in editions" :key="e.id" :value="e.id">{{ labelOf(e) }} · {{ fmtDates(e) }}</option>
            </select>
          </label>
          <label>
            <span>Edition name</span>
            <input v-model="next.label" type="text" placeholder="2027 or Spring 2027" aria-label="New edition name" />
            <small>Shown next to the event name - {{ event.name }} <em>{{ next.label.trim() || '2027' }}</em>.</small>
          </label>
          <div v-if="suggestions.length > 1" class="chips">
            <button v-for="s in suggestions" :key="s" type="button" class="chip" @click="next.label = s">{{ s }}</button>
          </div>
          <label><span>Dates <small>(can wait)</small></span><DateRangePicker v-model:start="next.dateStart" v-model:end="next.dateEnd" /></label>
          <fieldset v-if="sourceHasClaims" class="choice">
            <legend>Stock to bring</legend>
            <label class="radio"><input v-model="next.stock" type="radio" value="none" /> Decide later (the prep planner can suggest it)</label>
            <label class="radio"><input v-model="next.stock" type="radio" value="same" /> Claim the same items as {{ source ? labelOf(source) : 'this edition' }}</label>
          </fieldset>
          <p v-if="next.stock === 'same' && sourceRunning" class="warn">{{ source ? labelOf(source) : 'That edition' }} is still running, so the same items would be held for both until it is over.</p>
          <div class="row"><button type="button" class="primary" :disabled="busy || !next.label.trim()" @click="create">Create {{ event.name }} {{ next.label.trim() }}</button></div>
        </template>

        <template v-else>
          <p class="hint">Already made the event for another year? Pick it and it joins {{ event.name }}'s editions. Nothing about it changes except the edition name.</p>
          <label>
            <span>Event</span>
            <select v-model="linkTarget">
              <option value="">- pick an event -</option>
              <option v-for="e in linkable" :key="e.id" :value="e.id">{{ e.name }} · {{ fmtDates(e) }}</option>
            </select>
          </label>
          <label v-if="linkPick">
            <span>Its edition name</span>
            <input v-model="linkLabel" type="text" :placeholder="editionLabelOf(linkPick) || '2025 or Spring 2025'" />
            <small v-if="!linkLabel.trim() && editionLabelOf(linkPick)">Left blank, it is called {{ editionLabelOf(linkPick) }} after its dates.</small>
          </label>
          <div class="row"><button type="button" class="primary" :disabled="busy || !linkPick" @click="link">Add {{ linkPick ? linkPick.name : 'it' }} as an edition</button></div>
        </template>
      </section>
    </div>
    <p v-else class="hint">That event is no longer available.</p>
  </ModalShell>
</template>

<style scoped>
.series { display: flex; flex-direction: column; gap: 1rem; }
section { display: flex; flex-direction: column; gap: .6rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .82rem; }
.hint strong { color: var(--zfy-ink); }
.warn { color: var(--zfy-warning-ink, #8a5a1e); font-size: .82rem; margin: 0; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.ok { color: var(--zfy-success, #0e7c66); margin: 0; font-size: .85rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label > small { color: var(--zfy-muted); font-size: .76rem; }
label > span small { color: var(--zfy-muted); font-weight: 400; }
label em { font-style: normal; font-size: .72rem; padding: .05rem .4rem; border-radius: 999px; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.editions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
.editions li { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; overflow: hidden; }
.editions li.here { border-color: var(--zfy-accent, #0e7c66); }
.editions .edrow { display: flex; align-items: center; gap: .6rem; width: 100%; min-height: 0; padding: .55rem .7rem; border: 0; border-radius: 0; background: none; text-align: left; color: inherit; font: inherit; cursor: pointer; }
.editions .edrow:hover { background: var(--zfy-surface-2); }
.ed { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.when { color: var(--zfy-muted, #5a6472); font-size: .8rem; font-variant-numeric: tabular-nums; }
.pill { flex: none; font-size: .66rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; border-radius: 999px; padding: .15rem .5rem; background: var(--zfy-surface-2, #eef1f4); color: var(--zfy-muted, #5a6472); }
.acts { display: flex; flex-wrap: wrap; gap: .4rem; padding: .5rem .7rem .7rem; border-top: 1px solid var(--zfy-line, #d6dde4); background: var(--zfy-surface-2); }
.acts button { font-size: .82rem; }
.acts .hint { flex-basis: 100%; }
.rename { display: flex; flex-wrap: wrap; gap: .4rem; width: 100%; }
.rename input { flex: 1; min-width: 8rem; }
.tabs { display: flex; gap: .3rem; border-bottom: 1px solid var(--zfy-line); }
.tabs button { min-height: 0; padding: .45rem .7rem; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--zfy-muted); font-size: .875rem; margin-bottom: -1px; }
.tabs button.on { color: var(--zfy-ink); border-bottom-color: var(--zfy-accent, #0e7c66); font-weight: 600; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.chips { display: flex; flex-wrap: wrap; gap: .4rem; }
.chip { min-height: 2rem; padding: .1rem .7rem; border-radius: 999px; font-size: .8rem; }
.choice { display: flex; flex-direction: column; gap: .35rem; margin: 0; padding: .6rem .8rem; border: 1px solid var(--zfy-line); border-radius: 10px; }
.choice legend { font-size: .82rem; font-weight: 600; padding: 0 .3rem; }
.radio { flex-direction: row; align-items: center; gap: .4rem; }
</style>
