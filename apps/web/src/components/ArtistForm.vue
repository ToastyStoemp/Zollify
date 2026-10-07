<script setup lang="ts">
import { computed } from 'vue';
import { EMPTY_PROFILE_LINKS, hasProfileLinks, isBelgium, vatFromEnterpriseNumber, type ArtistDetails, type ProfileLinks } from '@zollify/shared';
import { CountryPicker, CurrencyPicker } from '@zollify/ui';

/**
 * The booth's identity, asked once: on customs paperwork, receipts, e-invoices
 * and the links under an online receipt. Modules read it from here instead of
 * asking again. Shared by the first-run wizard and the Business profile settings
 * panel so the two can never drift apart in what they ask for.
 */
const model = defineModel<ArtistDetails>({ required: true });
const props = defineProps<{ canRename: boolean }>();
const name = defineModel<string>('name', { default: '' });
const currency = defineModel<string>('currency', { default: 'CHF' });
const links = defineModel<ProfileLinks>('links', { default: () => ({ ...EMPTY_PROFILE_LINKS }) });

const belgian = computed(() => isBelgium(model.value.countryOfOrigin) || !!model.value.enterpriseNumber);
const linksOpen = computed(() => hasProfileLinks(links.value));

/** A valid enterprise number is also the Belgian VAT number, unless one is already given. */
function fillVat(): void {
  const vat = vatFromEnterpriseNumber(model.value.enterpriseNumber ?? '');
  if (vat && !model.value.vatId.trim()) model.value.vatId = vat;
}
</script>

<template>
  <div class="artist">
    <label v-if="props.canRename" class="wide">
      <span>Business name</span>
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
        <span>VAT / tax ID</span>
        <input v-model="model.vatId" type="text" class="mono" placeholder="DE123456789" />
      </label>
      <label v-if="belgian">
        <span>Enterprise number (Belgium)</span>
        <input v-model="model.enterpriseNumber" type="text" class="mono" placeholder="0123.456.749" @blur="fillVat" />
        <small>KBO/BCE. Fills the VAT number if that is empty, and your e-invoices use it.</small>
      </label>
      <label>
        <span>EORI number</span>
        <input v-model="model.eori" type="text" class="mono" />
        <small>Required on EU export declarations - Germany, not Switzerland.</small>
      </label>
      <label>
        <span>Currency</span>
        <CurrencyPicker v-model="currency" />
        <small>Your books are kept in this. New events start with it.</small>
      </label>
    </div>

    <details class="online" :open="linksOpen">
      <summary>Webstore and socials <span class="opt">(optional)</span></summary>
      <p class="note">Shown as "find us online" under your online receipts, and printed on paper if you switch that on in POS → Receipts. Link starting with https://; Instagram and TikTok also take a plain handle.</p>
      <div class="grid">
        <label><span>Webstore</span><input v-model="links.webstore" type="text" inputmode="url" placeholder="https://shop.example.com" /></label>
        <label><span>Instagram</span><input v-model="links.instagram" type="text" placeholder="@yourshop" /></label>
        <label><span>TikTok</span><input v-model="links.tiktok" type="text" placeholder="@yourshop" /></label>
        <label><span>Facebook</span><input v-model="links.facebook" type="text" inputmode="url" placeholder="https://facebook.com/yourshop" /></label>
        <label><span>Bluesky</span><input v-model="links.bluesky" type="text" inputmode="url" placeholder="https://bsky.app/profile/you.bsky.social" /></label>
        <label><span>Mastodon</span><input v-model="links.mastodon" type="text" inputmode="url" placeholder="https://mastodon.social/@you" /></label>
        <label><span>YouTube</span><input v-model="links.youtube" type="text" inputmode="url" placeholder="https://youtube.com/@yourshop" /></label>
        <label><span>Other link label</span><input v-model="links.otherLabel" type="text" maxlength="30" placeholder="Newsletter" /></label>
        <label><span>Other link</span><input v-model="links.otherUrl" type="text" inputmode="url" placeholder="https://" /></label>
      </div>
    </details>
  </div>
</template>

<style scoped>
.artist { display: flex; flex-direction: column; gap: .85rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .75rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
small { color: var(--zfy-muted); font-size: .78rem; }
.online { border: 1px solid var(--zfy-line); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .6rem; }
.online summary { cursor: pointer; font-weight: 600; font-size: .9rem; }
.online[open] summary { margin-bottom: .5rem; }
.opt { font-weight: 400; color: var(--zfy-muted); }
.note { margin: 0 0 .6rem; color: var(--zfy-muted); font-size: .8rem; }
.mono { font-family: ui-monospace, monospace; font-size: .85rem; }
</style>
