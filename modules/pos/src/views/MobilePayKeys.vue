<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { clearMobilepayKeys, loadMobilepayStatus, saveMobilepayKeys, type MobilepayStatus } from '../payments/mobilepay';

/**
 * Settings → Payments → MobilePay: the account's API keys from the Vipps
 * MobilePay business portal. Checked against MobilePay before they are
 * kept, and kept on the server only - the form shows whether keys are set,
 * never the keys themselves.
 */
const emit = defineEmits<{ changed: [] }>();

const status = ref<MobilepayStatus | null>(null);
const form = reactive({ env: 'production' as 'test' | 'production', msn: '', clientId: '', clientSecret: '', subscriptionKey: '' });
const editing = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const ok = ref<string | null>(null);

const errorText = (err: unknown, fallback: string): string => (err as { body?: { message?: string } } | null)?.body?.message ?? (err instanceof Error ? err.message : fallback);

async function refresh(): Promise<void> {
  try {
    status.value = await loadMobilepayStatus();
    editing.value = !status.value.connected;
  } catch (err) {
    error.value = errorText(err, 'Could not reach the server.');
  }
}
onMounted(refresh);

async function save(): Promise<void> {
  busy.value = true;
  error.value = ok.value = null;
  try {
    status.value = await saveMobilepayKeys({ ...form, msn: form.msn.trim(), clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim(), subscriptionKey: form.subscriptionKey.trim() });
    Object.assign(form, { msn: '', clientId: '', clientSecret: '', subscriptionKey: '' });
    editing.value = false;
    ok.value = 'MobilePay accepted the keys. Pick MobilePay above, or leave your card terminal and the till gets a MobilePay button of its own.';
    emit('changed');
  } catch (err) {
    error.value = errorText(err, 'Could not save the keys.');
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  busy.value = true;
  error.value = ok.value = null;
  try {
    status.value = await clearMobilepayKeys();
    editing.value = true;
    emit('changed');
  } catch (err) {
    error.value = errorText(err, 'Could not remove the keys.');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="mobilepay">
    <h3>MobilePay</h3>
    <p class="hint">
      Customers scan a QR code on the till (or the customer display) and pay in the MobilePay app - no terminal needed.
      Keys come from <strong>portal.vippsmobilepay.com → For developers → your sales unit → Show keys</strong>; the sales unit needs the ePayment product.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="ok" class="ok">{{ ok }}</p>

    <template v-if="status?.connected && !editing">
      <p>Connected: sales unit <strong>{{ status.msn }}</strong><span v-if="status.env === 'test'"> · <strong>test environment</strong> - no real money moves</span>.</p>
      <div v-if="status.canManage" class="row">
        <button type="button" class="quiet" :disabled="busy" @click="editing = true">Replace keys</button>
        <button type="button" class="quiet danger" :disabled="busy" @click="remove">Remove</button>
      </div>
    </template>

    <form v-else-if="status?.canManage" class="form" @submit.prevent="save">
      <label><span>Environment</span>
        <select v-model="form.env">
          <option value="production">Production - real payments</option>
          <option value="test">Test - the MT app and test users only</option>
        </select>
      </label>
      <label><span>Merchant Serial Number (MSN)</span><input v-model="form.msn" type="text" inputmode="numeric" autocomplete="off" placeholder="123456" required /></label>
      <label><span>Client ID</span><input v-model="form.clientId" type="text" autocomplete="off" spellcheck="false" required /></label>
      <label><span>Client secret</span><input v-model="form.clientSecret" type="password" autocomplete="off" required /></label>
      <label><span>Subscription key (Ocp-Apim-Subscription-Key)</span><input v-model="form.subscriptionKey" type="password" autocomplete="off" required /></label>
      <div class="row">
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Checking…' : 'Save and check' }}</button>
        <button v-if="status?.connected" type="button" class="quiet" :disabled="busy" @click="editing = false">Keep the current keys</button>
      </div>
    </form>
    <p v-else class="hint">An owner or admin enters the keys.</p>
  </div>
</template>

<style scoped>
.mobilepay { display: flex; flex-direction: column; gap: .6rem; }
h3 { margin: 1rem 0 0; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.ok { margin: 0; color: var(--zfy-accent-ink, #0e7c66); }
.form { display: flex; flex-direction: column; gap: .5rem; max-width: 28rem; }
.form label { display: flex; flex-direction: column; gap: .2rem; font-size: .875rem; }
.row { display: flex; gap: .5rem; flex-wrap: wrap; }
button.danger { border-color: var(--zfy-danger, #c6512f); color: var(--zfy-danger, #c6512f); }
</style>
