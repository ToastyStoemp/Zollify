<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NOTIFY_KINDS, NOTIFY_KIND_LABEL, NotifySettingsSchema, type NotifyKind, type NotifySettings } from '@zollify/shared';
import { api, errorText } from '../api';

/**
 * Settings → Notify me: the page's address, what it offers, the webstore
 * link, how often the same item is announced to the same person, and when
 * a silent subscriber is erased.
 */
const settings = ref<NotifySettings>(NotifySettingsSchema.parse({}));
const publicUrl = ref<string | null>(null);
const mailEnabled = ref(true);
const error = ref<string | null>(null);
const ok = ref<string | null>(null);
const busy = ref(false);

onMounted(async () => {
  try {
    const o = await api.overview();
    settings.value = o.settings;
    publicUrl.value = o.publicUrl;
    mailEnabled.value = o.mailEnabled;
  } catch (err) {
    error.value = errorText(err, 'Could not load the settings.');
  }
});
const has = (k: NotifyKind): boolean => settings.value.kinds.includes(k);
const toggle = (k: NotifyKind): void => {
  settings.value.kinds = has(k) ? settings.value.kinds.filter((x) => x !== k) : [...settings.value.kinds, k];
};

async function save(): Promise<void> {
  error.value = ok.value = null;
  const parsed = NotifySettingsSchema.safeParse({ ...settings.value, restockCooldownDays: Number(settings.value.restockCooldownDays), eraseAfterMonths: Number(settings.value.eraseAfterMonths) });
  if (!parsed.success) {
    error.value = parsed.error.issues[0]?.message ?? 'Check the values.';
    return;
  }
  busy.value = true;
  try {
    const o = await api.saveSettings(parsed.data);
    settings.value = o.settings;
    publicUrl.value = o.publicUrl;
    ok.value = 'Saved.';
  } catch (err) {
    error.value = errorText(err, 'Could not save the settings.');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="notify-settings" @submit.prevent="save">
    <p v-if="!mailEnabled" class="error">This server cannot send email, so nobody can confirm a sign-up. Set SMTP_URL and MAIL_FROM on the server first.</p>
    <label>Page address <span class="addr"><span class="hint">…/p/notify-me/</span><input v-model="settings.slug" type="text" maxlength="40" placeholder="your-shop" /></span><span class="hint">Lower-case letters, digits and dashes. Empty switches the page off. {{ publicUrl ? `Live at ${publicUrl}` : '' }}</span></label>
    <label>A line under your name <input v-model="settings.intro" type="text" maxlength="300" placeholder="Pins, prints and the odd plush." /></label>
    <label>Webstore link <input v-model="settings.storeUrl" type="url" maxlength="300" placeholder="https://" /><span class="hint">Offered on the page and in mails.</span></label>
    <fieldset>
      <legend>What the page offers</legend>
      <label v-for="k in NOTIFY_KINDS" :key="k" class="check"><input type="checkbox" :checked="has(k)" @change="toggle(k)" /> {{ NOTIFY_KIND_LABEL[k] }}</label>
    </fieldset>
    <label>Days before the same item is announced to the same person again <input v-model.number="settings.restockCooldownDays" type="number" min="1" max="365" /></label>
    <label>Erase a subscriber who heard nothing for (months) <input v-model.number="settings.eraseAfterMonths" type="number" min="0" max="120" /><span class="hint">0 = keep. The unconfirmed are erased after a week, those who left after a month, whatever this says.</span></label>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="ok" class="ok" role="status">{{ ok }}</p>
    <div class="actions"><button type="submit" class="primary" :disabled="busy">Save</button></div>
  </form>
</template>

<style scoped>
.notify-settings { display: flex; flex-direction: column; gap: .8rem; max-width: 34rem; }
.hint { color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .875rem; }
label.check { flex-direction: row; align-items: center; gap: .4rem; }
.addr { display: flex; align-items: center; gap: .3rem; }
.addr input { flex: 1; min-width: 0; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .4rem; }
legend { font-size: .8rem; color: var(--zfy-muted, #5a6472); }
.actions { display: flex; gap: .5rem; }
</style>
