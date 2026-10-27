<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { DEFAULT_LOYALTY_SETTINGS, LoyaltySettingsSchema, fmtPrice, rewardLabel, type LoyaltySettings } from '@zollify/shared';
import { QrCode } from '@zollify/ui';
import { api, errorText, type GoogleView } from '../api';
import { sdk } from '../runtime';

/**
 * Settings → Loyalty card: the programme (stamps or points, what a sale
 * earns, what a reward is and costs), the join link for the table, and the
 * Google Wallet issuer that turns cards into passes on the phone.
 */
const form = ref<LoyaltySettings>({ ...DEFAULT_LOYALTY_SETTINGS });
const rewardKind = ref<'amount' | 'percent' | 'item'>('amount');
const rewardValue = ref('5');
const joinUrl = ref('');
const currency = ref('EUR');
const emailEnabled = ref(true);
const members = ref(0);
const google = ref<GoogleView | null>(null);
const gForm = ref({ issuerId: '', serviceAccountJson: '', logoUrl: '' });
const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const ok = ref<string | null>(null);

const money = (n: number) => fmtPrice(n, currency.value);
const preview = computed(() => {
  const parsed = LoyaltySettingsSchema.safeParse({ ...form.value, reward: rewardOf() });
  return parsed.success ? rewardLabel(parsed.data, money) : '';
});
function rewardOf(): LoyaltySettings['reward'] {
  const v = Number(String(rewardValue.value).replace(',', '.')) || 0;
  return rewardKind.value === 'amount' ? { kind: 'amount', amount: v } : rewardKind.value === 'percent' ? { kind: 'percent', percent: v } : { kind: 'item', upTo: v };
}
function take(s: LoyaltySettings): void {
  form.value = { ...s };
  rewardKind.value = s.reward.kind;
  rewardValue.value = String(s.reward.kind === 'amount' ? s.reward.amount : s.reward.kind === 'percent' ? s.reward.percent : s.reward.upTo);
}

onMounted(async () => {
  try {
    const res = await api.settings();
    take(res.settings);
    joinUrl.value = res.joinUrl;
    currency.value = res.currency;
    emailEnabled.value = res.emailEnabled;
    members.value = res.members;
    google.value = res.google;
    if (res.google) gForm.value = { issuerId: res.google.issuerId, serviceAccountJson: '', logoUrl: res.google.logoUrl };
  } catch (err) {
    error.value = errorText(err, 'Could not load the loyalty settings.');
  }
});

async function save(): Promise<void> {
  error.value = ok.value = null;
  const parsed = LoyaltySettingsSchema.safeParse({ ...form.value, reward: rewardOf() });
  if (!parsed.success) return void (error.value = 'Check the figures: whole stamps, a reward above zero, a percentage up to 100.');
  busy.value = 'save';
  try {
    const res = await api.saveSettings(parsed.data);
    take(res.settings);
    ok.value = 'Saved. Cards already out follow the new rules from the next sale; use Recount under Loyalty to apply them to past sales.';
  } catch (err) {
    error.value = errorText(err, 'Could not save.');
  } finally {
    busy.value = null;
  }
}
async function newLink(): Promise<void> {
  if (!(await sdk().ui.confirm('The join QR on the table stops working; print the new one. Cards already out are not affected.', 'New join link?', { confirm: 'New link' }))) return;
  try {
    joinUrl.value = (await api.newJoinLink()).joinUrl;
  } catch (err) {
    error.value = errorText(err, 'Could not make a new link.');
  }
}
async function pickKey(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (file) gForm.value.serviceAccountJson = await file.text();
}
async function saveGoogle(): Promise<void> {
  error.value = ok.value = null;
  if (!gForm.value.serviceAccountJson && !google.value) return void (error.value = 'Pick the service account JSON file.');
  busy.value = 'google';
  try {
    if (!gForm.value.serviceAccountJson) return void (error.value = 'To change the issuer or logo, pick the service account file again - the key is never shown back.');
    const res = await api.saveGoogle({ issuerId: gForm.value.issuerId.trim(), serviceAccountJson: gForm.value.serviceAccountJson, logoUrl: gForm.value.logoUrl.trim() });
    google.value = { issuerId: gForm.value.issuerId.trim(), clientEmail: res.clientEmail, logoUrl: gForm.value.logoUrl.trim(), updatedAt: Date.now() };
    gForm.value.serviceAccountJson = '';
    ok.value = 'Google Wallet is on: the programme is on Google\'s side, and every card page now offers "Add to Google Wallet".';
  } catch (err) {
    error.value = errorText(err, 'Google did not accept the details.');
  } finally {
    busy.value = null;
  }
}
async function removeGoogle(): Promise<void> {
  if (!(await sdk().ui.confirm('Passes already saved stop updating; the cards on the web keep working.', 'Remove Google Wallet?', { confirm: 'Remove' }))) return;
  try {
    await api.removeGoogle();
    google.value = null;
    gForm.value = { issuerId: '', serviceAccountJson: '', logoUrl: '' };
  } catch (err) {
    error.value = errorText(err, 'Could not remove it.');
  }
}
</script>

<template>
  <section class="setup">
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="ok" class="ok">{{ ok }}</p>

    <form class="card" @submit.prevent="save">
      <h2>The programme</h2>
      <p class="hint">{{ preview || 'What a reward is and what it costs.' }} · {{ members }} member{{ members === 1 ? '' : 's' }} so far.</p>
      <div class="grid">
        <label class="wide"><span>Name on the card</span><input v-model="form.programme" type="text" maxlength="60" placeholder="Ink Booth stamp card" /></label>
        <label><span>Collect</span>
          <select v-model="form.scheme"><option value="stamps">Stamps per spend</option><option value="points">Points per {{ currency }} 1</option></select>
        </label>
        <label v-if="form.scheme === 'stamps'"><span>One stamp for every ({{ currency }})</span><input v-model.number="form.stampEvery" type="number" min="0.01" step="0.01" /></label>
        <label v-else><span>Points per {{ currency }} 1</span><input v-model.number="form.pointsPerUnit" type="number" min="0.01" step="0.01" /></label>
        <label><span>A reward costs ({{ form.scheme }})</span><input v-model.number="form.rewardCost" type="number" min="1" step="1" /></label>
        <label><span>The reward is</span>
          <select v-model="rewardKind"><option value="amount">An amount off</option><option value="percent">A percentage off one sale</option><option value="item">A free item up to a price</option></select>
        </label>
        <label><span>{{ rewardKind === 'amount' ? `Amount off (${currency})` : rewardKind === 'percent' ? 'Percent off' : `Item up to (${currency})` }}</span><input v-model="rewardValue" type="text" inputmode="decimal" /></label>
        <label><span>Sales below this earn nothing ({{ currency }}, 0 for any)</span><input v-model.number="form.minSpend" type="number" min="0" step="0.01" /></label>
        <label><span>Erase a card unused for (months, 0 never)</span><input v-model.number="form.eraseAfterMonths" type="number" min="0" max="120" step="1" /></label>
        <label class="wide"><span>A line on the join page</span><input v-model="form.joinIntro" type="text" maxlength="400" placeholder="Thanks for coming back - every visit counts." /></label>
        <label><span>Barcode on the Google Wallet pass</span>
          <select v-model="form.passBarcode"><option value="qr">QR code (a phone camera opens the card too)</option><option value="code128">Code 128 bars (for a handheld barcode scanner)</option></select>
        </label>
        <label class="wide check"><input v-model="form.staffMaySet" type="checkbox" /> <span>Staff may set a card's balance at the till - for moving customers over from an old card. Each change is logged with who made it, under Loyalty, where you can change or remove it.</span></label>
      </div>
      <div class="actions"><button type="submit" class="primary" :disabled="busy === 'save'">Save</button></div>
    </form>

    <article class="card">
      <h2>Joining</h2>
      <p class="hint">Customers scan this at the table, enter their email, confirm it, and get their card. Print it from Loyalty.</p>
      <p v-if="!emailEnabled" class="error">This server cannot send email, so nobody can join yet - set SMTP_URL and MAIL_FROM on the server.</p>
      <div class="join">
        <QrCode v-if="joinUrl" :value="joinUrl" :size="160" label="Join QR code" />
        <div class="joinmeta"><code>{{ joinUrl }}</code><button type="button" class="quiet" @click="newLink">New link</button></div>
      </div>
    </article>

    <form class="card" @submit.prevent="saveGoogle">
      <h2>Google Wallet</h2>
      <p class="hint">Turns the card into a pass on the phone that updates after each sale. Needs a Google Wallet issuer account (free, <a href="https://pay.google.com/business/console" target="_blank" rel="noopener">pay.google.com/business/console</a>): the issuer id from there, and a service account key from Google Cloud with the Wallet Objects API on. Google reviews the programme before passes work for everyone; until then only test users in the console see them.</p>
      <p v-if="google" class="ok">On, as {{ google.clientEmail }} · issuer {{ google.issuerId }}.</p>
      <div class="grid">
        <label><span>Issuer id</span><input v-model="gForm.issuerId" type="text" inputmode="numeric" placeholder="3388000000012345678" /></label>
        <label><span>Logo URL (Google requires one)</span><input v-model="gForm.logoUrl" type="url" placeholder="https://…/logo.png" /></label>
        <label class="wide file"><span>Service account key (JSON file)</span><input type="file" accept="application/json,.json" @change="pickKey" /><small v-if="gForm.serviceAccountJson">File read - never shown back once saved.</small></label>
      </div>
      <div class="actions">
        <button type="submit" class="primary" :disabled="busy === 'google'">{{ busy === 'google' ? 'Checking with Google…' : google ? 'Update' : 'Turn on' }}</button>
        <button v-if="google" type="button" class="quiet danger" @click="removeGoogle">Remove</button>
      </div>
      <p class="hint">Apple Wallet is not offered yet.</p>
    </form>
  </section>
</template>

<style scoped>
.setup { display: flex; flex-direction: column; gap: 1rem; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .75rem; }
h2 { margin: 0; font-size: 1.05rem; }
.hint { margin: 0; font-size: .9rem; color: var(--zfy-muted, #5a6472); max-width: 70ch; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .9rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: .6rem; }
.grid label { display: flex; flex-direction: column; gap: .2rem; font-size: .8rem; }
.grid .wide { grid-column: 1 / -1; }
.file small { color: var(--zfy-muted, #5a6472); }
.grid .check { flex-direction: row; align-items: flex-start; gap: .5rem; font-size: .85rem; }
.grid .check input { margin-top: .2rem; }
.actions { display: flex; gap: .4rem; }
.join { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
.joinmeta { display: flex; flex-direction: column; gap: .4rem; min-width: 0; }
.joinmeta code { font-size: .78rem; word-break: break-all; }
</style>
