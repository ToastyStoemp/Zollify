<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  addDisplayVideos,
  displayVideoPrefs,
  listDisplayVideos,
  loadDisplayVideoPrefs,
  moveDisplayVideo,
  removeDisplayVideo,
  setDisplayVideoPrefs,
  storageEstimate,
  type DisplayVideoInfo,
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
</style>
