<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { LOGO_MAX_PX, RECEIPT_KEYS, processLogoFile, processLogoForScreen } from '../receipt';
import { getSetting, setSetting } from '../lib/settings';
import { sdk } from '../runtime';

interface ArtistInfo {
  companyName?: string;
  addressLine?: string;
  city?: string;
  country?: string;
  vatNumber?: string;
  email?: string;
  website?: string;
}

const artist = ref<ArtistInfo>({});
const footerText = ref('');
const autoPrint = ref(false);
const logoB64 = ref('');
const saved = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    artist.value = (await getSetting<ArtistInfo>(RECEIPT_KEYS.artist)) ?? {};
    footerText.value = (await getSetting<string>(RECEIPT_KEYS.footerText)) ?? '';
    autoPrint.value = (await getSetting<boolean>(RECEIPT_KEYS.autoPrint)) ?? false;
    logoB64.value = (await getSetting<string>(RECEIPT_KEYS.logoScreenB64)) ?? '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load receipt settings.';
  }
});

/**
 * Two versions of the logo are stored.
 *
 * Thermal printers have no alpha channel, so the print copy is flattened onto
 * white; the screen copy keeps transparency for the customer display. Deriving
 * both here means the source image is only asked for once.
 */
async function chooseLogo(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  error.value = null;
  try {
    const [print, screen] = await Promise.all([
      processLogoFile(file),
      processLogoForScreen(file),
    ]);
    await setSetting(RECEIPT_KEYS.logoB64, print);
    await setSetting(RECEIPT_KEYS.logoScreenB64, screen);
    logoB64.value = screen;
    sdk().ui.toast('Logo updated.', { kind: 'success' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not read that image.';
  }
}

async function clearLogo(): Promise<void> {
  await setSetting(RECEIPT_KEYS.logoB64, '');
  await setSetting(RECEIPT_KEYS.logoScreenB64, '');
  logoB64.value = '';
}

async function save(): Promise<void> {
  error.value = null;
  try {
    await setSetting(RECEIPT_KEYS.artist, artist.value);
    await setSetting(RECEIPT_KEYS.footerText, footerText.value);
    await setSetting(RECEIPT_KEYS.autoPrint, autoPrint.value);
    saved.value = true;
    setTimeout(() => (saved.value = false), 2500);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save those settings.';
  }
}
</script>

<template>
  <section class="receipts">
    <h2>Receipts</h2>
    <p class="hint">
      What appears on a printed receipt. Shared with customs paperwork where the same details apply.
    </p>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <form class="form" @submit.prevent="save">
      <div class="grid">
        <label><span>Business name</span><input v-model="artist.companyName" type="text" /></label>
        <label><span>VAT number</span><input v-model="artist.vatNumber" type="text" /></label>
        <label><span>Address</span><input v-model="artist.addressLine" type="text" autocomplete="street-address" /></label>
        <label><span>City</span><input v-model="artist.city" type="text" /></label>
        <label><span>Country</span><input v-model="artist.country" type="text" maxlength="2" /></label>
        <label><span>Email</span><input v-model="artist.email" type="email" /></label>
        <label><span>Website</span><input v-model="artist.website" type="text" /></label>
      </div>

      <label>
        <span>Footer text</span>
        <textarea v-model="footerText" rows="2" placeholder="Thanks for visiting!"></textarea>
      </label>

      <label class="inline">
        <input v-model="autoPrint" type="checkbox" />
        <span>Print automatically after each sale</span>
      </label>

      <button type="submit">Save</button>
      <p v-if="saved" class="ok" role="status">Saved.</p>
    </form>

    <h3>Logo</h3>
    <p class="hint">
      Printed at the top of the receipt. Scaled to {{ LOGO_MAX_PX }}px wide and flattened onto white
      for the printer, which has no transparency.
    </p>
    <div class="logo">
      <img v-if="logoB64" :src="`data:image/png;base64,${logoB64}`" alt="Current receipt logo" />
      <div class="logo-actions">
        <input type="file" accept="image/*" aria-label="Choose a logo" @change="chooseLogo" />
        <button v-if="logoB64" type="button" @click="clearLogo">Remove</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.receipts { display: flex; flex-direction: column; gap: .75rem; max-width: 40rem; }
h2 { margin: 0; font-size: 1.05rem; }
h3 { margin: .75rem 0 0; font-size: .95rem; }
.hint { color: var(--bly-muted, #5a6472); margin: 0; font-size: .875rem; }
.error { color: var(--bly-danger, #c6512f); margin: 0; }
.ok { color: var(--bly-accent-ink, #0a5a4a); margin: 0; font-size: .875rem; }
.form { display: flex; flex-direction: column; gap: .7rem; border: 1px solid var(--bly-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--bly-surface, #fff); align-items: flex-start; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .7rem; width: 100%; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; width: 100%; }
label.inline { flex-direction: row; align-items: center; gap: .4rem; }
.logo { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.logo img { max-width: 12rem; max-height: 6rem; background: #fff; border: 1px solid var(--bly-line, #d6dde4); border-radius: 6px; padding: .25rem; }
.logo-actions { display: flex; align-items: center; gap: .5rem; }
</style>
