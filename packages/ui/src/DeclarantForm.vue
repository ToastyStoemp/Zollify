<script setup lang="ts">
/**
 * Customs declarant settings form - identical layout for both customs
 * modules (CH/DE), which each keep their own storage, model type and save
 * logic. This component only renders the shared fields; a module supplies
 * its own extra fields (e.g. EORI) through the `extra` slot.
 */
export interface DeclarantFormModel {
  companyName: string;
  fullName: string;
  street: string;
  postCodeCity: string;
  countryOfOrigin: string;
  phone: string;
  email: string;
  vatId: string;
}

withDefaults(
  defineProps<{
    title: string;
    hint: string;
    model: DeclarantFormModel;
    profile: Partial<DeclarantFormModel>;
    countryPlaceholder?: string;
    postcodePlaceholder?: string;
    saved?: boolean;
    error?: string | null;
  }>(),
  { countryPlaceholder: '', postcodePlaceholder: '', saved: false, error: null },
);
defineEmits<{ save: [] }>();
</script>

<template>
  <form class="declarant" @submit.prevent="$emit('save')">
    <h2>{{ title }}</h2>
    <p class="hint">{{ hint }}</p>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div class="grid">
      <label>
        <span>Company</span>
        <input v-model="model.companyName" :placeholder="profile.companyName" type="text" autocomplete="organization" />
      </label>
      <label>
        <span>Full name</span>
        <input v-model="model.fullName" :placeholder="profile.fullName" type="text" autocomplete="name" />
      </label>
      <label>
        <span>Street</span>
        <input v-model="model.street" :placeholder="profile.street" type="text" autocomplete="street-address" />
      </label>
      <label>
        <span>Postcode and city</span>
        <input v-model="model.postCodeCity" :placeholder="profile.postCodeCity || postcodePlaceholder" type="text" />
      </label>
      <label>
        <span>Country of origin</span>
        <input v-model="model.countryOfOrigin" :placeholder="profile.countryOfOrigin || countryPlaceholder" type="text" autocomplete="country-name" />
      </label>
      <label>
        <span>Phone</span>
        <input v-model="model.phone" :placeholder="profile.phone" type="tel" autocomplete="tel" />
      </label>
      <label>
        <span>Email</span>
        <input v-model="model.email" :placeholder="profile.email" type="email" autocomplete="email" />
      </label>
      <label>
        <span>VAT / tax ID</span>
        <input v-model="model.vatId" type="text" class="mono" :placeholder="profile.vatId || 'DE123456789'" />
      </label>
      <slot name="extra" />
    </div>

    <slot name="after-hint" />

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
label.wide { grid-column: 1 / -1; }
:slotted(.wide) { grid-column: 1 / -1; }
.mono { font-family: ui-monospace, monospace; font-size: .85rem; }
.row { display: flex; align-items: center; gap: .75rem; }
.ok { color: var(--zfy-success, #0e7c66); margin: 0; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
</style>
