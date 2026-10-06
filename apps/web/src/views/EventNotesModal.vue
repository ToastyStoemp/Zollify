<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { EVENT_FILE_MAX_BYTES, EVENT_NOTES_MAX_CHARS, formatFileSize, type EventAttachment } from '@zollify/shared';
import { Icon, ModalShell } from '@zollify/ui';
import {
  addEventFile,
  eventFileBlob,
  eventFileCached,
  getSalesEvent,
  openFileBlob,
  removeEventFile,
  retryEventFileUploads,
  saveFile,
  setEventNotes,
  shellConfirm,
  visibleEvents,
} from '@zollify/platform';

/**
 * An event's notes and files: setup times, the stand number, the organiser's
 * schedule, PDF tickets. Everyone who can see the event reads them - a helper
 * included - and owners and admins edit.
 */
const props = defineProps<{ eventId: string; canEdit: boolean }>();
const emit = defineEmits<{ close: [] }>();

const event = computed(() => visibleEvents.value.find((e) => e.id === props.eventId));
const notes = ref(event.value?.notes ?? '');
const savedNotes = ref(notes.value);
const dirty = computed(() => notes.value !== savedNotes.value);
const error = ref<string | null>(null);
const busy = ref(false);
const waiting = ref(0);
/** Which files this device can open without a connection. */
const offline = ref(new Set<string>());
const picker = ref<HTMLInputElement | null>(null);

const attachments = computed<EventAttachment[]>(() => event.value?.attachments ?? []);

async function refreshCache(): Promise<void> {
  const have = new Set<string>();
  for (const a of attachments.value) if (await eventFileCached(a.id)) have.add(a.id);
  offline.value = have;
}
watch(attachments, refreshCache);
onMounted(async () => {
  await refreshCache();
  // Files attached while offline go up as soon as someone looks at them again.
  if (props.canEdit) waiting.value = await retryEventFileUploads();
});

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

const saveNotes = () =>
  guard(async () => {
    await setEventNotes(props.eventId, notes.value);
    savedNotes.value = notes.value;
  });

async function onPick(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  for (const file of files) {
    await guard(async () => {
      await addEventFile(props.eventId, file);
    });
    if (error.value) break;
  }
  await refreshCache();
  waiting.value = await retryEventFileUploads();
}

const open = (a: EventAttachment) =>
  guard(async () => {
    const blob = await eventFileBlob(props.eventId, a);
    await refreshCache();
    if (!(await openFileBlob(a.name, blob, a.mime))) await saveFile(a.name, blob, a.mime);
  });
const download = (a: EventAttachment) =>
  guard(async () => {
    await saveFile(a.name, await eventFileBlob(props.eventId, a), a.mime);
    await refreshCache();
  });
async function remove(a: EventAttachment): Promise<void> {
  if (!(await shellConfirm(`“${a.name}” is removed for everyone on this event.`, 'Remove file?'))) return;
  await guard(() => removeEventFile(props.eventId, a.id));
}

/** Closing with unsaved notes would lose them silently. */
async function close(): Promise<void> {
  if (dirty.value && !(await shellConfirm('Your changes to the notes have not been saved.', 'Discard changes?'))) return;
  emit('close');
}
const stillThere = computed(() => Boolean(getSalesEvent(props.eventId)));
</script>

<template>
  <ModalShell :title="`Notes & files${event ? ' - ' + event.name : ''}`" wide @close="close">
    <div v-if="!stillThere" class="form"><p class="hint">This event no longer exists.</p></div>
    <div v-else class="form">
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <label>
        <span>Notes</span>
        <textarea
          v-model="notes"
          rows="8"
          :readonly="!canEdit"
          :maxlength="EVENT_NOTES_MAX_CHARS"
          :placeholder="canEdit ? 'Setup Friday 14:00, stand B12, ask for Marie at the loading dock…' : 'No notes for this event.'"
        />
      </label>
      <div v-if="canEdit" class="row">
        <button type="button" class="primary" :disabled="!dirty || busy" @click="saveNotes">Save notes</button>
        <span v-if="dirty" class="hint">Not saved yet.</span>
      </div>

      <fieldset>
        <legend>Files</legend>
        <p v-if="!attachments.length" class="hint">{{ canEdit ? 'Add tickets, floor plans or the organiser’s schedule.' : 'No files attached.' }}</p>
        <ul v-else class="files">
          <li v-for="a in attachments" :key="a.id">
            <button type="button" class="name" :disabled="busy" @click="open(a)">
              <Icon name="file-text" :size="16" />
              <span>{{ a.name }}</span>
            </button>
            <span class="meta">{{ formatFileSize(a.size) }}<template v-if="offline.has(a.id)"> · on this device</template></span>
            <button type="button" class="quiet" :disabled="busy" aria-label="Download" @click="download(a)"><Icon name="download" :size="14" /></button>
            <button v-if="canEdit" type="button" class="quiet danger" :disabled="busy" aria-label="Remove" @click="remove(a)"><Icon name="trash" :size="14" /></button>
          </li>
        </ul>
        <template v-if="canEdit">
          <input ref="picker" type="file" multiple hidden accept=".pdf,.pkpass,.png,.jpg,.jpeg,.webp,.gif,.heic,.txt,.csv,.docx,.xlsx,application/pdf,image/*" @change="onPick" />
          <div class="row">
            <button type="button" :disabled="busy" @click="picker?.click()"><Icon name="paperclip" :size="14" /> {{ busy ? 'Working…' : 'Attach files' }}</button>
            <span class="hint">PDF, pictures or documents, up to {{ EVENT_FILE_MAX_BYTES / 1024 / 1024 }} MB each.</span>
          </div>
          <p v-if="waiting" class="warn">{{ waiting }} file{{ waiting === 1 ? '' : 's' }} will reach the other devices once this one is back online.</p>
        </template>
      </fieldset>
    </div>
    <template #footer>
      <div class="footer"><button type="button" @click="close">Close</button></div>
    </template>
  </ModalShell>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: .8rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
textarea { font: inherit; resize: vertical; min-height: 6rem; }
.row { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.row button { display: inline-flex; align-items: center; gap: .3rem; min-height: 2.2rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .82rem; }
.warn { color: var(--zfy-warning-ink, #8a5a1e); margin: 0; font-size: .82rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .6rem; }
legend { font-size: .8rem; font-weight: 600; padding: 0 .3rem; }
.files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
.files li { display: flex; align-items: center; gap: .5rem; }
.name { flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: .4rem; justify-content: flex-start; text-align: left; min-height: 2.2rem; }
.name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { font-size: .75rem; color: var(--zfy-muted, #5a6472); white-space: nowrap; }
.files .quiet { min-height: 2rem; padding: .2rem .45rem; }
.footer { display: flex; justify-content: flex-end; }
</style>
