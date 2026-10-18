<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { EconomicSettingsSchema, type EconomicSettings } from '@zollify/shared';
import { errorText, loadSettings, saveGrant, saveSettings, testConnection, type Connection } from '../api';

/**
 * Settings → e-conomic: the agreement to book into, and which account and
 * VAT code each part of a day goes to. The numbers come from the store's
 * chart of accounts (kontoplan) - their accountant knows them.
 */
const settings = ref<EconomicSettings>(EconomicSettingsSchema.parse({}));
const conn = ref<Connection | null>(null);
const token = ref('');
const vatRows = ref<{ rate: string; code: string }[]>([]);
const error = ref<string | null>(null);
const ok = ref<string | null>(null);

/**
 * Renters' accounts (shelf rent, commission, owed to renters) only mean
 * something to a store that consigns other people's goods - a shop selling
 * its own stock sees Sales, Cash and Card. The consignment module being on is
 * what says which kind of store this is.
 */
const router = useRouter();
const consignmentOn = computed(() => router.hasRoute('consignment:index'));
const ACCOUNTS: { key: keyof EconomicSettings['accounts']; label: string; hint: string; placeholder: string; renters?: boolean; agency?: boolean }[] = [
  { key: 'sales', label: 'Sales', hint: 'Your own goods', placeholder: 'e.g. 1010' },
  { key: 'rent', label: 'Shelf rent', hint: 'Space rent taken at the till, with VAT', placeholder: 'account number', renters: true },
  { key: 'commission', label: 'Commission', hint: "Your share of renters' sales", placeholder: 'account number', renters: true, agency: true },
  { key: 'renters', label: 'Owed to renters', hint: 'Liability until paid out', placeholder: 'account number', renters: true, agency: true },
  { key: 'cash', label: 'Cash', hint: 'Till cash', placeholder: 'account number' },
  { key: 'card', label: 'Card', hint: 'Card takings, before settlement', placeholder: 'account number' },
];
const shownAccounts = computed(() => ACCOUNTS.filter((a) => (!a.renters || consignmentOn.value) && (!a.agency || settings.value.consignment === 'agency')));

function take(res: { settings: EconomicSettings } & Connection): void {
  const { settings: s, ...c } = res;
  settings.value = s;
  conn.value = c;
  vatRows.value = Object.entries(s.vatCodes).map(([rate, code]) => ({ rate, code }));
}

onMounted(async () => {
  try {
    take(await loadSettings());
  } catch (err) {
    error.value = errorText(err, 'Could not load the settings.');
  }
});

async function save(): Promise<void> {
  error.value = ok.value = null;
  try {
    const vatCodes = Object.fromEntries(vatRows.value.filter((r) => r.rate.trim() && r.code.trim()).map((r) => [r.rate.trim(), r.code.trim()]));
    // An emptied number field reads as "" - it means "not set".
    const accounts = Object.fromEntries(Object.entries(settings.value.accounts).map(([k, v]) => [k, typeof v === 'number' ? v : null])) as EconomicSettings['accounts'];
    take(await saveSettings({ ...settings.value, accounts, vatCodes }));
    ok.value = 'Saved.';
  } catch (err) {
    error.value = errorText(err, 'Could not save.');
  }
}

async function connect(): Promise<void> {
  error.value = ok.value = null;
  try {
    conn.value = await saveGrant(token.value.trim());
    token.value = '';
    const t = await testConnection();
    ok.value = `Connected to ${t.company ?? 'e-conomic'}${t.agreementNumber ? ` (agreement ${t.agreementNumber})` : ''}.`;
  } catch (err) {
    error.value = errorText(err, 'Could not connect.');
  }
}

async function disconnect(): Promise<void> {
  conn.value = await saveGrant(null);
}
</script>

<template>
  <section class="settings">
    <h2>e-conomic</h2>
    <p class="hint">Each closed day of sales is booked into an e-conomic journal as one voucher. Nothing is posted: your accountant checks the journal and posts it there.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="ok" class="ok">{{ ok }}</p>

    <h3>Agreement</h3>
    <p v-if="conn && !conn.server" class="error">This server is not registered with e-conomic yet - whoever runs it has to add Zollify's e-conomic app secret before any agreement can connect.</p>
    <p v-if="conn?.grant" class="ok">An agreement is connected.</p>
    <p class="hint">The agreement grant token is what e-conomic hands you when you approve an app for your agreement: it comes from your e-conomic agreement's app settings, where the Zollify app is listed. Paste it here; it is kept encrypted and never shown again. Your accountant or e-conomic support can help if you cannot find it.</p>
    <div class="row">
      <label class="grow"><span>Agreement grant token{{ conn?.grant ? ' (paste a new one to replace it)' : '' }}</span><input v-model="token" type="password" autocomplete="off" /></label>
      <button type="button" class="primary" :disabled="token.trim().length < 10" @click="connect">Connect</button>
      <button v-if="conn?.grant" type="button" class="quiet" @click="disconnect">Disconnect</button>
    </div>

    <h3 v-if="consignmentOn">Renters' goods</h3>
    <template v-if="consignmentOn">
    <label class="check"><input v-model="settings.consignment" type="radio" value="agency" /> <span><strong>As agent (formidler)</strong> - only your commission is revenue, with VAT; the renter's share is owed to them</span></label>
    <label class="check"><input v-model="settings.consignment" type="radio" value="commission" /> <span><strong>Commission sale (kommissionssalg)</strong> - you sell in your own name: the full price is revenue, with VAT</span></label>
    <p class="hint">Ask your accountant which one applies to you.</p>
    </template>

    <h3>Accounts</h3>
    <p class="hint">Account numbers from your chart of accounts (kontoplan) in e-conomic - your accountant knows them.</p>
    <div class="grid">
      <label><span>Journal number</span><input v-model.number="settings.journalNumber" type="number" min="1" /></label>
      <label v-for="a in shownAccounts" :key="a.key">
        <span>{{ a.label }} <small>{{ a.hint }}</small></span>
        <input v-model.number="settings.accounts[a.key]" type="number" min="1" :placeholder="a.placeholder" />
      </label>
    </div>

    <h3>VAT codes</h3>
    <p class="hint">The e-conomic VAT code for each rate you sell at. Standard Danish output VAT is usually U25.</p>
    <div v-for="(r, i) in vatRows" :key="i" class="row">
      <label><span>Rate %</span><input v-model="r.rate" type="text" inputmode="decimal" /></label>
      <label><span>VAT code</span><input v-model="r.code" type="text" /></label>
      <button type="button" class="quiet" @click="vatRows.splice(i, 1)">Remove</button>
    </div>
    <button type="button" class="quiet" @click="vatRows.push({ rate: '', code: '' })">Add a rate</button>

    <button type="button" class="primary" @click="save">Save</button>
  </section>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: .7rem; max-width: 40rem; }
h2 { margin: 0; font-size: 1.05rem; }
h3 { margin: .6rem 0 0; font-size: .95rem; }
.hint, small { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: .55rem .7rem; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; }
.check { flex-direction: row; align-items: flex-start; gap: .5rem; font-size: .86rem; }
.row { display: flex; gap: .5rem; align-items: flex-end; flex-wrap: wrap; }
.grow { flex: 1; min-width: 12rem; }
button.primary { align-self: flex-start; }
@media (max-width: 520px) { .grid { grid-template-columns: 1fr; } }
</style>
