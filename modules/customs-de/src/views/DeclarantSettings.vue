<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { emptyProfile } from '@zollify/shared';
import { DeclarantForm } from '@zollify/ui';
import { DECLARANT_KEY, defaultStoredDeclarant, type StoredDeclarant } from './declarant';
import { sdk } from '../runtime';

/**
 * Declarant details used on every generated document, plus the two facts
 * that belong to the company rather than any one event - EORI number and the
 * responsible Hauptzollamt - so neither has to be retyped per event. Stored
 * through the SDK's per-module config, separate from the customs-ch
 * declarant, so the two countries' paperwork can name different people.
 */
const form = ref<StoredDeclarant>(defaultStoredDeclarant());
const saved = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  const stored = await sdk().config.get<Partial<StoredDeclarant>>(DECLARANT_KEY);
  form.value = { ...defaultStoredDeclarant(), ...(stored ?? {}) };
});

const profile = sdk().account()?.profile.artist ?? emptyProfile().artist;

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
    title="Customs declarant (Germany)"
    hint="Who is declaring the goods, on the packing lists and proforma invoice this module prepares for your customs broker. Your booth profile is used by default - fill in a field here only when the declarant differs from it."
    :model="form"
    :profile="profile"
    country-placeholder="Germany"
    postcode-placeholder="10115 Berlin"
    :saved="saved"
    :error="error"
    @save="save"
  >
    <template #extra>
      <label>
        <span>EORI number</span>
        <input v-model="form.eori" type="text" class="mono" :placeholder="profile.eori" />
      </label>
      <label class="wide">
        <span>Precheck office (Hauptzollamt)</span>
        <input v-model="form.precheckOffice" type="text" placeholder="Hauptzollamt Berlin" />
      </label>
    </template>
    <template #after-hint>
      <p class="hint">
        Your precheck office is whichever Hauptzollamt is responsible for your business address, not a free choice -
        this module doesn't have a verified postcode → office list to auto-fill it, so look it up once at
        <a href="https://www.zoll.de" target="_blank" rel="noopener">zoll.de</a> and save it here.
      </p>
    </template>
  </DeclarantForm>
</template>

<style scoped>
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .875rem; }
.mono { font-family: ui-monospace, monospace; font-size: .85rem; }
</style>
