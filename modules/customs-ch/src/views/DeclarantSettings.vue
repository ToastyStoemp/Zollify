<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { DeclarantForm } from '@zollify/ui';
import { defaultCustomsArtist, type CustomsArtist } from '../engine/model';
import { DECLARANT_KEY } from './declarant';
import { sdk } from '../runtime';

/**
 * Declarant details used on every generated document. Stored through the SDK's
 * per-module config so the values live in this module's own namespace and leave
 * with it when it is uninstalled.
 */
const form = ref<CustomsArtist>(defaultCustomsArtist());
const saved = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  const stored = await sdk().config.get<Partial<CustomsArtist>>(DECLARANT_KEY);
  form.value = { ...defaultCustomsArtist(), ...(stored ?? {}) };
});

/** The booth profile's value, shown as the placeholder so a blank field reads as "same as profile". */
const profile = sdk().account()?.profile.artist ?? defaultCustomsArtist();

async function save(): Promise<void> {
  error.value = null;
  try {
    await sdk().config.set(DECLARANT_KEY, { ...form.value });
    saved.value = true;
    setTimeout(() => (saved.value = false), 2500);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the declarant.';
  }
}
</script>

<template>
  <DeclarantForm
    title="Customs declarant"
    hint="Who is declaring the goods, on the EDEC declaration, the proforma invoice and the printed forms. Your booth profile is used by default - fill in a field here only when the declarant differs from it."
    :model="form"
    :profile="profile"
    country-placeholder="Switzerland"
    postcode-placeholder="8000 Zürich"
    :saved="saved"
    :error="error"
    @save="save"
  />
</template>
