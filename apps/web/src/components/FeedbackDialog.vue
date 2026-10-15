<script setup lang="ts">
import { ref } from 'vue';
import { useRoute } from 'vue-router';
import { authFetch } from '@zollify/platform';
import { ModalShell } from '@zollify/ui';

/**
 * Send feedback: something broken, or an idea. It reaches the people running
 * Zollify with the screen it was sent from and the app version, so a bug
 * report says where it happened without the person having to.
 */
const props = defineProps<{ appVersion: string; discordUrl: string | null }>();
const emit = defineEmits<{ close: [] }>();
const route = useRoute();

const kind = ref<'bug' | 'idea'>('bug');
const message = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const sent = ref(false);

async function send(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await authFetch('/feedback', {
      method: 'POST',
      // The path only: a query can carry ids or search text that is nobody's business.
      body: JSON.stringify({ kind: kind.value, message: message.value.trim(), page: route.path, appVersion: props.appVersion }),
    });
    sent.value = true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not send it - try again.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ModalShell title="Send feedback" @close="emit('close')">
    <div v-if="!sent" class="fb">
      <div class="kinds" role="radiogroup" aria-label="What is it about">
        <label :class="{ on: kind === 'bug' }"><input v-model="kind" type="radio" value="bug" /> <strong>Something is broken</strong><span>A bug, an error, something that does not work as it should.</span></label>
        <label :class="{ on: kind === 'idea' }"><input v-model="kind" type="radio" value="idea" /> <strong>An idea</strong><span>A feature you would like, or something that could be easier.</span></label>
      </div>
      <label class="msg">
        <span>{{ kind === 'bug' ? 'What happened, and what did you expect?' : 'What would help you?' }}</span>
        <textarea v-model="message" rows="6" maxlength="4000" :placeholder="kind === 'bug' ? 'I tapped Card, the terminal beeped, and the till kept waiting…' : 'It would save me time if…'" />
      </label>
      <p class="hint">Goes to the people who make Zollify, with this screen and the app version. Leave out passwords and card details.</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </div>
    <div v-else class="fb">
      <p class="done">Thanks - we read every one.</p>
      <p v-if="discordUrl" class="hint">Want to talk it through, or see what others ask for? <a :href="discordUrl" target="_blank" rel="noopener noreferrer">Join us on Discord</a>.</p>
    </div>
    <template #footer>
      <div class="foot">
        <button type="button" class="quiet" @click="emit('close')">{{ sent ? 'Close' : 'Cancel' }}</button>
        <button v-if="!sent" type="button" class="primary" :disabled="busy || message.trim().length < 3" @click="send">{{ busy ? 'Sending…' : 'Send' }}</button>
      </div>
    </template>
  </ModalShell>
</template>

<style scoped>
.fb { display: flex; flex-direction: column; gap: .8rem; }
.kinds { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
.kinds label { display: flex; flex-direction: column; gap: .2rem; padding: .65rem .75rem; border: 1px solid var(--zfy-line); border-radius: 10px; cursor: pointer; font-size: .85rem; }
.kinds label.on { border-color: var(--zfy-accent); background: var(--zfy-accent-soft); }
.kinds input { position: absolute; opacity: 0; pointer-events: none; }
.kinds label:focus-within { outline: 2px solid var(--zfy-accent); outline-offset: 2px; }
.kinds span { color: var(--zfy-muted); }
.msg { display: flex; flex-direction: column; gap: .3rem; font-size: .875rem; }
.msg textarea { font: inherit; resize: vertical; }
.hint { margin: 0; color: var(--zfy-muted); font-size: .8rem; }
.error { margin: 0; color: var(--zfy-danger); font-size: .875rem; }
.done { margin: 0; font-weight: 600; color: var(--zfy-accent-ink); }
.foot { display: flex; justify-content: flex-end; gap: .5rem; width: 100%; }
@media (max-width: 480px) { .kinds { grid-template-columns: 1fr; } }
</style>
