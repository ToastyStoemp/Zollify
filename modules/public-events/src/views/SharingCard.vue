<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

/**
 * The one switch for sharing events with the community: shown at the top of
 * Find events and as a Settings panel. Off by default; the server withdraws or
 * shares everything the moment it flips. Only admins and owners reach it (the
 * module's minimum role).
 */
defineProps<{ panel?: boolean }>();
const emit = defineEmits<{ change: [share: boolean] }>();

const share = ref<boolean | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    share.value = (await api.pool.settings()).share;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the sharing setting.';
  }
});

async function set(next: boolean): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    share.value = (await api.pool.setSharing(next)).share;
    emit('change', share.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not change the setting.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="sharing" :class="{ on: share === true }">
    <h2 v-if="panel">Help share event information with the community</h2>
    <template v-if="share !== null">
      <p class="status">
        <strong>{{ share ? 'Sharing is on' : 'You are not sharing your events' }}</strong>
      </p>
      <p class="hint">
        Help other artists find events? Share the name, dates, place and link of your events with the community.
        Others can add them to their own events in one tap. Nobody can see who goes to which event. You can turn
        this off any time in Settings.
      </p>
      <p class="hint">
        Stores are never shared. To keep one event private, tick "Do not share this event" in its options.
        Finding and adding events works whether or not you share.
      </p>
      <div class="actions">
        <button v-if="share" type="button" :disabled="busy" @click="set(false)">{{ busy ? 'Saving…' : 'Turn off sharing' }}</button>
        <button v-else type="button" class="primary" :disabled="busy" @click="set(true)">{{ busy ? 'Saving…' : 'Share my events' }}</button>
      </div>
    </template>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.sharing { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .5rem; }
.sharing.on { border-color: var(--zfy-accent, #0f8a74); }
h2 { margin: 0; font-size: 1.05rem; }
.status { margin: 0; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .9rem; max-width: 60ch; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.actions { display: flex; gap: .75rem; }
</style>
