<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { Transaction } from '@zollify/shared';
import { CountryPicker } from '@zollify/ui';
import { LOGO_MAX_PX, RECEIPT_KEYS, buildReceiptLines, processLogoFile, processLogoForScreen, type ArtistInfo, type ReceiptLine } from '../receipt';
import { getSetting, setSetting } from '../lib/settings';
import { sdk } from '../runtime';
import ReceiptPreview from '../components/ReceiptPreview.vue';

/**
 * Receipts — ZollTool's settings: who is on the receipt, the default VAT
 * number plus per-country registrations (the event's country picks one), a
 * footer, the logo, auto-print, and a live preview of a sample sale so the
 * effect of every field is visible before anything is printed.
 */

const artist = reactive<Required<Pick<ArtistInfo, 'companyName' | 'fullName' | 'street' | 'postCodeCity' | 'countryOfOrigin' | 'phone' | 'email' | 'vatNumber'>> & { vatNumbers: { country: string; vatNumber: string }[] }>({
  companyName: '',
  fullName: '',
  street: '',
  postCodeCity: '',
  countryOfOrigin: '',
  phone: '',
  email: '',
  vatNumber: '',
  vatNumbers: [],
});
const footerText = ref('');
const autoPrint = ref(false);
const logoB64 = ref('');
const printLogoB64 = ref('');
const saved = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const stored = (await getSetting<ArtistInfo>(RECEIPT_KEYS.artist)) ?? {};
    // Blank fields fall back to the booth profile, so a fresh device prints something sensible.
    const profile = sdk().account()?.profile.artist;
    for (const k of ['companyName', 'fullName', 'street', 'postCodeCity', 'countryOfOrigin', 'phone', 'email'] as const) artist[k] = stored[k] || profile?.[k] || '';
    artist.vatNumber = stored.vatNumber ?? '';
    artist.vatNumbers = (stored.vatNumbers ?? []).map((v) => ({ country: v.country ?? '', vatNumber: v.vatNumber ?? '' }));
    footerText.value = (await getSetting<string>(RECEIPT_KEYS.footerText)) ?? '';
    autoPrint.value = (await getSetting<boolean>(RECEIPT_KEYS.autoPrint)) ?? false;
    logoB64.value = (await getSetting<string>(RECEIPT_KEYS.logoScreenB64)) ?? '';
    printLogoB64.value = (await getSetting<string>(RECEIPT_KEYS.logoB64)) ?? '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load receipt settings.';
  }
});

/**
 * Two versions of the logo are stored: the print copy is flattened onto white
 * (thermal printers have no alpha), the screen copy keeps transparency.
 */
async function chooseLogo(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  error.value = null;
  try {
    const [print, screen] = await Promise.all([processLogoFile(file), processLogoForScreen(file)]);
    await setSetting(RECEIPT_KEYS.logoB64, print);
    await setSetting(RECEIPT_KEYS.logoScreenB64, screen);
    logoB64.value = screen;
    printLogoB64.value = print;
    sdk().ui.toast('Logo updated.', { kind: 'success' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not read that image.';
  }
}
async function clearLogo(): Promise<void> {
  await setSetting(RECEIPT_KEYS.logoB64, '');
  await setSetting(RECEIPT_KEYS.logoScreenB64, '');
  logoB64.value = '';
  printLogoB64.value = '';
}

async function save(): Promise<void> {
  error.value = null;
  try {
    const clean: ArtistInfo = { ...artist, vatNumbers: artist.vatNumbers.filter((v) => v.country.trim() && v.vatNumber.trim()) };
    await setSetting(RECEIPT_KEYS.artist, JSON.parse(JSON.stringify(clean)));
    await setSetting(RECEIPT_KEYS.footerText, footerText.value);
    await setSetting(RECEIPT_KEYS.autoPrint, autoPrint.value);
    saved.value = true;
    setTimeout(() => (saved.value = false), 2500);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save those settings.';
  }
}

// ── Live preview: a sample sale, VAT resolved against a chosen country ──────
const previewCountry = ref('');
const currency = computed(() => sdk().account()?.profile.defaultCurrency ?? 'CHF');
const sampleTx = computed<Transaction>(() => ({
  id: 'PREVIEW000A1B2C3',
  eventId: 'preview',
  deviceId: 'preview',
  timestamp: Date.now(),
  method: 'card',
  currency: currency.value,
  total: 47,
  items: [
    { pid: 'p1', vid: null, title: 'Enamel pin — Dragon', qty: 2, unitPrice: 12, lineTotal: 24 },
    { pid: 'p2', vid: 'v1', title: 'Art print A4', variantLabel: 'Forest', qty: 1, unitPrice: 25, lineTotal: 25 },
  ],
  discounts: [{ name: 'Bundle deal', amount: 2 }],
  payments: [{ kind: 'card', amount: 47, provider: 'card', cardBrand: 'VISA', authCode: '004215', txRef: '304512780093' }],
}));
const previewLines = computed<ReceiptLine[]>(() =>
  buildReceiptLines(sampleTx.value, previewCountry.value ? `Convention · ${previewCountry.value}` : 'Sample Convention', { artist: { ...artist }, logoB64: printLogoB64.value, footerText: footerText.value }, previewCountry.value || undefined),
);
</script>

<template>
  <section class="receipts">
    <h2>Receipts</h2>
    <p class="hint">What a printed receipt says. Blank fields fall back to the booth profile.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div class="cols">
      <form class="form" @submit.prevent="save">
        <div class="grid">
          <label><span>Company / artist name</span><input v-model="artist.companyName" type="text" /></label>
          <label><span>Full name</span><input v-model="artist.fullName" type="text" /></label>
          <label><span>Street</span><input v-model="artist.street" type="text" autocomplete="street-address" /></label>
          <label><span>Postcode + city</span><input v-model="artist.postCodeCity" type="text" /></label>
          <label><span>Country</span><CountryPicker v-model="artist.countryOfOrigin" store="name" /></label>
          <label><span>Phone</span><input v-model="artist.phone" type="tel" /></label>
          <label><span>Email</span><input v-model="artist.email" type="email" /></label>
          <label><span>Default VAT / UID number</span><input v-model="artist.vatNumber" type="text" placeholder="CHE-123.456.789 MWST" /></label>
        </div>

        <fieldset>
          <legend>VAT numbers per country</legend>
          <p class="hint">Selling abroad under a local registration? The receipt uses the number matching the event's country; otherwise the default above.</p>
          <div v-for="(v, i) in artist.vatNumbers" :key="i" class="vatrow">
            <CountryPicker v-model="v.country" store="name" placeholder="Country" />
            <input v-model="v.vatNumber" type="text" placeholder="VAT number" aria-label="VAT number" />
            <button type="button" class="quiet" aria-label="Remove" @click="artist.vatNumbers.splice(i, 1)">×</button>
          </div>
          <button type="button" class="quiet add" @click="artist.vatNumbers.push({ country: '', vatNumber: '' })">+ Add country</button>
        </fieldset>

        <label><span>Footer text</span><textarea v-model="footerText" rows="2" placeholder="Thanks for visiting! No returns on prints."></textarea></label>
        <label class="inline"><input v-model="autoPrint" type="checkbox" /><span>Print automatically after each sale</span></label>
        <button type="submit" class="primary">Save</button>
        <p v-if="saved" class="ok" role="status">Saved.</p>

        <h3>Logo</h3>
        <p class="hint">Printed at the top of the receipt. Scaled to {{ LOGO_MAX_PX }}px wide and flattened onto white for the printer, which has no transparency.</p>
        <div class="logo">
          <img v-if="logoB64" :src="`data:image/png;base64,${logoB64}`" alt="Current receipt logo" />
          <div class="logo-actions">
            <input type="file" accept="image/*" aria-label="Choose a logo" @change="chooseLogo" />
            <button v-if="logoB64" type="button" class="quiet danger" @click="clearLogo">Remove</button>
          </div>
        </div>
      </form>

      <aside class="preview">
        <h3>Preview</h3>
        <label><span>Event country (for the VAT line)</span><CountryPicker v-model="previewCountry" store="name" placeholder="Any" /></label>
        <ReceiptPreview :lines="previewLines" />
      </aside>
    </div>
  </section>
</template>

<style scoped>
.receipts { display: flex; flex-direction: column; gap: .75rem; max-width: 64rem; }
h2 { margin: 0; font-size: 1.05rem; }
h3 { margin: .75rem 0 0; font-size: .95rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .85rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.ok { color: var(--zfy-accent-ink, #0a5a4a); margin: 0; font-size: .875rem; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem; align-items: start; }
.form { display: flex; flex-direction: column; gap: .7rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); align-items: flex-start; min-width: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .7rem; width: 100%; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; width: 100%; }
label.inline { flex-direction: row; align-items: center; gap: .4rem; }
fieldset { width: 100%; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .5rem; }
legend { font-size: .8rem; font-weight: 600; padding: 0 .3rem; }
.vatrow { display: grid; grid-template-columns: 1fr 1fr auto; gap: .4rem; align-items: center; }
.vatrow .quiet { min-height: 1.9rem; padding: 0 .5rem; }
.add { align-self: flex-start; color: var(--zfy-accent-ink, #0a5a4a); font-size: .8rem; min-height: 1.6rem; padding: 0 .3rem; }
.logo { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.logo img { max-width: 12rem; max-height: 6rem; background: #fff; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 6px; padding: .25rem; }
.logo-actions { display: flex; align-items: center; gap: .5rem; }
.preview { display: flex; flex-direction: column; gap: .5rem; position: sticky; top: 1rem; }
.preview h3 { margin: 0; }
.preview label { width: 20rem; max-width: 100%; }
@media (max-width: 900px) { .cols { grid-template-columns: 1fr; } .preview { position: static; } }
</style>
