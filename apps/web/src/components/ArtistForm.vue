<script setup lang="ts">
import type { ArtistDetails } from '@zollify/shared';
import { CountryPicker, CurrencyPicker } from '@zollify/ui';

/**
 * The booth's identity, as it appears on customs paperwork and receipts.
 * Shared by the first-run wizard and the Booth profile settings panel so the
 * two can never drift apart in what they ask for.
 */
const model = defineModel<ArtistDetails>({ required: true });
const props = defineProps<{ canRename: boolean }>();
const name = defineModel<string>('name', { default: '' });
const currency = defineModel<string>('currency', { default: 'CHF' });
</script>

<template>
  <div class="artist">
    <label v-if="props.canRename" class="wide">
      <span>Booth name</span>
      <input v-model="name" type="text" placeholder="Phuong Ninjin" autocomplete="organization" required />
      <small>Shown in the sidebar and to everyone you invite.</small>
    </label>

    <div class="grid">
      <label>
        <span>Your name</span>
        <input v-model="model.fullName" type="text" autocomplete="name" />
      </label>
      <label>
        <span>Company (if any)</span>
        <input v-model="model.companyName" type="text" autocomplete="organization" />
      </label>
      <label>
        <span>Street</span>
        <input v-model="model.street" type="text" autocomplete="street-address" />
      </label>
      <label>
        <span>Postcode and city</span>
        <input v-model="model.postCodeCity" type="text" placeholder="8000 Zürich" />
      </label>
      <label>
        <span>Country</span>
        <CountryPicker v-model="model.countryOfOrigin" store="name" placeholder="Switzerland" />
      </label>
      <label>
        <span>Phone</span>
        <input v-model="model.phone" type="tel" autocomplete="tel" />
      </label>
      <label>
        <span>Email</span>
        <input v-model="model.email" type="email" autocomplete="email" />
      </label>
      <label>
        <span>Currency</span>
        <CurrencyPicker v-model="currency" />
        <small>Your books are kept in this. New events start with it.</small>
      </label>
    </div>
  </div>
</template>

<style scoped>
.artist { display: flex; flex-direction: column; gap: .85rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .75rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
small { color: var(--zfy-muted); font-size: .78rem; }
</style>
