<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { BOOTH_LAYOUT_MAX_BYTES, parseBoothLayout, sanitizeBoothLayout, summarizeBoothLayout } from '@zollify/shared';
import { Icon, ModalShell } from '@zollify/ui';
import {
  copyEventBoothLayout,
  getConfiguratorUrl,
  importEventBoothLayout,
  setConfiguratorUrl,
  setEventBoothLayout,
  shellConfirm,
  visibleEvents,
} from '@zollify/platform';
import BoothPreview from './BoothPreview.vue';

/**
 * An event's booth layout: a design exported from the Cube Studio configurator.
 * Everyone who can see the event reads it; owners and admins import, replace
 * and remove it.
 */
const props = defineProps<{ eventId: string; canEdit: boolean }>();
const emit = defineEmits<{ close: [] }>();

const event = computed(() => visibleEvents.value.find((e) => e.id === props.eventId));
const layout = computed(() => sanitizeBoothLayout(event.value?.boothLayout));
const summary = computed(() => (layout.value ? summarizeBoothLayout(layout.value) : null));
const error = ref<string | null>(null);
const busy = ref(false);
const pasted = ref('');
const picker = ref<HTMLInputElement | null>(null);
const copyFrom = ref('');
const configuratorUrl = ref('');
const urlDraft = ref('');
const editingUrl = ref(false);

onMounted(async () => {
  configuratorUrl.value = await getConfiguratorUrl().catch(() => '');
  urlDraft.value = configuratorUrl.value;
});

/** Other events that already have a layout, newest first. */
const sources = computed(() => visibleEvents.value.filter((e) => e.id !== props.eventId && sanitizeBoothLayout(e.boothLayout)));

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

/** Replacing a layout throws the old one away for everyone, so that is confirmed. */
const okToReplace = async (): Promise<boolean> =>
  !layout.value || shellConfirm('The current layout is replaced for everyone on this event.', 'Replace layout?');

async function importText(text: string, fileName?: string): Promise<void> {
  // Check before asking, so a bad file never costs a confirmation.
  const parsed = parseBoothLayout(text, { fileName });
  if (!parsed.ok) {
    error.value = parsed.error;
    return;
  }
  if (!(await okToReplace())) return;
  await guard(async () => {
    await importEventBoothLayout(props.eventId, text, fileName);
    pasted.value = '';
  });
}

async function onPick(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  error.value = null;
  if (file.size > BOOTH_LAYOUT_MAX_BYTES) {
    error.value = 'That file is too large to be a cube design.';
    return;
  }
  await importText(await file.text(), file.name);
}

const importPasted = () => importText(pasted.value);

async function useFrom(): Promise<void> {
  if (!copyFrom.value || !(await okToReplace())) return;
  await guard(() => copyEventBoothLayout(copyFrom.value, props.eventId));
  copyFrom.value = '';
}

async function remove(): Promise<void> {
  if (!(await shellConfirm('The layout is removed for everyone on this event.', 'Remove layout?'))) return;
  await guard(() => setEventBoothLayout(props.eventId, undefined));
}

const saveUrl = () =>
  guard(async () => {
    configuratorUrl.value = await setConfiguratorUrl(urlDraft.value);
    urlDraft.value = configuratorUrl.value;
    editingUrl.value = false;
  });

const fmtDate = (ms: number): string => (ms ? new Date(ms).toLocaleDateString() : '');
const cm = (n: number): string => `${Math.round(n * 10) / 10}`;
const stillThere = computed(() => Boolean(event.value));
</script>

<template>
  <ModalShell :title="`Booth layout${event ? ' - ' + event.name : ''}`" wide @close="emit('close')">
    <div v-if="!stillThere" class="form"><p class="hint">This event no longer exists.</p></div>
    <div v-else class="form">
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <template v-if="layout && summary">
        <div class="head">
          <div>
            <strong>{{ layout.name }}</strong>
            <p class="hint">
              <template v-if="layout.fileName">{{ layout.fileName }} · </template>added {{ fmtDate(layout.importedAt) }}
            </p>
          </div>
          <div v-if="canEdit" class="row">
            <button type="button" class="quiet danger" :disabled="busy" @click="remove"><Icon name="trash" :size="14" /> Remove</button>
          </div>
        </div>

        <dl class="facts">
          <div><dt>Panels</dt><dd>{{ summary.panels }} <span class="hint">({{ summary.full }} full, {{ summary.half }} half)</span></dd></div>
          <div><dt>Material</dt><dd>{{ summary.mesh }} mesh, {{ summary.plastic }} plastic</dd></div>
          <div>
            <dt>Footprint</dt>
            <dd>{{ cm(summary.footprint.width) }} x {{ cm(summary.footprint.depth) }} cm, {{ cm(summary.footprint.height) }} cm high</dd>
          </div>
          <div><dt>Connectors</dt><dd>{{ summary.connectors }}</dd></div>
        </dl>

        <div class="previews">
          <BoothPreview :layout="layout" view="top" />
          <BoothPreview :layout="layout" view="front" />
        </div>

        <fieldset v-if="summary.parts.length">
          <legend>Parts</legend>
          <ul class="list">
            <li v-for="(p, i) in summary.parts" :key="i">
              <span>{{ p.count }} x {{ cm(p.dims[0]) }} x {{ cm(p.dims[1]) }} cm</span>
              <span class="hint">{{ p.material === 'mesh' ? 'wire mesh' : 'solid plastic' }}</span>
            </li>
          </ul>
        </fieldset>

        <fieldset v-if="summary.products.length">
          <legend>Products</legend>
          <ul class="list">
            <li v-for="(p, i) in summary.products" :key="i">
              <span>{{ p.name }}</span>
              <span class="hint">{{ cm(p.width) }} x {{ cm(p.height) }} x {{ cm(p.depth) }} cm</span>
            </li>
          </ul>
        </fieldset>
      </template>
      <p v-else class="hint">{{ canEdit ? 'No layout yet. Export your design from the cube configurator as JSON and add it here.' : 'No layout for this event.' }}</p>

      <fieldset v-if="canEdit">
        <legend>{{ layout ? 'Replace layout' : 'Add layout' }}</legend>
        <input ref="picker" type="file" hidden accept=".json,application/json" @change="onPick" />
        <div class="row">
          <button type="button" :disabled="busy" @click="picker?.click()"><Icon name="upload" :size="14" /> Choose design file</button>
          <a v-if="configuratorUrl" class="btn" :href="configuratorUrl" target="_blank" rel="noopener noreferrer"><Icon name="external-link" :size="14" /> Open configurator</a>
        </div>
        <label>
          <span>Or paste the design JSON</span>
          <textarea v-model="pasted" rows="3" spellcheck="false" placeholder='{"schema":"cube-studio","version":2,...}' />
        </label>
        <div class="row">
          <button type="button" :disabled="busy || !pasted.trim()" @click="importPasted">Use pasted design</button>
        </div>
        <div v-if="sources.length" class="row">
          <label class="inline">
            <span>Use layout from</span>
            <select v-model="copyFrom">
              <option value="">Choose an event</option>
              <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </label>
          <button type="button" :disabled="busy || !copyFrom" @click="useFrom">Copy</button>
        </div>
      </fieldset>

      <div v-if="canEdit" class="row link">
        <template v-if="!editingUrl">
          <span class="hint">Configurator link: {{ configuratorUrl || 'not set' }}</span>
          <button type="button" class="quiet" @click="editingUrl = true">{{ configuratorUrl ? 'Change' : 'Set link' }}</button>
        </template>
        <template v-else>
          <input v-model="urlDraft" type="url" inputmode="url" placeholder="https://you.github.io/cube-configurator/" aria-label="Configurator link" />
          <button type="button" class="primary" :disabled="busy" @click="saveUrl">Save</button>
          <button type="button" class="quiet" @click="editingUrl = false">Cancel</button>
        </template>
      </div>
      <a v-else-if="configuratorUrl" class="btn open" :href="configuratorUrl" target="_blank" rel="noopener noreferrer"><Icon name="external-link" :size="14" /> Open configurator</a>
    </div>
    <template #footer>
      <div class="footer"><button type="button" @click="emit('close')">Close</button></div>
    </template>
  </ModalShell>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: .8rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label.inline { flex-direction: row; align-items: center; gap: .5rem; }
textarea { font: inherit; resize: vertical; font-family: ui-monospace, monospace; font-size: .75rem; }
.row { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.row button, .btn { display: inline-flex; align-items: center; gap: .3rem; min-height: 2.2rem; }
.row input[type='url'] { flex: 1; min-width: 12rem; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: .6rem; flex-wrap: wrap; }
.head p { margin: .1rem 0 0; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .82rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .5rem .9rem; margin: 0; }
.facts div { display: flex; flex-direction: column; }
.facts dt { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.facts dd { margin: 0; font-size: .9rem; }
.previews { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: .8rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .6rem; }
legend { font-size: .8rem; font-weight: 600; padding: 0 .3rem; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.list li { display: flex; justify-content: space-between; gap: .6rem; }
.link { font-size: .82rem; }
.open { align-self: flex-start; }
.footer { display: flex; justify-content: flex-end; }
</style>
