<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { emptyPeppolSettings, peppolOverrides, peppolSellerFromProfile, type PeppolSeller, type PeppolSettings } from '@zollify/shared';
import { errorText, loadSettings, saveAccessPoint, saveSettings, type AccessPointInfo, type ProviderInfo } from '../api';
import { sdk } from '../runtime';
import PartyFields from './PartyFields.vue';

/**
 * Settings → E-invoices (Peppol): numbering, payment details, the
 * small-business exemption, and the Peppol access point that sends your
 * invoices. Who the seller is comes from the Business profile; a field here is
 * only kept when invoices must differ from it, like the customs declarant.
 */
const settings = ref<PeppolSettings>({ ...emptyPeppolSettings(), country: '', peppolScheme: '' });
/** What the Business profile gives, from the live profile until the server answers. */
const fromProfile = ref<PeppolSeller>(peppolSellerFromProfile(sdk().account()?.profile.artist));
const providers = ref<ProviderInfo[]>([]);
const access = ref<AccessPointInfo | null>(null);
const ap = reactive({ provider: '', apiKey: '', accountRef: '', sandbox: true });
const error = ref<string | null>(null);
const ok = ref<string | null>(null);

onMounted(async () => {
  try {
    const res = await loadSettings();
    settings.value = res.overrides;
    fromProfile.value = res.fromProfile;
    providers.value = res.providers;
    access.value = res.accessPoint;
    Object.assign(ap, { provider: res.accessPoint?.provider ?? res.providers[0]?.id ?? '', apiKey: '', accountRef: res.accessPoint?.accountRef ?? '', sandbox: res.accessPoint?.sandbox ?? true });
  } catch (err) {
    error.value = errorText(err, 'Could not load the settings.');
  }
});

async function save(): Promise<void> {
  error.value = ok.value = null;
  try {
    // Only what differs from the profile is stored; the rest keeps following it.
    const res = await saveSettings(peppolOverrides(settings.value, sdk().account()?.profile.artist));
    settings.value = res.overrides;
    fromProfile.value = res.fromProfile;
    ok.value = 'Saved.';
  } catch (err) {
    error.value = errorText(err, 'Could not save.');
  }
}
async function saveAp(): Promise<void> {
  error.value = ok.value = null;
  try {
    access.value = (await saveAccessPoint({ provider: ap.provider, apiKey: ap.apiKey.trim(), accountRef: ap.accountRef.trim(), sandbox: ap.sandbox })).accessPoint;
    ap.apiKey = '';
    ok.value = 'Access point saved.';
  } catch (err) {
    error.value = errorText(err, 'Could not save the access point.');
  }
}
async function removeAp(): Promise<void> {
  await saveAccessPoint(null);
  access.value = null;
}
</script>

<template>
  <section class="settings">
    <h2>E-invoices for Belgium (Peppol)</h2>
    <p class="hint">From 2026 Belgian businesses send each other invoices over Peppol. Fill in your details once; invoices are checked against the Peppol rules before they are issued.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="ok" class="ok">{{ ok }}</p>

    <h3>Your business</h3>
    <p class="hint from-profile">
      Name, address, VAT number, enterprise number and email come from your Business profile - change them once, there.
      <router-link :to="{ name: 'settings', query: { panel: 'core.profile' } }">Edit Business profile</router-link>
      Fill in a field below only when your invoices must say something different; a blank field follows the profile.
    </p>
    <PartyFields v-model="settings" :profile="fromProfile" />
    <div class="grid">
      <label><span>IBAN</span><input v-model="settings.iban" type="text" placeholder="BE68 5390 0754 7034" /></label>
      <label><span>BIC (optional)</span><input v-model="settings.bic" type="text" /></label>
      <label><span>Invoice numbers start with</span><input v-model="settings.invoicePrefix" type="text" placeholder="INV" /></label>
      <label><span>Credit notes start with</span><input v-model="settings.creditPrefix" type="text" placeholder="CN" /></label>
      <label><span>Payment term (days)</span><input v-model.number="settings.paymentDays" type="number" min="0" max="365" /></label>
    </div>
    <p class="hint">Numbers run per year without gaps: {{ settings.invoicePrefix || '' }}{{ settings.invoicePrefix ? '-' : '' }}{{ new Date().getFullYear() }}-0001, -0002… A number is only taken when an invoice is issued, so discarded drafts leave no holes.</p>
    <label class="check"><input v-model="settings.smallBusinessExempt" type="checkbox" /> <span><strong>Small-business VAT exemption</strong> (art. 56bis) - invoices carry no VAT and the legal mention</span></label>
    <label class="block"><span>Note on every invoice (optional)</span><textarea v-model="settings.defaultNote" rows="2" placeholder="Payment terms, late-payment interest…" /></label>
    <button type="button" class="primary" @click="save">Save details</button>

    <h3>Sending</h3>
    <p class="hint">Peppol invoices travel through an access point: a certified provider you have an account with, which also registers you to receive invoices (required too). Connect yours with its API key and Zollify sends issued invoices for you. With any other provider, download each invoice's XML and upload it there.</p>
    <p v-if="access" class="ok">Connected: {{ providers.find((p) => p.id === access!.provider)?.name ?? access.provider }}.</p>
    <div class="grid">
      <label>
        <span>Access point</span>
        <select v-model="ap.provider"><option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option></select>
      </label>
      <label><span>API key{{ access ? ' (leave empty to keep)' : '' }}</span><input v-model="ap.apiKey" type="password" autocomplete="off" /></label>
      <label><span>Your account id there</span><input v-model="ap.accountRef" type="text" placeholder="Storecove legal entity id" /></label>
    </div>
    <p v-if="providers.find((p) => p.id === ap.provider)" class="hint">{{ providers.find((p) => p.id === ap.provider)!.note }} <a :href="providers.find((p) => p.id === ap.provider)!.site" target="_blank" rel="noopener noreferrer">Website</a></p>
    <div class="row">
      <button type="button" class="primary" :disabled="!ap.provider" @click="saveAp">Save access point</button>
      <button v-if="access" type="button" class="quiet" @click="removeAp">Disconnect</button>
    </div>
  </section>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: .7rem; max-width: 40rem; }
h2 { margin: 0; font-size: 1.05rem; }
h3 { margin: .6rem 0 0; font-size: .95rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.from-profile a { margin-left: .25rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: .55rem .7rem; }
.grid label, .block { display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; }
.check { display: flex; align-items: flex-start; gap: .5rem; font-size: .86rem; }
.row { display: flex; gap: .5rem; }
button.primary { align-self: flex-start; }
@media (max-width: 520px) { .grid { grid-template-columns: 1fr; } }
</style>
