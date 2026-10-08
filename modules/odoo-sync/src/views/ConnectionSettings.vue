<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { sdk } from '../runtime';

interface Connection {
  connected: boolean;
  url?: string;
  db?: string;
  login?: string;
  locationId?: number | null;
  syncStock?: boolean;
  invoiceSales?: boolean;
  journalId?: number | null;
  partnerId?: number | null;
}
interface Choices {
  version: string | null;
  locations: { id: number; name: string; warehouse: string }[];
  journals: { id: number; name: string }[];
}

const state = ref<Connection>({ connected: false });
const form = reactive({ url: '', db: '', login: '', apiKey: '', locationId: null as number | null, syncStock: true, invoiceSales: false, journalId: null as number | null });
const choices = ref<Choices | null>(null);
const busy = ref(false);
const disconnecting = ref(false);
const error = ref<string | null>(null);

async function refresh(): Promise<void> {
  try {
    state.value = await sdk().http.get<Connection>('connection');
    if (state.value.connected) {
      Object.assign(form, { url: state.value.url ?? '', db: state.value.db ?? '', login: state.value.login ?? '', locationId: state.value.locationId ?? null, syncStock: state.value.syncStock ?? true, invoiceSales: state.value.invoiceSales ?? false, journalId: state.value.journalId ?? null });
      choices.value = await sdk().http.get<Choices>('choices').catch(() => null);
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not read the connection.';
  }
}
onMounted(refresh);

async function connect(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await sdk().http.post('connection', { url: form.url.trim(), db: form.db.trim(), login: form.login.trim(), apiKey: form.apiKey.trim() || undefined, locationId: form.locationId, syncStock: form.syncStock, invoiceSales: form.invoiceSales, journalId: form.journalId, partnerId: state.value.partnerId ?? null });
    // The key is stored server-side; no reason for it to sit in this page afterwards.
    form.apiKey = '';
    await refresh();
    sdk().ui.toast('Odoo connected.', { kind: 'success' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not connect to Odoo.';
  } finally {
    busy.value = false;
  }
}

async function disconnect(): Promise<void> {
  if (!(await sdk().ui.confirm('Disconnect Odoo? The stored API key, the matches and the sync record are deleted. Nothing in Odoo is touched.', 'Disconnect Odoo'))) return;
  disconnecting.value = true;
  error.value = null;
  try {
    await sdk().http.del('connection');
    choices.value = null;
    await refresh();
    sdk().ui.toast('Odoo disconnected.', { kind: 'success' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not disconnect.';
  } finally {
    disconnecting.value = false;
  }
}
</script>

<template>
  <section class="connection">
    <h2>Odoo connection</h2>
    <p class="hint">
      In Odoo, open your preferences → Account security → API keys and make one for Zollify. It is stored encrypted on the server and never sent back to this page.
      Connect first; the location and journal pickers fill in from Odoo once the key works.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="state.connected" class="status">Connected to <strong>{{ state.url }}</strong> · database {{ state.db }}<span v-if="choices?.version"> · Odoo {{ choices.version }}</span></p>

    <form class="form" @submit.prevent="connect">
      <label><span>Odoo address</span><input v-model="form.url" type="url" placeholder="https://mycompany.odoo.com" required /></label>
      <div class="two">
        <label><span>Database</span><input v-model="form.db" type="text" placeholder="mycompany" required /></label>
        <label><span>Login (email)</span><input v-model="form.login" type="text" autocomplete="off" required /></label>
      </div>
      <label><span>API key</span><input v-model="form.apiKey" type="password" autocomplete="off" :placeholder="state.connected ? 'Leave blank to keep the current key' : ''" :required="!state.connected" /></label>

      <template v-if="state.connected">
        <fieldset>
          <legend>Stock</legend>
          <label class="check"><input v-model="form.syncStock" type="checkbox" /> Keep stock level with Odoo</label>
          <label>
            <span>The location your shelf is</span>
            <select v-model="form.locationId" :disabled="!choices">
              <option :value="null">{{ choices ? 'Pick a location' : 'Loading from Odoo…' }}</option>
              <option v-for="l in choices?.locations ?? []" :key="l.id" :value="l.id">{{ l.name }}<template v-if="l.warehouse"> ({{ l.warehouse }})</template></option>
            </select>
          </label>
          <small class="hint">A sale here lowers Odoo's quantity on hand there within seconds; a web order there lowers the count here on the hourly pull, or on Sync now. Only items matched under Odoo, and counted here, go across.</small>
        </fieldset>
        <fieldset>
          <legend>Invoices</legend>
          <label class="check"><input v-model="form.invoiceSales" type="checkbox" /> Post every till sale as a customer invoice in Odoo</label>
          <label v-if="form.invoiceSales">
            <span>Sales journal</span>
            <select v-model="form.journalId" :disabled="!choices">
              <option :value="null">Odoo's default</option>
              <option v-for="j in choices?.journals ?? []" :key="j.id" :value="j.id">{{ j.name }}</option>
            </select>
          </label>
          <small class="hint">One posted invoice per sale, to a "Zollify till sales" customer, with the price as charged. Set your Odoo sales taxes as "included in price", or Odoo adds VAT on top. A reverted sale gets a credit note. Payments are not recorded in Odoo.</small>
        </fieldset>
      </template>

      <div class="actions">
        <button v-if="state.connected" type="button" :disabled="disconnecting || busy" @click="disconnect">{{ disconnecting ? 'Disconnecting…' : 'Disconnect' }}</button>
        <button type="submit" class="primary" :disabled="busy || disconnecting">{{ busy ? 'Checking…' : state.connected ? 'Save' : 'Connect' }}</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.connection { display: flex; flex-direction: column; gap: .75rem; max-width: 34rem; }
h2 { margin: 0; font-size: 1.05rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .875rem; }
small.hint { font-size: .78rem; }
.status { margin: 0; font-size: .9rem; color: var(--zfy-accent-ink, #0a5a4a); }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.form { display: flex; flex-direction: column; gap: .6rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label.check { flex-direction: row; align-items: center; gap: .4rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
fieldset { display: flex; flex-direction: column; gap: .5rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; padding: .6rem .8rem; }
legend { font-size: .8rem; color: var(--zfy-muted, #5a6472); padding: 0 .3rem; }
.actions { display: flex; gap: .5rem; justify-content: flex-end; }
</style>
