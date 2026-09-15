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
  <form class="declarant" @submit.prevent="save">
    <h2>Customs declarant</h2>
    <p class="hint">
      Who is declaring the goods, on the EDEC declaration, the proforma invoice and the printed
      forms. Your booth profile is used by default - fill in a field here only when the declarant
      differs from it.
    </p>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div class="grid">
      <label>
        <span>Company</span>
        <input v-model="form.companyName" :placeholder="profile.companyName" type="text" autocomplete="organization" />
      </label>
      <label>
        <span>Full name</span>
        <input v-model="form.fullName" :placeholder="profile.fullName" type="text" autocomplete="name" />
      </label>
      <label>
        <span>Street</span>
        <input v-model="form.street" :placeholder="profile.street" type="text" autocomplete="street-address" />
      </label>
      <label>
        <span>Postcode and city</span>
        <input v-model="form.postCodeCity" :placeholder="profile.postCodeCity || '8000 Zürich'" type="text" />
      </label>
      <label>
        <span>Country of origin</span>
        <input v-model="form.countryOfOrigin" :placeholder="profile.countryOfOrigin || 'Switzerland'" type="text" autocomplete="country-name" />
      </label>
      <label>
        <span>Phone</span>
        <input v-model="form.phone" :placeholder="profile.phone" type="tel" autocomplete="tel" />
      </label>
      <label>
        <span>Email</span>
        <input v-model="form.email" :placeholder="profile.email" type="email" autocomplete="email" />
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
