<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { DeviceSummary } from '@zollify/shared';
import { allProviders, onActiveProviderChanged } from '../payments/registry';
import type { PaymentProvider, PaymentProviderId } from '../payments/provider';
import { SUMUP_KEY_SETTING } from '../payments/sumup';
import { REMOTE_CARBON_DEVICE_KEY } from '../payments/mypos-carbon-remote';
import { getSetting, setSetting } from '../lib/settings';
import { sdk } from '../runtime';

/**
 * Payments - ZollTool's settings: every terminal with its live status,
 * Connect / Pair reader / Log out where the provider supports it, the SumUp
 * affiliate key, the satellite Carbon to hand card payments to, and the
 * extra payment methods shown as buttons on the till.
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
const newMethod = ref('');

onMounted(async () => {
  void refreshStatuses();
  pollTimer = setInterval(() => void refreshStatuses(), 5000);
  active.value = (await sdk().config.get<string>('activeProvider')) ?? 'manual';
  customMethods.value = (await sdk().config.get<string[]>('customMethods')) ?? [];
  sumupKey.value = (await getSetting<string>(SUMUP_KEY_SETTING)) ?? '';
  remoteCarbonId.value = (await getSetting<string>(REMOTE_CARBON_DEVICE_KEY)) ?? '';
  void refreshCarbons();
});
onUnmounted(() => clearInterval(pollTimer));

async function select(id: PaymentProviderId): Promise<void> {
  active.value = id;
  await sdk().config.set('activeProvider', id);
  onActiveProviderChanged(id);
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
  setTimeout(() => void refreshStatuses(), 1200);
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
const ago = (ts: number): string => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

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
.methods { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.methods li { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .35rem .6rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; font-size: .875rem; }
.methods .quiet { min-height: 1.7rem; font-size: .78rem; }
.add { display: flex; gap: .4rem; }
.add input { flex: 1; min-width: 0; }
</style>
