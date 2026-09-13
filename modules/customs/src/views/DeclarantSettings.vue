<script setup lang="ts">
import { ref } from 'vue';

/**
 * Declarant details used on every generated document. Stored through the SDK's
 * per-module config so the values live in this module's own namespace and leave
 * with it when it is uninstalled.
 */
const form = ref({ name: '', address: '', trn: '' });
const saved = ref(false);
</script>

<template>
  <form class="declarant" @submit.prevent>
    <h2>Customs declarant</h2>
    <p class="hint">These details appear on the EDEC declaration and printed forms.</p>

    <label>
      <span>Declarant name</span>
      <input v-model="form.name" type="text" autocomplete="organization" />
    </label>
    <label>
      <span>Address</span>
      <textarea v-model="form.address" rows="3" autocomplete="street-address"></textarea>
    </label>
    <label>
      <span>Trader identification number</span>
      <input v-model="form.trn" type="text" inputmode="numeric" />
    </label>

    <button type="submit">Save</button>
    <p v-if="saved" class="ok" role="status">Saved.</p>
  </form>
</template>

<style scoped>
.declarant { display: flex; flex-direction: column; gap: .75rem; max-width: 32rem; }
h2 { font-size: 1.05rem; margin: 0; }
.hint { color: var(--bly-muted, #5a6472); margin: 0; font-size: .875rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.ok { color: var(--bly-success, #0e7c66); margin: 0; }
</style>
