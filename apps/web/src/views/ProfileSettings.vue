<script setup lang="ts">
import { computed, ref } from 'vue';
import { EMPTY_PROFILE_LINKS, isStore, sellsAt, type ArtistDetails, type ProfileLinks } from '@zollify/shared';
import { currentAccount, updateProfile, visibleEvents } from '@zollify/platform';
import ArtistForm from '../components/ArtistForm.vue';

const account = currentAccount;
const canRename = computed(() => account.value?.role === 'owner');

const name = ref(account.value?.accountName ?? '');
const artist = ref<ArtistDetails>({ ...account.value!.profile.artist });
const links = ref<ProfileLinks>({ ...EMPTY_PROFILE_LINKS, ...account.value!.profile.links });
const currency = ref(account.value!.profile.defaultCurrency);
/** What the account runs: which of the Events and Stores pages it gets. */
const runs = ref({ ...sellsAt(account.value!.profile, visibleEvents.value.some((e) => isStore(e))) });
const saved = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

async function save(): Promise<void> {
  if (!runs.value.events && !runs.value.stores) {
    error.value = 'Pick events, stores or both.';
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    await updateProfile({
      sells: { ...runs.value },
      artist: artist.value,
      links: { ...links.value },
      ...(/^[A-Za-z]{3}$/.test(currency.value.trim()) ? { defaultCurrency: currency.value.trim().toUpperCase() } : {}),
      ...(canRename.value && name.value.trim() ? { name: name.value.trim() } : {}),
    });
    // Show what the server kept: links in their canonical form, the enterprise number dotted.
    artist.value = { ...account.value!.profile.artist };
    links.value = { ...EMPTY_PROFILE_LINKS, ...account.value!.profile.links };
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
    <h2>Business profile</h2>
    <p class="hint">
      Who is behind the table. Filled in once here, and used by receipts, customs paperwork and e-invoices
      instead of each asking again. Shared by every device on this account.
    </p>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <fieldset class="runs">
      <legend>What you run</legend>
      <label><input v-model="runs.events" type="checkbox" /> Events <span class="hint">- fairs, markets, conventions</span></label>
      <label><input v-model="runs.stores" type="checkbox" /> Stores <span class="hint">- shops, open until you close them</span></label>
      <p class="hint">Shows the Events page, the Stores page, or both. Nothing is deleted when you switch one off.</p>
    </fieldset>

    <ArtistForm v-model="artist" v-model:links="links" v-model:name="name" v-model:currency="currency" :can-rename="canRename" />

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
.runs { border: 1px solid var(--zfy-line); border-radius: 10px; padding: .6rem .8rem; margin: 0; display: flex; flex-direction: column; gap: .35rem; }
.runs legend { font-weight: 600; font-size: .9rem; padding: 0 .3rem; }
.runs label { display: flex; align-items: center; gap: .45rem; font-size: .9rem; }
</style>
