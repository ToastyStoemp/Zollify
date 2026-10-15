<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { WEBHOOK_EVENTS, guessWebhookFormat, type Webhook, type WebhookEvent, type WebhookFormat } from '@zollify/shared';
import { authFetch, shellConfirm } from '@zollify/platform';
import { Icon, ModalShell } from '@zollify/ui';

/**
 * Settings → Webhooks: what happens in Zollify, posted to a Discord or Slack
 * channel, or to any service that takes JSON. Each webhook picks its events.
 */

const hooks = ref<Webhook[] | null>(null);
const error = ref<string | null>(null);
async function refresh(): Promise<void> {
  try {
    hooks.value = ((await authFetch('/webhooks')) as { webhooks: Webhook[] }).webhooks;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load webhooks.';
  }
}
onMounted(refresh);

const FORMATS: { id: WebhookFormat; label: string }[] = [
  { id: 'discord', label: 'Discord' },
  { id: 'slack', label: 'Slack' },
  { id: 'json', label: 'JSON (signed)' },
];
const label = (id: string): string => WEBHOOK_EVENTS.find((e) => e.id === id)?.label ?? id;
const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// ── Editing ─────────────────────────────────────────────────────────────────
const editing = ref<string | 'new' | null>(null);
const form = reactive({ name: '', url: '', format: 'discord' as WebhookFormat, events: ['sale'] as WebhookEvent[], timeZone: deviceZone, enabled: true });
const formError = ref<string | null>(null);
const busy = ref(false);
function openNew(): void {
  Object.assign(form, { name: '', url: '', format: 'discord', events: ['sale', 'report.daily'], timeZone: deviceZone, enabled: true });
  formError.value = null;
  editing.value = 'new';
}
function openEdit(h: Webhook): void {
  Object.assign(form, { name: h.name, url: h.url, format: h.format, events: [...h.events], timeZone: h.timeZone, enabled: h.enabled });
  formError.value = null;
  editing.value = h.id;
}
/** Pasting a Discord or Slack address picks the format for you. */
function urlChanged(): void {
  if (editing.value === 'new' && form.url) form.format = guessWebhookFormat(form.url.trim());
}
async function save(): Promise<void> {
  formError.value = null;
  if (!form.events.length) return void (formError.value = 'Pick at least one event.');
  busy.value = true;
  try {
    const body = JSON.stringify({ ...form, name: form.name.trim() || FORMATS.find((f) => f.id === form.format)!.label, url: form.url.trim() });
    if (editing.value === 'new') await authFetch('/webhooks', { method: 'POST', body });
    else await authFetch(`/webhooks/${editing.value}`, { method: 'PUT', body });
    editing.value = null;
    await refresh();
  } catch (err) {
    formError.value = err instanceof Error ? err.message : 'Could not save the webhook.';
  } finally {
    busy.value = false;
  }
}

const testing = ref<string | null>(null);
const tested = ref<Record<string, string>>({});
async function test(h: Webhook): Promise<void> {
  testing.value = h.id;
  try {
    const r = (await authFetch(`/webhooks/${h.id}/test`, { method: 'POST', body: '{}' })) as { ok: boolean; status: number | null; error: string | null };
    tested.value = { ...tested.value, [h.id]: r.ok ? 'Sent - check the channel.' : `Failed${r.status ? ` (${r.status})` : ''}: ${r.error ?? ''}` };
    await refresh();
  } catch (err) {
    tested.value = { ...tested.value, [h.id]: err instanceof Error ? err.message : 'Could not send.' };
  } finally {
    testing.value = null;
  }
}
async function remove(h: Webhook): Promise<void> {
  if (!(await shellConfirm(`"${h.name}" stops posting.`, 'Delete webhook?'))) return;
  await authFetch(`/webhooks/${h.id}`, { method: 'DELETE' }).catch((err) => (error.value = err instanceof Error ? err.message : 'Could not delete it.'));
  await refresh();
}
const status = (h: Webhook): string => {
  if (!h.enabled) return h.failures ? `Off - it failed ${h.failures} times in a row` : 'Off';
  if (!h.lastAt) return 'Nothing sent yet';
  return h.lastError ? `Last delivery failed: ${h.lastError}` : `Last sent ${new Date(h.lastAt).toLocaleString()}`;
};
const howTo = computed(() =>
  form.format === 'discord'
    ? 'In Discord: channel settings → Integrations → Webhooks → New webhook → Copy webhook URL.'
    : form.format === 'slack'
      ? 'In Slack: create an app with Incoming Webhooks, add one to a channel and copy its URL.'
      : 'Zollify posts JSON with the event, a title, a body and fields. Check X-Zollify-Signature (HMAC-SHA256 of the body with the secret shown after saving).',
);
</script>

<template>
  <section class="hooks">
    <h2>Webhooks</h2>
    <p class="hint">Post sales, daily and weekly summaries and what happens with your stores or artists to a Discord or Slack channel, or anywhere that takes JSON.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <p v-if="hooks && !hooks.length" class="empty">No webhooks yet.</p>
    <ul v-else-if="hooks" class="list">
      <li v-for="h in hooks" :key="h.id" :class="{ off: !h.enabled }">
        <div class="meta">
          <strong>{{ h.name }}</strong>
          <span>{{ FORMATS.find((f) => f.id === h.format)?.label }} · {{ h.events.map(label).join(', ') }}</span>
          <small :class="{ bad: h.lastError || !h.enabled }">{{ status(h) }}</small>
          <small v-if="tested[h.id]">{{ tested[h.id] }}</small>
          <small v-if="h.format === 'json'" class="mono">Secret: {{ h.secret }}</small>
        </div>
        <div class="actions">
          <button type="button" :disabled="testing === h.id" @click="test(h)">Test</button>
          <button type="button" @click="openEdit(h)">Edit</button>
          <button type="button" class="quiet" @click="remove(h)">Delete</button>
        </div>
      </li>
    </ul>
    <button type="button" class="primary add" @click="openNew"><Icon name="plus" :size="14" /> Add webhook</button>

    <ModalShell v-if="editing" :title="editing === 'new' ? 'New webhook' : 'Edit webhook'" @close="editing = null">
      <div class="form">
        <p v-if="formError" class="error" role="alert">{{ formError }}</p>
        <label><span>Webhook URL</span><input v-model="form.url" type="url" placeholder="https://discord.com/api/webhooks/…" autocomplete="off" @input="urlChanged" /></label>
        <div class="two">
          <label><span>Name</span><input v-model="form.name" type="text" placeholder="#sales" /></label>
          <label>
            <span>Format</span>
            <select v-model="form.format"><option v-for="f in FORMATS" :key="f.id" :value="f.id">{{ f.label }}</option></select>
          </label>
        </div>
        <p class="hint">{{ howTo }}</p>
        <fieldset>
          <legend>Post</legend>
          <label v-for="e in WEBHOOK_EVENTS" :key="e.id" class="check">
            <input v-model="form.events" type="checkbox" :value="e.id" />
            <span><strong>{{ e.label }}</strong><small>{{ e.hint }}</small></span>
          </label>
        </fieldset>
        <label v-if="form.events.includes('report.daily') || form.events.includes('report.weekly')"><span>Time zone for the summaries</span><input v-model="form.timeZone" type="text" /></label>
        <label class="check"><input v-model="form.enabled" type="checkbox" /> <span><strong>On</strong></span></label>
      </div>
      <template #footer>
        <div class="footer">
          <button type="button" @click="editing = null">Cancel</button>
          <button type="button" class="primary" :disabled="busy || !form.url.trim()" @click="save">Save</button>
        </div>
      </template>
    </ModalShell>
  </section>
</template>

<style scoped>
.hooks { display: flex; flex-direction: column; gap: .75rem; max-width: 40rem; }
h2 { margin: 0; font-size: 1.05rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.empty { margin: 0; padding: 1.2rem; text-align: center; color: var(--zfy-muted, #5a6472); border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.list li { display: flex; gap: .7rem; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; padding: .7rem .85rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
.list li.off { opacity: .7; }
.meta { display: flex; flex-direction: column; gap: .15rem; min-width: 0; flex: 1 1 18rem; font-size: .86rem; }
.meta span { color: var(--zfy-muted, #5a6472); overflow-wrap: anywhere; }
.meta small { font-size: .75rem; color: var(--zfy-muted, #5a6472); overflow-wrap: anywhere; }
.meta small.bad { color: var(--zfy-danger, #c6512f); }
.mono { font-family: ui-monospace, monospace; }
.actions { display: flex; gap: .4rem; }
.actions button { min-height: 2.1rem; font-size: .8rem; }
.add { align-self: flex-start; display: inline-flex; align-items: center; gap: .35rem; }
.form { display: flex; flex-direction: column; gap: .7rem; }
.form label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .5rem .75rem .7rem; display: flex; flex-direction: column; gap: .45rem; margin: 0; }
legend { font-size: .78rem; font-weight: 600; padding: 0 .3rem; }
.form label.check { flex-direction: row; align-items: flex-start; gap: .5rem; }
.check span { display: flex; flex-direction: column; }
.check small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
.footer { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
