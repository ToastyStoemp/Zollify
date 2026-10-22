<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { api, errorText, type CommissionView } from '../api';
import { sdk } from '../runtime';

/**
 * What the customer told us: their brief (from the request page or their
 * tracking page), budget and date wish, and reference pictures. Their own
 * words - kept apart from the private details, and erased with their other
 * details.
 */
const props = defineProps<{ commission: CommissionView }>();
const emit = defineEmits<{ changed: [] }>();

const urls = ref<Record<string, string>>({});
const error = ref<string | null>(null);
const big = ref<string | null>(null);

function release(): void {
  for (const u of Object.values(urls.value)) URL.revokeObjectURL(u);
  urls.value = {};
}
async function load(): Promise<void> {
  release();
  error.value = null;
  const c = props.commission;
  for (const p of c.pictures) {
    try {
      const f = await api.picture(c.id, p.id);
      const bytes = Uint8Array.from(atob(f.base64), (ch) => ch.charCodeAt(0));
      // Still the same commission once the picture arrived?
      if (props.commission.id !== c.id) return;
      urls.value = { ...urls.value, [p.id]: URL.createObjectURL(new Blob([bytes], { type: f.mime })) };
    } catch {
      error.value = 'A picture could not be loaded - this needs a connection.';
    }
  }
}
watch(() => [props.commission.id, props.commission.pictures.map((p) => p.id).join(',')], load, { immediate: true });
onUnmounted(release);

async function save(pid: string, name: string): Promise<void> {
  const url = urls.value[pid];
  if (!url) return;
  const blob = await (await fetch(url)).blob();
  await sdk().ui.saveFile(name, blob, blob.type);
}
async function remove(pid: string): Promise<void> {
  if (!(await sdk().ui.confirm('Remove this picture? The customer can send it again.', 'Remove picture', { confirm: 'Remove' }))) return;
  try {
    await api.removePicture(props.commission.id, pid);
    emit('changed');
  } catch (err) {
    error.value = errorText(err, 'Could not remove the picture.');
  }
}
</script>

<template>
  <section v-if="commission.brief?.text || commission.pictures.length || commission.source === 'request'" class="brief">
    <h3>From the customer <span v-if="commission.source === 'request'" class="tag">request page</span></h3>
    <p v-if="commission.brief?.text" class="text">{{ commission.brief.text }}</p>
    <p v-else class="hint">No description yet - the customer can add one on their page.</p>
    <p v-if="commission.brief?.budget || commission.brief?.wantedBy" class="hint">
      <template v-if="commission.brief?.budget">Budget: {{ commission.brief.budget }}</template>
      <template v-if="commission.brief?.budget && commission.brief?.wantedBy"> · </template>
      <template v-if="commission.brief?.wantedBy">Wanted by {{ commission.brief.wantedBy }}</template>
    </p>
    <p v-if="error" class="error">{{ error }}</p>
    <ul v-if="commission.pictures.length" class="pics">
      <li v-for="p in commission.pictures" :key="p.id">
        <button type="button" class="thumb" :aria-label="`Open ${p.name}`" @click="big = big === p.id ? null : p.id">
          <img v-if="urls[p.id]" :src="urls[p.id]" :alt="p.name" />
          <span v-else class="hint">…</span>
        </button>
        <span class="row">
          <button type="button" class="quiet" @click="save(p.id, p.name)">Save</button>
          <button type="button" class="quiet danger" @click="remove(p.id)">Remove</button>
        </span>
      </li>
    </ul>
    <img v-if="big && urls[big]" :src="urls[big]" class="big" alt="" @click="big = null" />
    <p class="hint">{{ commission.pushDevices ? `The customer gets browser notifications on ${commission.pushDevices} device${commission.pushDevices === 1 ? '' : 's'} for every step and message.` : 'The customer has not turned on browser notifications.' }}</p>
  </section>
</template>

<style scoped>
.brief { display: flex; flex-direction: column; gap: .45rem; border-top: 1px solid var(--zfy-line, #d6dde4); padding-top: .6rem; }
h3 { margin: 0; font-size: .95rem; display: flex; align-items: center; gap: .5rem; }
.tag { font-size: .66rem; text-transform: uppercase; letter-spacing: .06em; border-radius: 999px; padding: .1rem .5rem; background: #dbeafe; color: #1e40af; font-weight: 600; }
.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); font-size: .875rem; }
.pics { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .6rem; }
.pics li { display: flex; flex-direction: column; gap: .2rem; align-items: flex-start; }
.thumb { padding: 0; width: 88px; height: 88px; border-radius: 8px; overflow: hidden; border: 1px solid var(--zfy-line, #d6dde4); background: var(--zfy-surface-2, #e9edf1); display: flex; align-items: center; justify-content: center; min-height: 0; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.row { display: flex; gap: .4rem; }
.row button { min-height: 0; padding: .1rem .3rem; font-size: .8rem; }
.danger { color: var(--zfy-danger, #c6512f); }
.big { max-width: 100%; border-radius: 10px; border: 1px solid var(--zfy-line, #d6dde4); cursor: zoom-out; }
</style>
