<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  DIM_MAX_PCT,
  addDisplayVideos,
  dimLayer,
  displayVideoBlob,
  displayVideoPrefs,
  listDisplayVideos,
  loadDisplayVideoPrefs,
  moveDisplayVideo,
  removeDisplayVideo,
  setDisplayVideoPrefs,
  storageEstimate,
  type DisplayVideoInfo,
  type DisplayVideoPrefs,
} from '@zollify/platform';

/**
 * Videos for the customer display, on this device: add, order and remove
 * them, and say what happens when a cart comes in. They play on this
 * device's display only - add them on the screen that faces the customer.
 */
const videos = ref<DisplayVideoInfo[]>([]);
const busy = ref(false);
const error = ref<string | null>(null);
const note = ref<string | null>(null);
const space = ref<{ usage: number; quota: number } | null>(null);
const picker = ref<HTMLInputElement | null>(null);

async function refresh(): Promise<void> {
  videos.value = await listDisplayVideos();
  space.value = await storageEstimate();
}
onMounted(async () => {
  await loadDisplayVideoPrefs().catch(() => {});
  await refresh().catch(() => {});
});

async function run(task: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = null;
  note.value = null;
  try {
    await task();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
    await refresh().catch(() => {});
  }
}

async function picked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  if (!files.length) return;
  await run(async () => {
    const { added, skipped } = await addDisplayVideos(files);
    const parts = [added ? `${added} video${added === 1 ? '' : 's'} added.` : ''];
    if (skipped.length) parts.push(`Not a video, left out: ${skipped.join(', ')}.`);
    note.value = parts.filter(Boolean).join(' ');
  });
}

const remove = (v: DisplayVideoInfo): Promise<void> => run(() => removeDisplayVideo(v.id));

// ── The look of the cart over the video ─────────────────────────────────────
type Colour = 'dimColor' | 'panelBg' | 'panelText' | 'totalColor';
/** What an unset colour shows as in the picker - the app's light look. */
const SHOWN_AS: Record<Colour, string> = { dimColor: '#000000', panelBg: '#f1f4f6', panelText: '#16202a', totalColor: '#0e7c66' };
const COLOURS: { key: Colour; label: string }[] = [
  { key: 'dimColor', label: 'Dimmed with' },
  { key: 'panelBg', label: 'Panel' },
  { key: 'panelText', label: 'Text' },
  { key: 'totalColor', label: 'Total' },
];
/** Changes the preview as the picker moves; `save` keeps it once let go. */
function live(patch: Partial<DisplayVideoPrefs>): void {
  Object.assign(displayVideoPrefs, patch);
}
const save = (): Promise<void> => setDisplayVideoPrefs({});
const reset = (key: Colour): Promise<void> => setDisplayVideoPrefs({ [key]: key === 'dimColor' ? '#000000' : '' });
const custom = (key: Colour): boolean => (key === 'dimColor' ? displayVideoPrefs.dimColor !== '#000000' : !!displayVideoPrefs[key]);

/** A frame of the first video, behind a sample cart, to judge the colours by. */
const previewSrc = ref<string | null>(null);
watch(
  () => videos.value[0]?.id,
  async (id) => {
    if (previewSrc.value) URL.revokeObjectURL(previewSrc.value);
    const blob = id ? await displayVideoBlob(id).catch(() => null) : null;
    previewSrc.value = blob ? URL.createObjectURL(blob) : null;
  },
);
onUnmounted(() => {
  if (previewSrc.value) URL.revokeObjectURL(previewSrc.value);
});
const toFrame = (e: Event): void => {
  const v = e.target as HTMLVideoElement;
  v.currentTime = Math.min(1, (v.duration || 2) / 2);
};
const previewPanel = computed<Record<string, string>>(() => {
  const p = displayVideoPrefs;
  return {
    ...(p.panelBg ? { '--zfy-bg': p.panelBg } : {}),
    ...(p.panelText ? { '--zfy-ink': p.panelText, '--zfy-muted': `color-mix(in srgb, ${p.panelText} 65%, transparent)`, '--zfy-line': `color-mix(in srgb, ${p.panelText} 20%, transparent)` } : {}),
    ...(p.totalColor ? { '--zfy-accent': p.totalColor } : {}),
  };
});
const move = (v: DisplayVideoInfo, by: -1 | 1): Promise<void> => run(() => moveDisplayVideo(v.id, by));

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}
</script>

<template>
  <div class="videos">
    <p class="hint">
      While no sale is on, the display plays these one after another, without sound, and starts over at the end. They stay on this
      device only and play with no internet - add them on the screen that faces the customer. MP4 plays everywhere.
    </p>

    <ol v-if="videos.length" class="list">
      <li v-for="(v, i) in videos" :key="v.id">
        <span class="name">{{ v.name }}<small>{{ size(v.size) }}</small></span>
        <button type="button" class="quiet" :disabled="busy || i === 0" :aria-label="`Move ${v.name} up`" @click="move(v, -1)">↑</button>
        <button type="button" class="quiet" :disabled="busy || i === videos.length - 1" :aria-label="`Move ${v.name} down`" @click="move(v, 1)">↓</button>
        <button type="button" class="quiet danger" :disabled="busy" @click="remove(v)">Remove</button>
      </li>
    </ol>
    <p v-else class="hint">No videos yet - the display shows your logo and name.</p>

    <div class="row">
      <button type="button" :disabled="busy" @click="picker?.click()">{{ busy ? 'Adding…' : 'Add videos' }}</button>
      <input ref="picker" type="file" accept="video/*" multiple hidden @change="picked" />
      <span v-if="space" class="hint">{{ size(space.usage) }} used of {{ size(space.quota) }} available here</span>
    </div>
    <p v-if="note" class="ok" role="status">{{ note }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div v-if="videos.length" class="toggles">
      <label>
        <input type="checkbox" :checked="displayVideoPrefs.enabled" @change="setDisplayVideoPrefs({ enabled: ($event.target as HTMLInputElement).checked })" />
        <span class="body"><span class="label">Play videos</span><span class="sub">Off keeps them here but shows your logo instead.</span></span>
      </label>
      <label>
        <input type="radio" name="display-video-mode" value="overlay" :checked="displayVideoPrefs.mode === 'overlay'" @change="setDisplayVideoPrefs({ mode: 'overlay' })" />
        <span class="body"><span class="label">Cart over the video</span><span class="sub">The video keeps playing, dimmed, behind the customer's cart.</span></span>
      </label>
      <label>
        <input type="radio" name="display-video-mode" value="swap" :checked="displayVideoPrefs.mode === 'swap'" @change="setDisplayVideoPrefs({ mode: 'swap' })" />
        <span class="body"><span class="label">Cart instead of the video</span><span class="sub">The cart fills the screen and the video pauses, then carries on once the sale is done.</span></span>
      </label>
    </div>

    <div v-if="videos.length && displayVideoPrefs.mode === 'overlay'" class="look">
      <p class="label">The cart over the video</p>
      <label class="dim">
        <span>Dimming {{ displayVideoPrefs.dimPct }}%</span>
        <input type="range" min="0" :max="DIM_MAX_PCT" step="5" :value="displayVideoPrefs.dimPct" @input="live({ dimPct: Number(($event.target as HTMLInputElement).value) })" @change="save" />
      </label>
      <div class="colours">
        <div v-for="c in COLOURS" :key="c.key" class="colour">
          <label>
            <input type="color" :value="(displayVideoPrefs[c.key] as string) || SHOWN_AS[c.key]" @input="live({ [c.key]: ($event.target as HTMLInputElement).value })" @change="save" />
            <span>{{ c.label }}<small>{{ custom(c.key) ? (displayVideoPrefs[c.key] as string) : c.key === 'dimColor' ? 'black' : 'app’s own' }}</small></span>
          </label>
          <button v-if="custom(c.key)" type="button" class="quiet" @click="reset(c.key)">Reset</button>
        </div>
      </div>
      <div class="preview" aria-label="Preview of the cart over the video">
        <video v-if="previewSrc" :src="previewSrc" muted playsinline preload="metadata" aria-hidden="true" @loadedmetadata="toFrame"></video>
        <div class="pdim" :style="{ background: dimLayer(displayVideoPrefs) }"></div>
        <div class="ppanel" :style="previewPanel">
          <span class="pline"><span>1 × Harbour print · A3</span><strong>EUR 30.00</strong></span>
          <span class="pline"><span>2 × Zodiac keychain</span><strong>EUR 16.00</strong></span>
          <span class="ptotal"><span>Total</span><strong>EUR 46.00</strong></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.videos { display: flex; flex-direction: column; gap: .6rem; width: 100%; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .8rem; }
.ok { color: var(--zfy-accent-ink, #0a5a4a); margin: 0; font-size: .875rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; font-size: .875rem; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.list li { display: flex; align-items: center; gap: .4rem; padding: .4rem .6rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; background: var(--zfy-surface, #fff); }
.name { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: .875rem; display: flex; flex-direction: column; }
.name small { color: var(--zfy-muted, #5a6472); font-size: .72rem; }
.list .quiet { min-height: 2rem; padding: .1rem .55rem; font-size: .8rem; }
.row { display: flex; align-items: center; gap: .7rem; flex-wrap: wrap; }
.toggles { display: flex; flex-direction: column; gap: .5rem; }
.toggles label { display: flex; align-items: flex-start; gap: .6rem; padding: .6rem .75rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; background: var(--zfy-surface, #fff); cursor: pointer; }
.toggles input { margin-top: .2rem; }
.toggles .body { display: flex; flex-direction: column; }
.toggles .label { font-size: .875rem; font-weight: 600; }
.toggles .sub { font-size: .75rem; color: var(--zfy-muted, #5a6472); }
.look { display: flex; flex-direction: column; gap: .6rem; padding: .7rem .8rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; }
.look .label { margin: 0; font-size: .875rem; font-weight: 600; }
.dim { display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; }
.colours { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: .5rem; }
.colour { display: flex; align-items: center; gap: .4rem; }
.colour label { display: flex; align-items: center; gap: .45rem; font-size: .85rem; cursor: pointer; flex: 1; min-width: 0; }
.colour label span { display: flex; flex-direction: column; }
.colour small { color: var(--zfy-muted, #5a6472); font-size: .72rem; }
.colour input[type=color] { width: 2.4rem; height: 2rem; padding: 0; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 6px; background: none; }
.colour .quiet { min-height: 1.8rem; padding: .1rem .5rem; font-size: .75rem; }
.preview { position: relative; aspect-ratio: 16 / 9; max-width: 26rem; border-radius: 8px; overflow: hidden; background: #000; display: flex; align-items: center; justify-content: center; }
.preview video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.pdim { position: absolute; inset: 0; }
.ppanel { position: relative; width: 70%; padding: .6rem .8rem; border-radius: 8px; display: flex; flex-direction: column; gap: .25rem; font-size: .72rem; color: var(--zfy-ink); background: color-mix(in srgb, var(--zfy-bg) 96%, transparent); box-shadow: 0 6px 20px rgba(0, 0, 0, .35); }
.pline, .ptotal { display: flex; justify-content: space-between; gap: .5rem; }
.ptotal { border-top: 1px solid var(--zfy-line); padding-top: .3rem; margin-top: .1rem; color: var(--zfy-muted); }
.ptotal strong { color: var(--zfy-accent); font-size: .95rem; }
</style>
