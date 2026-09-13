<script setup lang="ts">
import { onMounted, ref } from 'vue';
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
  <form class="declarant" @submit.prevent="save">
    <h2>Customs declarant</h2>
    <p class="hint">
      Who is declaring the goods. These details appear on the EDEC declaration, the proforma
      invoice and the printed forms.
    </p>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div class="grid">
      <label>
        <span>Company</span>
        <input v-model="form.companyName" type="text" autocomplete="organization" />
      </label>
      <label>
        <span>Full name</span>
        <input v-model="form.fullName" type="text" autocomplete="name" />
      </label>
      <label>
        <span>Street</span>
        <input v-model="form.street" type="text" autocomplete="street-address" />
      </label>
      <label>
        <span>Postcode and city</span>
        <input v-model="form.postCodeCity" type="text" placeholder="8000 Zürich" />
      </label>
      <label>
        <span>Country of origin</span>
        <input v-model="form.countryOfOrigin" type="text" placeholder="Switzerland" autocomplete="country-name" />
      </label>
      <label>
        <span>Phone</span>
        <input v-model="form.phone" type="tel" autocomplete="tel" />
      </label>
      <label>
        <span>Email</span>
        <input v-model="form.email" type="email" autocomplete="email" />
      </label>
    </div>

    <div class="row">
      <button type="submit" class="primary">Save</button>
      <p v-if="saved" class="ok" role="status">Saved.</p>
    </div>
  </form>
</template>

<style scoped>
.declarant { display: flex; flex-direction: column; gap: .75rem; max-width: 38rem; }
h2 { font-size: 1.05rem; margin: 0; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .875rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: .75rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.row { display: flex; align-items: center; gap: .75rem; }
.ok { color: var(--zfy-success, #0e7c66); margin: 0; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
</style>
