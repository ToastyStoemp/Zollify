<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { DeviceSummary } from '@zollify/shared';
import { allProviders, onActiveProviderChanged } from '../payments/registry';
import type { PaymentProvider, PaymentProviderId } from '../payments/provider';
import { SUMUP_KEY_SETTING } from '../payments/sumup';
import { REMOTE_CARBON_DEVICE_KEY } from '../payments/mypos-carbon-remote';
import { SMARTPOS_TERMINAL_SETTING, loadSmartposStatus, loadSmartposTerminals, removeSmartposApp, saveSmartposApp, type SmartposOtherDevice, type SmartposStatus, type SmartposTerminal } from '../payments/nexi-smartpos';
import { getSetting, setSetting } from '../lib/settings';
import { CARD_IN_BASE_KEY, loadCardFx } from '../cart';
import { sdk } from '../runtime';

/**
 * Payments - ZollTool's settings: every terminal with its live status,
 * Connect / Pair reader / Log out where the provider supports it, the SumUp
 * affiliate key, the satellite Carbon to hand card payments to, whether cards
 * are charged in the base currency at a converted event, and the extra
 * payment methods shown as buttons on the till.
 */
interface Status {
  available: boolean;
  connected: boolean;
  detail?: string;
}
const statuses = ref<Record<string, Status>>({});
const active = ref<string>('manual');
const providers = allProviders();
let pollTimer: ReturnType<typeof setInterval> | undefined;

async function refreshStatuses(): Promise<void> {
  for (const p of providers) {
    const available = await p.isAvailable();
    const status = available ? await p.getStatus().catch((e) => ({ connected: false, detail: String(e) })) : { connected: false, detail: 'Not available on this device' };
    statuses.value[p.id] = { ...status, available };
  }
}

const sumupKey = ref('');
const editingKey = ref(false);
const hasKey = computed(() => !!sumupKey.value.trim());
const maskedKey = computed(() => (hasKey.value ? `${'•'.repeat(8)} ${sumupKey.value.trim().slice(-4)}` : ''));
const remoteCarbonId = ref('');
const carbons = ref<DeviceSummary[]>([]);
const carbonsError = ref('');
const customMethods = ref<string[]>([]);
const cardInBase = ref(false);
const baseCurrency = computed(() => sdk().data.events.active()?.currency ?? sdk().account()?.profile.defaultCurrency ?? 'EUR');
const newMethod = ref('');

onMounted(async () => {
  void refreshStatuses();
  pollTimer = setInterval(() => void refreshStatuses(), 5000);
  active.value = (await sdk().config.get<string>('activeProvider')) ?? 'manual';
  customMethods.value = (await sdk().config.get<string[]>('customMethods')) ?? [];
  cardInBase.value = (await getSetting<boolean>(CARD_IN_BASE_KEY)) ?? false;
  sumupKey.value = (await getSetting<string>(SUMUP_KEY_SETTING)) ?? '';
  remoteCarbonId.value = (await getSetting<string>(REMOTE_CARBON_DEVICE_KEY)) ?? '';
  void refreshCarbons();
  smartposTerminal.value = (await getSetting<SmartposTerminal>(SMARTPOS_TERMINAL_SETTING))?.deviceId ?? '';
  if (active.value === 'nexi-smartpos') void refreshSmartpos();
  // Back from Nexi/Poynt after connecting (or not).
  const outcome = new URLSearchParams(location.hash.split('?')[1] ?? '').get('smartpos');
  if (outcome) {
    const text: Record<string, string> = {
      connected: 'Nexi account connected - now pick this till’s terminal.',
      declined: 'Connecting was cancelled on the Nexi page.',
      expired: 'That link had expired - try Connect again.',
      in_use: 'That Nexi account is already connected to another Zollify account.',
      not_configured: 'Add your Poynt app under Nexi SmartPOS first.',
      failed: 'Nexi did not confirm the connection - try again.',
    };
    sdk().ui.toast(text[outcome] ?? 'Back from Nexi.', { kind: outcome === 'connected' ? 'success' : 'warning', timeoutMs: 7000 });
    if (outcome === 'connected') {
      await select('nexi-smartpos');
      void refreshSmartpos();
    }
  }
});

// ── Nexi SmartPOS: which terminal this till sends payments to ───────────────
const smartposTerminals = ref<SmartposTerminal[]>([]);
const smartposOthers = ref<SmartposOtherDevice[]>([]);
/** Whether the list has come back at least once, so "none" means none. */
const smartposLoaded = ref(false);
const smartposTerminal = ref('');
const smartposError = ref('');
const smartpos = ref<SmartposStatus | null>(null);
const appForm = ref({ open: false, applicationId: '', region: 'eu' as 'eu' | 'us', privateKey: '', authPublicKey: '', saving: false });
async function refreshSmartpos(fresh = false): Promise<void> {
  smartposError.value = '';
  smartposLoaded.value = false;
  smartpos.value = await loadSmartposStatus().catch(() => null);
  if (!smartpos.value?.connected) {
    smartposTerminals.value = [];
    smartposOthers.value = [];
    return;
  }
  try {
    const list = await loadSmartposTerminals(fresh);
    smartposTerminals.value = list.terminals;
    smartposOthers.value = list.others;
    smartposLoaded.value = true;
  } catch (err) {
    const body = (err as { body?: { error?: string; message?: string } } | null)?.body;
    smartposTerminals.value = [];
    smartposOthers.value = [];
    // No app or not connected yet is what the hints already say.
    smartposError.value = body?.error === 'not_connected' || body?.error === 'not_configured' ? '' : (body?.message ?? 'Could not load your terminals.');
  }
}
async function saveSmartposTerminal(): Promise<void> {
  const t = smartposTerminals.value.find((x) => x.deviceId === smartposTerminal.value) ?? null;
  await setSetting(SMARTPOS_TERMINAL_SETTING, t);
  sdk().ui.toast(t ? `Card payments go to ${t.name}.` : 'Terminal cleared.', { kind: 'success' });
  void refreshStatuses();
}
/** The account's own Poynt app: id and region shown, the key only ever sent. */
function editApp(): void {
  const a = smartpos.value?.app;
  appForm.value = { open: true, applicationId: a?.applicationId ?? '', region: a?.region ?? 'eu', privateKey: '', authPublicKey: '', saving: false };
}
async function readKeyFile(e: Event, field: 'privateKey' | 'authPublicKey'): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) appForm.value[field] = (await file.text()).trim();
}
async function saveApp(): Promise<void> {
  const f = appForm.value;
  f.saving = true;
  try {
    await saveSmartposApp({ applicationId: f.applicationId.trim(), privateKey: f.privateKey, region: f.region, authPublicKey: f.authPublicKey.trim() || null });
    appForm.value = { ...f, open: false, privateKey: '', authPublicKey: '', saving: false };
    sdk().ui.toast('Poynt app saved - now tap Connect to allow it on your Nexi account.', { kind: 'success', timeoutMs: 6000 });
  } catch (err) {
    f.saving = false;
    sdk().ui.toast((err as { body?: { message?: string } } | null)?.body?.message ?? 'Could not save the app.', { kind: 'error' });
  }
  void refreshSmartpos();
  void refreshStatuses();
}
async function removeApp(): Promise<void> {
  if (!(await sdk().ui.confirm('This account stops using its own Poynt app and its Nexi connection is removed.', 'Remove the Poynt app?', { confirm: 'Remove' }))) return;
  await removeSmartposApp();
  await setSetting(SMARTPOS_TERMINAL_SETTING, null);
  smartposTerminal.value = '';
  void refreshSmartpos();
  void refreshStatuses();
}
async function copyRedirect(): Promise<void> {
  await navigator.clipboard.writeText(smartpos.value?.redirectUrl ?? '').catch(() => undefined);
  sdk().ui.toast('Copied.', { kind: 'info' });
}
onUnmounted(() => clearInterval(pollTimer));

async function select(id: PaymentProviderId): Promise<void> {
  active.value = id;
  await sdk().config.set('activeProvider', id);
  onActiveProviderChanged(id);
  if (id === 'nexi-smartpos') void refreshSmartpos();
  sdk().ui.toast('Payment provider updated.', { kind: 'success' });
  void refreshStatuses();
}
async function run(p: PaymentProvider, action: 'configure' | 'pairReader' | 'disconnect', done: string): Promise<void> {
  const fn = p[action];
  if (!fn) return;
  try {
    await fn.call(p);
    sdk().ui.toast(done, { kind: 'info' });
  } catch (err) {
    sdk().ui.toast(err instanceof Error ? err.message : String(err), { kind: 'error' });
  }
  setTimeout(() => {
    void refreshStatuses();
    if (p.id === 'nexi-smartpos') void refreshSmartpos();
  }, 1200);
}
async function saveKey(): Promise<void> {
  await setSetting(SUMUP_KEY_SETTING, sumupKey.value.trim());
  editingKey.value = false;
  sdk().ui.toast('SumUp affiliate key saved.', { kind: 'success' });
}

/** Devices seen as a Carbon on this account, newest first. */
async function refreshCarbons(): Promise<void> {
  carbonsError.value = '';
  try {
    carbons.value = (await sdk().realtime.devices()).filter((d) => d.flavor === 'carbon');
  } catch (err) {
    carbonsError.value = err instanceof Error ? err.message : String(err);
  }
}
async function saveRemoteCarbon(): Promise<void> {
  await setSetting(REMOTE_CARBON_DEVICE_KEY, remoteCarbonId.value.trim());
  sdk().ui.toast('Remote Carbon saved.', { kind: 'success' });
  void refreshStatuses();
}
const when = (ts: number): string => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const ago = (ts: number): string => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

async function saveCardInBase(): Promise<void> {
  await setSetting(CARD_IN_BASE_KEY, cardInBase.value);
  // The till may already be open: pick up the setting (and a rate) now.
  void loadCardFx();
}

async function addMethod(): Promise<void> {
  const name = newMethod.value.trim();
  if (!name || customMethods.value.some((m) => m.toLowerCase() === name.toLowerCase())) return;
  customMethods.value = [...customMethods.value, name];
  newMethod.value = '';
  await sdk().config.set('customMethods', customMethods.value);
}
async function removeMethod(name: string): Promise<void> {
  customMethods.value = customMethods.value.filter((m) => m !== name);
  await sdk().config.set('customMethods', customMethods.value);
}
</script>

<template>
  <section class="payments">
    <h2>Payments</h2>
    <p class="hint">Zollify never holds the money - the terminal settles straight to your bank.</p>

    <h3>Card payment terminal</h3>
    <ul class="providers">
      <li v-for="p in providers" :key="p.id" :class="{ off: !statuses[p.id]?.available }">
        <input type="radio" name="provider" :value="p.id" :checked="active === p.id" :disabled="!statuses[p.id]?.available" :aria-label="p.label" @change="select(p.id)" />
        <span class="main"><span>{{ p.label }}</span><small>{{ statuses[p.id]?.detail || '…' }}</small></span>
        <span :class="['dot', statuses[p.id]?.connected ? 'on' : statuses[p.id]?.available ? 'idle' : 'off']"></span>
        <button v-if="p.configure && statuses[p.id]?.available" type="button" class="quiet" @click="run(p, 'configure', 'Connecting…')">Connect</button>
        <button v-if="p.pairReader && statuses[p.id]?.connected" type="button" class="quiet" @click="run(p, 'pairReader', 'Reader settings closed')">Pair reader</button>
        <button v-if="p.disconnect && statuses[p.id]?.connected" type="button" class="quiet danger" @click="run(p, 'disconnect', 'Disconnected')">Log out</button>
      </li>
    </ul>

    <template v-if="statuses['sumup']?.available">
      <label class="field">
        <span>SumUp affiliate key</span>
        <div v-if="hasKey && !editingKey" class="row"><code>{{ maskedKey }}</code><button type="button" class="quiet" @click="editingKey = true">Change</button></div>
        <input v-else v-model="sumupKey" type="password" autocomplete="off" placeholder="From the SumUp developer dashboard" @change="saveKey" />
      </label>
      <p class="hint">Save the key and tap <strong>Connect</strong> to log in once. <strong>Pair reader</strong> connects your Solo or Air over Bluetooth; <strong>Log out</strong> disconnects this device from your SumUp account.</p>
    </template>

    <template v-if="active === 'nexi-smartpos' && statuses['nexi-smartpos']?.available">
      <div v-if="smartpos?.canManage" class="carbon">
        <div class="row"><span class="label">Poynt app</span>
          <template v-if="!appForm.open">
            <button type="button" class="quiet" @click="editApp">{{ smartpos.app ? 'Change' : 'Add your app' }}</button>
            <button v-if="smartpos.app" type="button" class="quiet danger" @click="removeApp">Remove</button>
          </template>
        </div>
        <p v-if="smartpos.app && !appForm.open" class="hint"><code>{{ smartpos.app.applicationId }}</code> ({{ smartpos.app.region.toUpperCase() }}){{ smartpos.app.hasAuthKey ? ' - code signatures checked' : '' }}</p>
        <p v-else-if="!appForm.open" class="hint">{{ smartpos.serverApp ? 'Using the app this server provides. Add your own to use your own Poynt developer account.' : 'Create a cloud app in the Poynt developer portal (EU: poynt-eu.godaddy.com) and add its application id and private key here. Only this account uses it.' }}</p>
        <form v-if="appForm.open" class="appform" @submit.prevent="saveApp">
          <label class="field"><span>Application id</span><input v-model="appForm.applicationId" type="text" autocomplete="off" placeholder="urn:aid:…" required /></label>
          <label class="field"><span>Region</span>
            <select v-model="appForm.region"><option value="eu">Europe (Nexi, Nets)</option><option value="us">United States</option></select>
          </label>
          <label class="field"><span>Private key (.pem){{ smartpos.app ? ' - leave empty to keep the saved one' : '' }}</span>
            <input type="file" accept=".pem,.key,.txt" @change="readKeyFile($event, 'privateKey')" />
            <textarea v-model="appForm.privateKey" rows="3" autocomplete="off" spellcheck="false" placeholder="-----BEGIN PRIVATE KEY-----"></textarea>
          </label>
          <details>
            <summary>Poynt’s public key (optional)</summary>
            <p class="hint">If Nexi or Poynt gives you the key they sign authorisation codes with, add it and Zollify checks every code against it.</p>
            <textarea v-model="appForm.authPublicKey" rows="3" spellcheck="false" placeholder="-----BEGIN PUBLIC KEY-----"></textarea>
          </details>
          <div class="field"><span>OAuth callback URL - set this in the app’s OAuth settings</span>
            <div class="row"><code class="grow">{{ smartpos.redirectUrl }}</code><button type="button" class="quiet" @click="copyRedirect">Copy</button></div>
          </div>
          <p v-if="!smartpos.https" class="error">Nexi can only reach this server over a public https address - open Zollify through it, or set PUBLIC_ORIGIN.</p>
          <div class="row"><button type="submit" :disabled="appForm.saving || !appForm.applicationId.trim()">{{ appForm.saving ? 'Checking…' : 'Save' }}</button><button type="button" class="quiet" @click="appForm.open = false">Cancel</button></div>
        </form>
        <p class="hint">The key stays on the server, encrypted. Each account on this server has its own app, Nexi account and terminals.</p>
      </div>
      <div class="carbon">
        <div class="row"><span class="label">Nexi connection</span></div>
        <p v-if="smartpos?.connection" class="ok">Connected to {{ smartpos.connection.businessName || 'your Nexi business' }} since {{ when(smartpos.connection.linkedAt) }}.</p>
        <p v-else class="hint">Not connected yet. {{ smartpos && !smartpos.configured ? 'Add a Poynt app first, then tap' : 'Tap' }} <strong>Connect</strong> above and allow the app on your Nexi account.</p>
        <p v-if="smartpos?.lastAttempt && smartpos.lastAttempt.outcome !== 'connected'" class="error">
          Last attempt ({{ when(smartpos.lastAttempt.at) }}) {{ smartpos.lastAttempt.outcome === 'declined' ? 'was cancelled on the Nexi page.' : 'did not connect' }}{{ smartpos.lastAttempt.outcome === 'declined' ? '' : smartpos.lastAttempt.detail ? `: ${smartpos.lastAttempt.detail}` : '.' }}
        </p>
      </div>
      <div v-if="smartpos?.connected" class="carbon">
        <div class="row"><span class="label">This till’s Nexi terminal</span><button type="button" class="quiet" @click="refreshSmartpos(true)">Refresh</button></div>
        <select v-if="smartposTerminals.length" v-model="smartposTerminal" @change="saveSmartposTerminal">
          <option value="" disabled>Choose a terminal…</option>
          <option v-for="t in smartposTerminals" :key="t.deviceId" :value="t.deviceId">{{ t.name }}{{ t.storeName ? ` - ${t.storeName}` : '' }}{{ t.serial ? ` (${t.serial})` : '' }}</option>
        </select>
        <p v-else-if="smartposError" class="error">{{ smartposError }}</p>
        <p v-else-if="smartposLoaded" class="hint">Poynt lists no active terminals on this business yet. A test merchant has none until a device is activated on it - Nexi registers developer terminals, or use Poynt’s emulator. Tap <strong>Refresh</strong> once one is set up.</p>
        <p v-else class="hint">Loading terminals…</p>
        <p v-if="smartposOthers.length" class="hint">Also on this business, but not usable: {{ smartposOthers.map((d) => `${d.name} (${d.why})`).join(', ') }}.</p>
        <p class="hint">The amount appears on the terminal when you charge a card; the customer pays there and the till hears back by itself. Each till can use its own terminal.</p>
      </div>
    </template>

    <template v-if="active === 'mypos-carbon-remote'">
      <div class="carbon">
        <div class="row"><span class="label">Remote Carbon terminal</span><button type="button" class="quiet" @click="refreshCarbons">Refresh</button></div>
        <select v-if="carbons.length" v-model="remoteCarbonId" @change="saveRemoteCarbon">
          <option value="" disabled>Choose a Carbon…</option>
          <option v-for="d in carbons" :key="d.id" :value="d.id">{{ d.name || d.id }} - seen {{ ago(d.lastSeenAt) }}</option>
        </select>
        <p v-else-if="carbonsError" class="error">{{ carbonsError }}</p>
        <p v-else class="hint">No Carbon seen on this account yet - open Zollify on it once, or paste its device id below.</p>
        <label class="field"><span>{{ carbons.length ? 'Or paste a device id' : 'Device id' }}</span><input v-model="remoteCarbonId" type="text" placeholder="Under This device on the Carbon" @change="saveRemoteCarbon" /></label>
      </div>
    </template>

    <h3>Currency</h3>
    <label class="toggle">
      <input v-model="cardInBase" type="checkbox" @change="saveCardInBase" />
      <span class="main">
        <span>Charge cards in the base currency ({{ baseCurrency }})</span>
        <small>At an event priced in a local currency, the card terminal is charged in {{ baseCurrency }} at today's market rate - a painting sold for 30 CHF is charged as about 32 EUR on the card. Cash is still taken in the local currency. Set your terminal to {{ baseCurrency }}.</small>
      </span>
    </label>

    <h3>Extra payment methods</h3>
    <p class="hint">Extra buttons on the till for payments taken outside the app - TWINT, a PayPal QR code. Sales made with them count as non-cash.</p>
    <ul v-if="customMethods.length" class="methods">
      <li v-for="m in customMethods" :key="m"><span>{{ m }}</span><button type="button" class="quiet danger" @click="removeMethod(m)">Remove</button></li>
    </ul>
    <form class="add" @submit.prevent="addMethod">
      <input v-model="newMethod" type="text" placeholder="TWINT" aria-label="Method name" />
      <button type="submit" :disabled="!newMethod.trim()">Add</button>
    </form>
  </section>
</template>

<style scoped>
.payments { display: flex; flex-direction: column; gap: .75rem; max-width: 40rem; }
h2 { font-size: 1.05rem; margin: 0; }
h3 { font-size: .95rem; margin: .5rem 0 0; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .85rem; }
.ok { color: var(--zfy-accent, #0e7c66); margin: 0; font-size: .85rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; font-size: .85rem; }
.providers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
.providers li { display: flex; align-items: center; gap: .6rem; padding: .5rem .7rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; background: var(--zfy-surface, #fff); }
.providers li.off { opacity: .55; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: .875rem; }
.main small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
.dot { width: .55rem; height: .55rem; border-radius: 50%; background: var(--zfy-line, #d6dde4); flex-shrink: 0; }
.dot.on { background: var(--zfy-accent, #0e7c66); }
.dot.idle { background: var(--zfy-warning, #c08a2e); }
.providers .quiet { min-height: 1.8rem; font-size: .78rem; padding: .1rem .5rem; }
.field { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.row { display: flex; align-items: center; gap: .5rem; }
.label { flex: 1; font-size: .875rem; font-weight: 600; }
code { font-family: ui-monospace, monospace; padding: .3rem .5rem; border-radius: 6px; background: var(--zfy-bg, #f1f4f6); }
.carbon { display: flex; flex-direction: column; gap: .5rem; padding: .7rem .8rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; }
.appform { display: flex; flex-direction: column; gap: .5rem; }
.appform textarea { font-family: ui-monospace, monospace; font-size: .75rem; }
.grow { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: .78rem; }
.methods { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.methods li { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .35rem .6rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; font-size: .875rem; }
.methods .quiet { min-height: 1.7rem; font-size: .78rem; }
.toggle { display: flex; align-items: flex-start; gap: .6rem; padding: .5rem .7rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; background: var(--zfy-surface, #fff); }
.toggle input { margin-top: .2rem; }
.add { display: flex; gap: .4rem; }
.add input { flex: 1; min-width: 0; }
</style>
