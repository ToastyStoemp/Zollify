<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Product } from '@zollify/shared';
import { Icon } from '@zollify/ui';
import {
  STORY_PREFIX,
  addPoint,
  emptyStory,
  hasStory,
  movePoint,
  normalizeStory,
  parseHotspots,
  removePoint,
  storyKey,
  toShopifyHotspots,
  updatePoint,
  type PrintStory,
  type StoryPoint,
} from '../engine/story';
import { storyCardsHtml, type CardSize } from '../engine/card';
import { sdk } from '../runtime';

/**
 * Print stories: pick a print, click its picture to drop numbered points of
 * interest, and say what each one shows. Saved as you type, one synced
 * setting per print. The points copy into Shopify's hotspot metafield as
 * they are, and print as story cards for the booth.
 */

const stories = ref<Record<string, PrintStory>>({});
const loaded = ref(false);
const error = ref('');

onMounted(async () => {
  try {
    const raw = await sdk().data.settings.list(STORY_PREFIX);
    const out: Record<string, PrintStory> = {};
    for (const [key, value] of Object.entries(raw)) {
      const id = key.slice(STORY_PREFIX.length);
      if (id) out[id] = normalizeStory(id, value);
    }
    stories.value = out;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not read the stories.';
  } finally {
    loaded.value = true;
  }
});

// ── The print list ──────────────────────────────────────────────────────────

const query = ref('');
const onlyWithStory = ref(false);
const products = computed<Product[]>(() =>
  sdk()
    .data.products.list()
    .filter((p) => !p.deletedAt)
    .sort((a, b) => Number(!!b.imageId) - Number(!!a.imageId) || (a.type || '').localeCompare(b.type || '') || a.title.localeCompare(b.title)),
);
const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return products.value.filter(
    (p) => (!onlyWithStory.value || hasStory(stories.value[p.id])) && (!q || p.title.toLowerCase().includes(q) || (p.type || '').toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q)),
  );
});
const withStory = computed(() => products.value.filter((p) => hasStory(stories.value[p.id])));

const thumbs = ref<Record<string, string | null>>({});
watch(
  shown,
  async (list) => {
    for (const p of list.slice(0, 200)) {
      if (!p.imageId || p.id in thumbs.value) continue;
      thumbs.value = { ...thumbs.value, [p.id]: null };
      const url = await sdk().data.images.url(p.imageId, 'thumb').catch(() => null);
      thumbs.value = { ...thumbs.value, [p.id]: url };
    }
  },
  { immediate: true },
);

// ── The open print ──────────────────────────────────────────────────────────

const currentId = ref<string | null>(null);
const current = computed(() => (currentId.value ? sdk().data.products.get(currentId.value) ?? null : null));
const story = ref<PrintStory>(emptyStory(''));
const selectedId = ref<string | null>(null);
const selected = computed(() => story.value.points.find((p) => p.id === selectedId.value) ?? null);
const selectedNo = computed(() => story.value.points.findIndex((p) => p.id === selectedId.value) + 1);
const picture = ref<string | null>(null);
/** Width over height, once the picture has loaded: sizes the frame so a small thumbnail still fills the space. */
const aspect = ref(0);
const pictureLoading = ref(false);

async function open(p: Product): Promise<void> {
  await flush();
  currentId.value = p.id;
  // A plain copy: the stored one is reactive, and structuredClone refuses a proxy.
  story.value = JSON.parse(JSON.stringify(stories.value[p.id] ?? emptyStory(p.id))) as PrintStory;
  selectedId.value = null;
  importText.value = '';
  importError.value = '';
  picture.value = null;
  aspect.value = 0;
  if (!p.imageId) return;
  pictureLoading.value = true;
  try {
    picture.value = (await sdk().data.images.url(p.imageId, 'full')) ?? (await sdk().data.images.url(p.imageId, 'thumb'));
  } catch {
    picture.value = null;
  } finally {
    pictureLoading.value = false;
  }
}

// ── Saving ──────────────────────────────────────────────────────────────────

const status = ref<'saved' | 'pending' | 'saving' | 'failed' | ''>('');
let timer: ReturnType<typeof setTimeout> | null = null;

function change(next: PrintStory): void {
  story.value = next;
  status.value = 'pending';
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flush(), 600);
}

async function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (status.value !== 'pending') return;
  const s: PrintStory = { ...story.value, updatedAt: Date.now() };
  status.value = 'saving';
  try {
    await sdk().data.settings.set(storyKey(s.productId), s);
    stories.value = { ...stories.value, [s.productId]: s };
    if (status.value === 'saving') status.value = 'saved';
  } catch (err) {
    status.value = 'failed';
    error.value = err instanceof Error ? err.message : 'Could not save the story.';
  }
}
onBeforeUnmount(() => void flush());

const setIntro = (intro: string): void => change({ ...story.value, intro });
function edit(patch: Partial<Omit<StoryPoint, 'id'>>): void {
  if (selectedId.value) change(updatePoint(story.value, selectedId.value, patch));
}
function reorder(by: -1 | 1): void {
  if (selectedId.value) change(movePoint(story.value, selectedId.value, by));
}
async function removeSelected(): Promise<void> {
  const p = selected.value;
  if (!p) return;
  if ((p.label || p.description) && !(await sdk().ui.confirm(`Remove point ${selectedNo.value}${p.label ? `, "${p.label}"` : ''}?`, 'Remove point', { confirm: 'Remove' }))) return;
  change(removePoint(story.value, p.id));
  selectedId.value = null;
}

// ── Placing and dragging points ─────────────────────────────────────────────

const frame = ref<HTMLElement | null>(null);
const labelInput = ref<HTMLInputElement | null>(null);
let drag: { id: string; startX: number; startY: number; moved: boolean } | null = null;

function onPictureLoad(e: Event): void {
  const img = e.target as HTMLImageElement;
  aspect.value = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 0;
}

function percentAt(e: PointerEvent): { x: number; y: number } | null {
  const rect = frame.value?.getBoundingClientRect();
  if (!rect || !rect.width || !rect.height) return null;
  return { x: ((e.clientX - rect.left) / rect.width) * 100, y: ((e.clientY - rect.top) / rect.height) * 100 };
}

function onFrameClick(e: PointerEvent): void {
  if ((e.target as HTMLElement).closest('.poi')) return;
  const at = percentAt(e);
  if (!at) return;
  const next = addPoint(story.value, at.x, at.y);
  change(next);
  selectedId.value = next.points[next.points.length - 1]!.id;
  setTimeout(() => labelInput.value?.focus(), 0);
}

function onDotDown(e: PointerEvent, id: string): void {
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  // preventDefault keeps the page from selecting text, and focus with it: give the point focus so arrow keys move it.
  el.focus();
  el.setPointerCapture(e.pointerId);
  drag = { id, startX: e.clientX, startY: e.clientY, moved: false };
  selectedId.value = id;
}
function onDotMove(e: PointerEvent): void {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) return;
  drag.moved = true;
  const at = percentAt(e);
  // Moved without the debounce restarting each frame: one save once the point is let go.
  if (at) story.value = updatePoint(story.value, drag.id, at);
}
function onDotUp(): void {
  if (drag?.moved) change(story.value);
  drag = null;
}
/** Arrow keys nudge the selected point; Shift moves it further. */
function onDotKey(e: KeyboardEvent, p: StoryPoint): void {
  const step = e.shiftKey ? 2 : 0.5;
  const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  const m = d[e.key];
  if (m) {
    e.preventDefault();
    selectedId.value = p.id;
    change(updatePoint(story.value, p.id, { x: p.x + m[0], y: p.y + m[1] }));
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    selectedId.value = p.id;
    void removeSelected();
  }
}

// ── Shopify ─────────────────────────────────────────────────────────────────

const shopifyJson = computed(() => toShopifyHotspots(story.value.points));
const importText = ref('');
const importError = ref('');
const notice = ref('');
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
function flash(msg: string): void {
  notice.value = msg;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ''), 3000);
}

async function copyJson(): Promise<void> {
  try {
    await navigator.clipboard.writeText(shopifyJson.value);
    flash('Copied. Paste it into the product\'s Painting hotspots metafield in Shopify.');
  } catch {
    flash('Copying was blocked - select the text and copy it yourself.');
  }
}

async function importJson(): Promise<void> {
  importError.value = '';
  const r = parseHotspots(importText.value);
  if (!r.ok) {
    importError.value = r.error;
    return;
  }
  if (story.value.points.length && !(await sdk().ui.confirm(`Replace the ${story.value.points.length} point${story.value.points.length === 1 ? '' : 's'} here with the ${r.points.length} from Shopify?`, 'Replace points', { confirm: 'Replace' }))) return;
  change({ ...story.value, points: r.points });
  selectedId.value = null;
  importText.value = '';
  flash(`${r.points.length} point${r.points.length === 1 ? '' : 's'} taken from Shopify.`);
}

// ── Story cards ─────────────────────────────────────────────────────────────

const size = ref<CardSize>('a5');
const printing = ref(false);

/** Width over height of a picture, or undefined when it does not load. */
function measure(src: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : undefined);
    img.onerror = () => resolve(undefined);
    img.src = src;
  });
}

/** The picture written into the page: the card opens in a window that cannot reach this device's object URLs. */
async function dataUrl(imageId: string | undefined): Promise<string | null> {
  if (!imageId) return null;
  try {
    const url = (await sdk().data.images.url(imageId, 'full')) ?? (await sdk().data.images.url(imageId, 'thumb'));
    if (!url) return null;
    const blob = await (await fetch(url)).blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function printCards(list: Product[]): Promise<void> {
  if (!list.length) return;
  await flush();
  printing.value = true;
  try {
    const cards = [];
    for (const p of list) {
      const image = await dataUrl(p.imageId);
      cards.push({ title: p.title, kicker: p.consignorName || p.type || '', image, aspect: image ? await measure(image) : undefined, story: stories.value[p.id] ?? emptyStory(p.id) });
    }
    const html = storyCardsHtml(cards, { size: size.value, shop: sdk().account()?.accountName });
    const name = list.length === 1 ? `story-${list[0]!.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'print'}.html` : 'print-stories.html';
    if (!(await sdk().ui.openDocument(name, html))) flash('The card was blocked by the browser - allow pop-ups and try again.');
  } finally {
    printing.value = false;
  }
}

const statusText = computed(() => ({ saved: 'Saved', pending: 'Editing…', saving: 'Saving…', failed: 'Not saved', '': '' })[status.value]);
</script>

<template>
  <section class="page stories">
    <header>
      <div>
        <h1>Print stories</h1>
        <p class="hint">Click a print's picture to add numbered points of interest and say what each shows. They print as story cards for the booth and copy into Shopify's hotspots as they are.</p>
      </div>
      <div class="tools">
        <div class="seg" role="group" aria-label="Card size">
          <button type="button" :class="{ active: size === 'a5' }" @click="size = 'a5'">A5</button>
          <button type="button" :class="{ active: size === 'a4' }" @click="size = 'a4'">A4</button>
        </div>
        <button type="button" :disabled="!withStory.length || printing" @click="printCards(withStory)">
          <Icon name="printer" :size="16" /> All story cards ({{ withStory.length }})
        </button>
      </div>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="ok" role="status">{{ notice }}</p>

    <div class="layout">
      <aside class="prints">
        <input v-model="query" type="search" placeholder="Search prints" aria-label="Search prints" />
        <label class="check"><input v-model="onlyWithStory" type="checkbox" /> Only prints with a story</label>
        <p v-if="loaded && !products.length" class="empty">No products yet. Add your prints to the catalogue with a photo first.</p>
        <ul>
          <li v-for="p in shown" :key="p.id">
            <button type="button" class="print" :class="{ on: p.id === currentId }" @click="open(p)">
              <img v-if="thumbs[p.id]" :src="thumbs[p.id]!" alt="" />
              <span v-else class="nothumb" />
              <span class="name">
                <strong>{{ p.title }}</strong>
                <small>{{ p.type || 'No type' }}<template v-if="!p.imageId"> · no photo</template></small>
              </span>
              <span v-if="stories[p.id]?.points.length" class="count" :title="`${stories[p.id]!.points.length} points`">{{ stories[p.id]!.points.length }}</span>
            </button>
          </li>
        </ul>
      </aside>

      <div v-if="!current" class="empty pick">Pick a print on the left to tell its story.</div>

      <div v-else class="editor">
        <div class="title">
          <h2>{{ current.title }}</h2>
          <span class="status" :class="status" role="status">{{ statusText }}</span>
          <button type="button" :disabled="printing" @click="printCards([current])"><Icon name="printer" :size="16" /> Story card</button>
        </div>

        <div class="canvas">
          <p v-if="pictureLoading" class="hint">Loading the picture…</p>
          <p v-else-if="!picture" class="empty">This print has no photo on this device. Add one in the catalogue to place points on it.</p>
          <div v-else ref="frame" class="frame" :style="aspect ? { width: `min(100%, calc((100vh - 12rem) * ${aspect}))` } : undefined" @click="onFrameClick($event as PointerEvent)">
            <img :src="picture" :alt="current.title" draggable="false" @load="onPictureLoad" />
            <button
              v-for="(p, i) in story.points"
              :key="p.id"
              type="button"
              class="poi"
              :class="{ on: p.id === selectedId }"
              :style="{ left: `${p.x}%`, top: `${p.y}%` }"
              :aria-label="`Point ${i + 1}: ${p.label || 'no label'}`"
              @pointerdown="onDotDown($event, p.id)"
              @pointermove="onDotMove"
              @pointerup="onDotUp"
              @pointercancel="onDotUp"
              @keydown="onDotKey($event, p)"
            >{{ i + 1 }}</button>
          </div>
          <p v-if="picture" class="hint">Click to add a point, drag a number to move it, arrow keys nudge the selected one.</p>
        </div>

        <div class="side">
          <article class="card">
            <h3>About this print</h3>
            <textarea :value="story.intro" rows="4" placeholder="Where it was painted, what inspired it, what to look for…" @input="setIntro(($event.target as HTMLTextAreaElement).value)" />
          </article>

          <article class="card">
            <h3>Points of interest</h3>
            <p v-if="!story.points.length" class="hint">No points yet.</p>
            <ol v-else class="points">
              <li v-for="(p, i) in story.points" :key="p.id">
                <button type="button" class="quiet" :class="{ on: p.id === selectedId }" @click="selectedId = p.id">
                  <span class="n">{{ i + 1 }}</span> {{ p.label || 'No label yet' }}
                </button>
              </li>
            </ol>

            <div v-if="selected" class="point">
              <label>Label for point {{ selectedNo }}
                <input ref="labelInput" :value="selected.label" placeholder="The hidden bunny" @input="edit({ label: ($event.target as HTMLInputElement).value })" />
              </label>
              <label>What it shows
                <textarea :value="selected.description" rows="4" @input="edit({ description: ($event.target as HTMLTextAreaElement).value })" />
              </label>
              <label>Close-up picture (URL, optional)
                <input :value="selected.image ?? ''" type="url" placeholder="https://cdn.shopify.com/…" @input="edit({ image: ($event.target as HTMLInputElement).value })" />
              </label>
              <label v-if="selected.image">Picture description
                <input :value="selected.image_alt ?? ''" @input="edit({ image_alt: ($event.target as HTMLInputElement).value })" />
              </label>
              <div class="row">
                <button type="button" :disabled="selectedNo <= 1" aria-label="Move up" @click="reorder(-1)"><Icon name="arrow-up" :size="16" /></button>
                <button type="button" :disabled="selectedNo >= story.points.length" aria-label="Move down" @click="reorder(1)"><Icon name="arrow-down" :size="16" /></button>
                <span class="where">x {{ selected.x }}% · y {{ selected.y }}%</span>
                <button type="button" class="danger" @click="removeSelected"><Icon name="trash" :size="16" /> Remove</button>
              </div>
            </div>
          </article>

          <article class="card">
            <h3>Shopify</h3>
            <p class="hint">The product's <em>Painting hotspots</em> metafield (<code>custom.hotspots</code>) takes this as it is.</p>
            <textarea class="code" :value="shopifyJson" rows="6" readonly spellcheck="false" />
            <button type="button" :disabled="!story.points.length" @click="copyJson"><Icon name="copy" :size="16" /> Copy for Shopify</button>
            <details>
              <summary>Take points from Shopify</summary>
              <textarea v-model="importText" class="code" rows="5" spellcheck="false" placeholder="Paste the metafield's JSON here" />
              <p v-if="importError" class="error" role="alert">{{ importError }}</p>
              <button type="button" :disabled="!importText.trim()" @click="importJson">Use these points</button>
            </details>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.stories { max-width: 90rem; }
.layout { display: grid; grid-template-columns: minmax(14rem, 18rem) 1fr; gap: 1rem; align-items: start; }
.prints { display: flex; flex-direction: column; gap: .5rem; position: sticky; top: .5rem; max-height: calc(100vh - 6rem); overflow: auto; }
.prints ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; }
.check { display: flex; gap: .4rem; align-items: center; font-size: .85rem; color: var(--zfy-muted); }
.print { width: 100%; display: flex; align-items: center; gap: .6rem; text-align: left; padding: .35rem .5rem; border-color: transparent; background: transparent; }
.print.on { background: var(--zfy-accent-soft); color: var(--zfy-accent-ink); }
.print img, .nothumb { width: 2.6rem; height: 2.6rem; object-fit: cover; border-radius: 6px; flex: none; background: var(--zfy-surface-2); }
.name { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.name strong { font-size: .9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name small { color: var(--zfy-muted); font-size: .75rem; }
.count { flex: none; min-width: 1.5rem; padding: 0 .35rem; border-radius: 999px; background: var(--zfy-accent); color: var(--zfy-on-accent); font-size: .75rem; text-align: center; }
.pick { align-self: stretch; display: grid; place-items: center; }
.editor { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(18rem, 1fr); gap: 1rem; align-items: start; }
.title { grid-column: 1 / -1; display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.title h2 { margin: 0; font-size: 1.15rem; flex: 1; }
.status { font-size: .8rem; color: var(--zfy-muted); }
.status.failed { color: var(--zfy-danger); }
.canvas { display: flex; flex-direction: column; gap: .5rem; position: sticky; top: .5rem; }
.frame { position: relative; align-self: center; cursor: crosshair; user-select: none; touch-action: none; line-height: 0; }
.frame img { display: block; width: 100%; height: auto; border-radius: 4px; pointer-events: none; }
.poi { position: absolute; transform: translate(-50%, -50%); width: 2rem; height: 2rem; min-height: 0; padding: 0; border-radius: 50%; border: 2px solid #1d1b19; background: #fffdf9; color: #1d1b19; font-weight: 700; font-size: .85rem; line-height: 1; display: grid; place-items: center; box-shadow: 0 1px 4px rgba(0, 0, 0, .35); cursor: grab; touch-action: none; }
.poi:hover:not(:disabled) { background: #fffdf9; }
.poi.on, .poi.on:hover:not(:disabled) { background: var(--zfy-accent); border-color: var(--zfy-on-accent); color: var(--zfy-on-accent); }
.side { display: flex; flex-direction: column; gap: 1rem; }
.card { display: flex; flex-direction: column; gap: .6rem; padding: .9rem 1rem; border: 1px solid var(--zfy-line); border-radius: 12px; background: var(--zfy-surface); }
.card h3 { margin: 0; font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted); }
.card textarea, .card input:not([type='checkbox']) { width: 100%; }
.points { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .15rem; }
.points button { width: 100%; justify-content: flex-start; text-align: left; }
.points button.on { background: var(--zfy-accent-soft); color: var(--zfy-accent-ink); }
.n { display: inline-grid; place-items: center; width: 1.5rem; height: 1.5rem; border-radius: 50%; border: 1.5px solid currentColor; font-size: .75rem; font-weight: 700; margin-right: .35rem; flex: none; }
.point { display: flex; flex-direction: column; gap: .6rem; padding-top: .6rem; border-top: 1px solid var(--zfy-line); }
.point label { display: flex; flex-direction: column; gap: .25rem; font-size: .8rem; color: var(--zfy-muted); }
.row { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
.where { flex: 1; white-space: nowrap; font-size: .75rem; color: var(--zfy-muted); font-variant-numeric: tabular-nums; }
.code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; }
details { display: flex; flex-direction: column; gap: .5rem; }
details[open] > * + * { margin-top: .5rem; }
summary { cursor: pointer; font-size: .85rem; }
.ok { margin: 0; color: var(--zfy-accent-ink); }
@media (max-width: 1100px) {
  .editor { grid-template-columns: 1fr; }
  .canvas { position: static; }
}
@media (max-width: 760px) {
  .layout { grid-template-columns: 1fr; }
  .prints { position: static; max-height: 16rem; }
}
</style>
