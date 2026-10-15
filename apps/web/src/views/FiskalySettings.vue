<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { authFetch } from '@zollify/platform';

/**
 * fiskaly cloud TSE for the account: the API key (kept encrypted on the
 * server, never sent back), setting up the TSE, and the steps to get there -
 * the guide people follow is on this page. See docs/fiskaly-setup.md.
 */

interface Status {
  configured: boolean;
  env?: string;
  tss?: { id: string; state: string; serial: string | null } | null;
}

const status = ref<Status | null>(null);
const apiKey = ref('');
const apiSecret = ref('');
const busy = ref<'save' | 'setup' | null>(null);
const error = ref<string | null>(null);
const ready = computed(() => status.value?.tss?.state === 'INITIALIZED');
const live = computed(() => status.value?.env === 'LIVE');

async function refresh(): Promise<void> {
  try {
    status.value = (await authFetch('/m/pos/fiskaly')) as Status;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
onMounted(refresh);

async function saveKey(): Promise<void> {
  busy.value = 'save';
  error.value = null;
  try {
    await authFetch('/m/pos/fiskaly', { method: 'PUT', body: JSON.stringify({ apiKey: apiKey.value, apiSecret: apiSecret.value }) });
    apiKey.value = '';
    apiSecret.value = '';
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = null;
  }
}

async function setUp(): Promise<void> {
  busy.value = 'setup';
  error.value = null;
  try {
    status.value = (await authFetch('/m/pos/fiskaly/setup', { method: 'POST' })) as Status;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    await refresh();
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <section class="fiskaly">
    <h2>TSE (fiskaly cloud)</h2>
    <p class="hint">
      A cloud TSE from fiskaly instead of a TSE stick in the device: every device signs through Zollify's server, so phones need
      no hardware - but every sale needs a connection. fiskaly charges per till (each device that signs counts).
    </p>

    <dl v-if="status" class="facts">
      <dt>API key</dt>
      <dd :class="status.configured ? 'ok' : 'warn'">{{ status.configured ? `Saved - ${live ? 'LIVE' : 'TEST'} environment` : 'Not set' }}</dd>
      <dt>TSE</dt>
      <dd :class="ready ? 'ok' : 'warn'">
        <template v-if="ready">Ready{{ live ? '' : ' - TEST, receipts say not certified' }}</template>
        <template v-else-if="status.tss">Setting up ({{ status.tss.state }}) - press "Set up TSE" to finish</template>
        <template v-else>Not set up</template>
      </dd>
      <template v-if="status.tss?.serial">
        <dt>TSE serial</dt>
        <dd class="mono">{{ status.tss.serial }}</dd>
      </template>
    </dl>

    <ol class="guide">
      <li>
        <strong>Create a fiskaly account</strong> at <a href="https://dashboard.fiskaly.com" target="_blank" rel="noopener">dashboard.fiskaly.com</a> and
        your organisation (company name, address, tax number). Start in the free <strong>TEST</strong> environment.
      </li>
      <li>
        <strong>Create an API key</strong> for that organisation in the dashboard (TEST environment). Copy the key and the secret - the
        secret is shown only once.
      </li>
      <li>
        <strong>Paste them below</strong> and save. Zollify checks them with fiskaly and keeps them encrypted on the server; they are never
        shown again.
        <form class="key" @submit.prevent="saveKey">
          <label><span>API key</span><input v-model="apiKey" type="text" autocomplete="off" spellcheck="false" /></label>
          <label><span>API secret</span><input v-model="apiSecret" type="password" autocomplete="off" /></label>
          <div><button type="submit" :disabled="busy !== null || !apiKey || !apiSecret">{{ busy === 'save' ? 'Checking…' : status?.configured ? 'Replace key' : 'Save key' }}</button></div>
        </form>
      </li>
      <li>
        <strong>Set up the TSE.</strong> Zollify creates your TSE at fiskaly and initialises it (its admin PUK and PIN are kept encrypted
        with the key).
        <div><button type="button" class="primary" :disabled="busy !== null || !status?.configured || ready" @click="setUp">{{ busy === 'setup' ? 'Setting up… (up to a minute)' : ready ? 'TSE ready' : 'Set up TSE' }}</button></div>
      </li>
      <li>
        <strong>On every device that sells</strong>: Settings → This device → TSE → <em>fiskaly cloud TSE</em>. Each device registers with the
        TSE under its till serial number the first time it signs.
      </li>
      <li><strong>Try it</strong>: a sale at an event in Germany prints a TSE block on the receipt. In TEST it says "TEST-TSE - NICHT ZERTIFIZIERT".</li>
      <li>
        <strong>Go live</strong>: once your fiskaly contract is active, create a LIVE API key and paste it here, then set up the TSE again - a LIVE
        key gets a TSE of its own. From then on receipts carry certified signatures.
      </li>
      <li>
        <strong>Tell the tax office</strong> within a month (ELSTER, "Mitteilung über elektronische Aufzeichnungssysteme"): each device's till
        serial number, the TSE serial above, and "Cloud-TSE (fiskaly)".
      </li>
    </ol>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.fiskaly { display: flex; flex-direction: column; gap: .75rem; max-width: 44rem; }
h2 { margin: 0; font-size: 1.1rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .875rem; }
.facts { display: grid; grid-template-columns: 8rem 1fr; gap: .3rem 1rem; margin: 0; font-size: .875rem; }
.facts dt { color: var(--zfy-muted, #5a6472); }
.facts dd { margin: 0; }
.mono { font-family: ui-monospace, monospace; word-break: break-all; font-size: .8rem; }
.ok { color: var(--zfy-accent-ink, #0a5a4a); }
.warn { color: var(--zfy-warning-ink, #8a5a1e); }
.guide { margin: 0; padding-left: 1.3rem; display: flex; flex-direction: column; gap: .7rem; font-size: .9rem; }
.guide li > div, .key { margin-top: .4rem; }
.key { display: flex; flex-direction: column; gap: .4rem; }
.key label { display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); font-size: .875rem; }
</style>
