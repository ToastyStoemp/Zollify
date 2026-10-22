<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { GiftCardSettingsSchema, type GiftCardSettings } from '@zollify/shared';
import { api, errorText } from '../api';

/**
 * Settings → Gift cards: how long a card stays valid and the most a card
 * can be sold for. Both apply to cards issued from now on; a card keeps the
 * expiry it was issued with.
 */
const settings = ref<GiftCardSettings>(GiftCardSettingsSchema.parse({}));
const error = ref<string | null>(null);
const ok = ref<string | null>(null);
const busy = ref(false);

onMounted(async () => {
  try {
    settings.value = await api.settings();
  } catch (err) {
    error.value = errorText(err, 'Could not load the settings.');
  }
});

async function save(): Promise<void> {
  error.value = ok.value = null;
  const parsed = GiftCardSettingsSchema.safeParse({ expiryMonths: Number(settings.value.expiryMonths), maxValue: Number(settings.value.maxValue) });
  if (!parsed.success) {
    error.value = parsed.error.issues[0]?.message ?? 'Check the values.';
    return;
  }
  busy.value = true;
  try {
    settings.value = await api.saveSettings(parsed.data);
    ok.value = 'Saved.';
  } catch (err) {
    error.value = errorText(err, 'Could not save the settings.');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="gift-settings" @submit.prevent="save">
    <p class="hint">Cards are sold from the till (the Gift card button over it) without VAT and taken as payment at any till of this account. What is on a card follows the till's sales: a refund of the sale that sold it empties it, a refund of a sale it paid for puts the money back.</p>
    <label>Cards expire after (months) <input v-model.number="settings.expiryMonths" type="number" min="0" max="120" step="1" /><span class="hint">0 = never. Check what the law where you sell allows; several countries set a minimum.</span></label>
    <label>Most a card can be sold for <input v-model.number="settings.maxValue" type="number" min="1" max="100000" step="1" /></label>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="ok" class="ok" role="status">{{ ok }}</p>
    <div class="actions"><button type="submit" class="primary" :disabled="busy">Save</button></div>
  </form>
</template>

<style scoped>
.gift-settings { display: flex; flex-direction: column; gap: .7rem; max-width: 32rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .875rem; }
.actions { display: flex; gap: .5rem; }
</style>
