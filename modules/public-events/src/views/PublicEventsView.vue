<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  DEFAULT_BIO_TEMPLATE,
  EventOverlaySchema,
  PublicEventsConfigSchema,
  type EventOverlay,
  type PublicEventsConfig,
} from '@zollify/shared';
import { api, type Preview } from '../api';
import { sdk } from '../runtime';

/**
 * Publishing settings, the addresses to hand out, and per-event extras. The
 * preview on the right is the server's own view, so what the booth checks
 * here is exactly what a visitor gets.
 */

const config = ref<PublicEventsConfig>(PublicEventsConfigSchema.parse({}));
const overlays = ref<Record<string, EventOverlay>>({});
const preview = ref<Preview | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const saved = ref<string | null>(null);
const copied = ref<string | null>(null);

const events = computed(() =>
  [...sdk().data.events.list()].sort((a, b) => (b.dateStart ?? '').localeCompare(a.dateStart ?? '')),
);
const suggestedSlug = computed(() =>
  (sdk().account()?.accountName ?? 'booth')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40),
);

const base = computed(() => preview.value?.base ?? null);
const embedSnippet = computed(() =>
  base.value
    ? `<div id="zollify-events" data-limit="6"></div>\n<script src="${base.value}/embed.js" async><\/script>`
    : '',
);

async function load(): Promise<void> {
  error.value = null;
  try {
    const [cfg, pv] = await Promise.all([api.config(), api.preview()]);
    config.value = cfg.config;
    overlays.value = cfg.overlays;
    preview.value = pv;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the public page settings.';
  }
}
onMounted(load);

function flash(what: string): void {
  saved.value = what;
  setTimeout(() => (saved.value = null), 2000);
}

async function saveConfig(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const parsed = PublicEventsConfigSchema.safeParse({ ...config.value, slug: config.value.slug || null });
    if (!parsed.success) {
      error.value = parsed.error.issues[0]?.message ?? 'Check the settings.';
      return;
    }
    const res = await api.saveConfig(parsed.data);
    config.value = res.config;
    preview.value = await api.preview();
    flash('settings');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save.';
  } finally {
    busy.value = false;
  }
}

function overlayFor(eventId: string): EventOverlay {
  return (overlays.value[eventId] ??= EventOverlaySchema.parse({}));
}

async function saveOverlay(eventId: string): Promise<void> {
  error.value = null;
  try {
    await api.saveOverlay(eventId, overlayFor(eventId));
    preview.value = await api.preview();
    flash(eventId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save those details.';
  }
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = what;
    setTimeout(() => (copied.value = null), 1500);
  } catch {
    error.value = 'Could not copy - select the text and copy it by hand.';
  }
}
</script>

<template>
  <section class="pub">
    <header>
      <h1>Public page</h1>
      <p class="lede">
        Your events, published for visitors: a page, a widget for your shop, a calendar they can
        subscribe to, and a bio line for Instagram. All of it updates by itself when you edit an event.
      </p>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div class="layout">
      <div class="col">
        <!-- ── Publish ─────────────────────────────────────────────────── -->
        <form class="card" @submit.prevent="saveConfig">
          <h2>Publish</h2>
          <label>
            <span>Address</span>
            <span class="slug">
              <span class="prefix">…/p/public-events/</span>
              <input
                v-model="config.slug"
                type="text"
                :placeholder="suggestedSlug"
                pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
                autocapitalize="off"
                spellcheck="false"
              />
            </span>
            <small>Letters, digits and dashes. Leave it blank to unpublish.</small>
          </label>
          <div class="grid">
            <label>
              <span>Name on the page</span>
              <input v-model="config.orgName" type="text" :placeholder="sdk().account()?.accountName" />
            </label>
            <label>
              <span>Tagline</span>
              <input v-model="config.tagline" type="text" />
            </label>
          </div>
          <div class="row">
            <label class="inline"><input v-model="config.showPast" type="checkbox" /> <span>Show past events</span></label>
            <label class="inline">
              <span>at most</span>
              <input v-model.number="config.pastLimit" type="number" min="0" max="100" class="short" />
            </label>
          </div>
          <div class="actions">
            <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Saving…' : 'Save' }}</button>
            <span v-if="saved === 'settings'" class="ok" role="status">Saved.</span>
          </div>
        </form>

        <!-- ── Share ───────────────────────────────────────────────────── -->
        <div class="card">
          <h2>Share</h2>
          <p v-if="!base" class="hint">Choose an address above and save to get your links.</p>
          <template v-else>
            <dl class="links">
              <dt>Page</dt>
              <dd><a :href="base" target="_blank" rel="noopener">{{ base }}</a></dd>
              <dt>Calendar</dt>
              <dd>
                <code>{{ base }}/events.ics</code>
                <button type="button" class="quiet" @click="copy(`${base}/events.ics`, 'ics')">
                  {{ copied === 'ics' ? 'Copied' : 'Copy' }}
                </button>
              </dd>
              <dt>Instagram</dt>
              <dd><code>{{ base }}/instagram.txt</code></dd>
            </dl>

            <h3>Widget for your shop</h3>
            <p class="hint">
              Paste this where the events should appear - a Shopify page or section, or any site.
              <code>data-limit</code> caps how many show; <code>data-heading</code> changes the title.
            </p>
            <pre class="snippet">{{ embedSnippet }}</pre>
            <button type="button" @click="copy(embedSnippet, 'embed')">
              {{ copied === 'embed' ? 'Copied' : 'Copy widget code' }}
            </button>
          </template>
        </div>

        <!-- ── Instagram ───────────────────────────────────────────────── -->
        <form class="card" @submit.prevent="saveConfig">
          <h2>Instagram bio</h2>
          <p class="hint">
            Instagram has no way to set this for you, so Zollify writes it and you paste it.
            <code>{event}</code> becomes a line like <em>@animemesse, hall 3 booth 5823, 17-19th July</em>
            for the current or next event; <code>{event_name}</code>, <code>{event_dates}</code>,
            <code>{event_city}</code>, <code>{event_booth}</code> are available too.
          </p>
          <label>
            <span>Template</span>
            <textarea v-model="config.igTemplate" rows="4" :placeholder="DEFAULT_BIO_TEMPLATE"></textarea>
          </label>
          <label>
            <span>When nothing is coming up, <code>{event}</code> becomes</span>
            <input v-model="config.igFallback" type="text" placeholder="Next dates soon" />
          </label>
          <div class="actions">
            <button type="submit" class="primary" :disabled="busy">Save</button>
            <button v-if="preview?.bio" type="button" @click="copy(preview.bio, 'bio')">
              {{ copied === 'bio' ? 'Copied' : 'Copy bio' }}
            </button>
          </div>
          <pre v-if="preview?.bio" class="snippet bio">{{ preview.bio }}</pre>
        </form>
      </div>

      <div class="col">
        <!-- ── Per-event extras ────────────────────────────────────────── -->
        <div class="card">
          <h2>Event details for visitors</h2>
          <p class="hint">
            Hall, booth and a link are not part of the event record, so they live here. An event
            without dates never shows.
          </p>
          <p v-if="!events.length" class="hint">No events yet.</p>
          <details v-for="event in events" :key="event.id" class="event">
            <summary>
              <span class="name">{{ event.name }}</span>
              <span class="when">{{ event.dateStart ?? 'no dates' }}</span>
              <span v-if="overlayFor(event.id).hidden" class="badge">hidden</span>
            </summary>
            <form class="extras" @submit.prevent="saveOverlay(event.id)">
              <div class="grid">
                <label><span>Hall</span><input v-model="overlayFor(event.id).hall" type="text" placeholder="3" /></label>
                <label><span>Booth</span><input v-model="overlayFor(event.id).booth" type="text" placeholder="B-12" /></label>
                <label><span>Instagram handle</span><input v-model="overlayFor(event.id).igHandle" type="text" placeholder="@animemesse" /></label>
                <label><span>Link</span><input v-model="overlayFor(event.id).link" type="url" placeholder="https://…" /></label>
              </div>
              <label><span>Blurb</span><input v-model="overlayFor(event.id).blurb" type="text" placeholder="New prints, limited pins." /></label>
              <div class="actions">
                <label class="inline"><input v-model="overlayFor(event.id).hidden" type="checkbox" /> <span>Hide from the public</span></label>
                <button type="submit" class="primary">Save</button>
                <span v-if="saved === event.id" class="ok" role="status">Saved.</span>
              </div>
            </form>
          </details>
        </div>

        <!-- ── Preview ─────────────────────────────────────────────────── -->
        <div v-if="preview" class="card">
          <h2>What visitors see</h2>
          <p v-if="!preview.upcoming.length" class="hint">No upcoming events right now.</p>
          <ul v-else class="preview">
            <li v-for="ev in preview.upcoming" :key="ev.id">
              <strong>{{ ev.name }}</strong>
              <span v-if="ev.ongoing" class="badge">now</span>
              <span v-else-if="ev.soon" class="badge">soon</span>
              <span class="when">{{ ev.start }}<template v-if="ev.end !== ev.start"> → {{ ev.end }}</template></span>
              <span class="where">
                {{ ev.flag }} {{ [ev.city, ev.country].filter(Boolean).join(', ') }}
                <template v-if="ev.hall || ev.booth"> · {{ [ev.hall && `Hall ${ev.hall}`, ev.booth && `Booth ${ev.booth}`].filter(Boolean).join(' · ') }}</template>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pub { display: flex; flex-direction: column; gap: 1rem; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: 1.05rem; }
h3 { margin: .5rem 0 0; font-size: .95rem; }
.lede, .hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .9rem; max-width: 60ch; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.ok { color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
.layout { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: start; }
.col { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .75rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .75rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label.inline { flex-direction: row; align-items: center; gap: .4rem; }
label small { color: var(--zfy-muted, #5a6472); font-size: .78rem; }
.row { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
.short { width: 5rem; }
.slug { display: flex; align-items: center; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; overflow: hidden; background: var(--zfy-surface-2, #e9edf1); }
.slug .prefix { padding: 0 .5rem; font-size: .8rem; color: var(--zfy-muted, #5a6472); white-space: nowrap; }
.slug input { border: 0; border-radius: 0; flex: 1; min-width: 0; }
.actions { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.links { display: grid; grid-template-columns: 6rem 1fr; gap: .4rem .75rem; margin: 0; font-size: .875rem; align-items: center; }
.links dt { color: var(--zfy-muted, #5a6472); }
.links dd { margin: 0; display: flex; align-items: center; gap: .5rem; min-width: 0; overflow-wrap: anywhere; }
.links a { color: var(--zfy-accent-ink, #0a5a4a); }
code { font-family: ui-monospace, monospace; font-size: .8rem; }
.snippet { margin: 0; padding: .6rem .75rem; border-radius: 8px; background: var(--zfy-surface-2, #e9edf1); font-family: ui-monospace, monospace; font-size: .78rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.snippet.bio { font-family: inherit; font-size: .9rem; }
.event { border-top: 1px solid var(--zfy-line, #d6dde4); padding-top: .5rem; }
.event summary { display: flex; align-items: center; gap: .6rem; cursor: pointer; font-size: .9rem; }
.event .name { font-weight: 600; }
.event .when { color: var(--zfy-muted, #5a6472); font-size: .8rem; font-variant-numeric: tabular-nums; }
.extras { display: flex; flex-direction: column; gap: .6rem; padding: .6rem 0 .3rem; }
.badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; color: var(--zfy-accent-ink, #0a5a4a); background: var(--zfy-accent-soft, #deeee9); border-radius: 999px; padding: .1rem .5rem; }
.preview { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.preview li { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem; font-size: .9rem; }
.preview .when, .preview .where { color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.preview .where { width: 100%; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
</style>
