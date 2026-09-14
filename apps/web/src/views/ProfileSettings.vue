<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ArtistDetails } from '@zollify/shared';
import { currentAccount, updateProfile } from '@zollify/platform';
import ArtistForm from '../components/ArtistForm.vue';

const account = currentAccount;
const canRename = computed(() => account.value?.role === 'owner');

const name = ref(account.value?.accountName ?? '');
const artist = ref<ArtistDetails>({ ...account.value!.profile.artist });
const currency = ref(account.value!.profile.defaultCurrency);
const saved = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

async function save(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await updateProfile({
      artist: artist.value,
      ...(/^[A-Za-z]{3}$/.test(currency.value.trim()) ? { defaultCurrency: currency.value.trim().toUpperCase() } : {}),
      ...(canRename.value && name.value.trim() ? { name: name.value.trim() } : {}),
    });
    saved.value = true;
    setTimeout(() => (saved.value = false), 2500);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the profile.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="profile" @submit.prevent="save">
    <h2>Booth profile</h2>
    <p class="hint">
      Who is behind the table. Printed on receipts and customs paperwork, and shared by every device
      on this account.
    </p>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <ArtistForm v-model="artist" v-model:name="name" v-model:currency="currency" :can-rename="canRename" />

    <div class="row">
      <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Saving…' : 'Save' }}</button>
      <p v-if="saved" class="ok" role="status">Saved.</p>
      <router-link class="again" :to="{ name: 'welcome' }">Run setup again</router-link>
    </div>
  </form>
</template>

<style scoped>
.profile { display: flex; flex-direction: column; gap: .85rem; max-width: 40rem; }
h2 { font-size: 1.05rem; margin: 0; }
.hint { color: var(--zfy-muted); margin: 0; font-size: .875rem; }
.row { display: flex; align-items: center; gap: .75rem; }
.ok { color: var(--zfy-success); margin: 0; }
.error { color: var(--zfy-danger); margin: 0; }
.again { margin-left: auto; font-size: .85rem; color: var(--zfy-muted); }
</style>
