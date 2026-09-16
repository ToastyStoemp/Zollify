<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { DeviceSummary } from '@zollify/shared';
import {
  authFetch,
  getApiBase,
  isNative,
  checkForUpdate,
  downloadUpdate,
  installDownloadedUpdate,
  selfUpdates,
  updateDownload,
  type UpdateCheck,
  currentAccount,
  deviceFlavor,
  deviceId,
  deviceName,
  lastSyncAt,
  lastSyncError,
  pendingCount,
  sendDiagnosticLog,
  setDeviceName,
  setTheme,
  syncNow,
  syncState,
  theme,
  type Theme,
} from '@zollify/platform';

const account = currentAccount;
const name = ref('');

const THEMES: { value: Theme; label: string; hint: string }[] = [
  { value: 'system', label: 'Match device', hint: 'Follows the OS setting' },
  { value: 'light', label: 'Light', hint: 'For a bright hall' },
  { value: 'dark', label: 'Dark', hint: 'For a dim one, or the evening' },
];
const id = ref('');
const saved = ref(false);
const error = ref<string | null>(null);
const devices = ref<DeviceSummary[]>([]);
const build = typeof __ZOLLIFY_VERSION__ === 'string' ? __ZOLLIFY_VERSION__ : 'dev';

onMounted(async () => {
  try {
    id.value = await deviceId();
    name.value = (await deviceName()) ?? '';
    devices.value = (await authFetch('/devices')) as DeviceSummary[];
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not read this device.';
  }
});

// ── Diagnostics: send this device's log to the server for support ──────────
const sending = ref(false);
const sent = ref(false);
// ── App updates (Android, not Carbon) ───────────────────────────────────────
const canSelfUpdate = ref(false);
const update = ref<UpdateCheck | null>(null);
const checking = ref(false);
const updateError = ref<string | null>(null);
onMounted(async () => {
  canSelfUpdate.value = await selfUpdates().catch(() => false);
});
async function checkUpdate(): Promise<void> {
  checking.value = true;
  updateError.value = null;
  try {
    update.value = await checkForUpdate();
    if (update.value?.available) await downloadUpdate(update.value);
  } catch (err) {
    updateError.value = err instanceof Error ? err.message : 'Could not check for updates.';
  } finally {
    checking.value = false;
  }
}
const progressPct = (): number => (updateDownload.totalBytes > 0 ? Math.round((updateDownload.bytesWritten / updateDownload.totalBytes) * 100) : 0);

async function sendLog(): Promise<void> {
  sending.value = true;
  error.value = null;
  try {
    await sendDiagnosticLog('manual');
    sent.value = true;
    setTimeout(() => (sent.value = false), 4000);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not send the log.';
  } finally {
    sending.value = false;
  }
}

async function save(): Promise<void> {
  error.value = null;
  try {
    await setDeviceName(name.value);
    saved.value = true;
    setTimeout(() => (saved.value = false), 2500);
    // Pushed straight away so the name reaches other devices, which use it to
    // pick a register to target for a remote payment.
    void syncNow();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save that name.';
  }
}

function when(ts: number): string {
  return ts ? new Date(ts).toLocaleString() : 'never';
}
</script>

<template>
  <section class="device">
    <h2>This device</h2>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <form class="form" @submit.prevent="save">
      <label>
        <span>Device name</span>
        <input v-model="name" type="text" placeholder="Front counter iPad" />
      </label>
      <p class="hint">
        Shown on your other devices - it's how you pick which register to send a remote payment to.
      </p>
      <button type="submit">Save</button>
      <p v-if="saved" class="ok" role="status">Saved.</p>
    </form>

    <h3>Customer display</h3>
    <p class="hint">Turn this device into a second screen that mirrors another register's cart live - a tablet facing the customer. Sales still happen on the register.</p>
    <router-link :to="{ name: 'display' }" class="btn">Open customer display</router-link>

    <h3>Appearance</h3>
    <div class="themes" role="radiogroup" aria-label="Theme">
      <label v-for="opt in THEMES" :key="opt.value" :class="{ active: theme === opt.value }">
        <input type="radio" name="theme" :value="opt.value" :checked="theme === opt.value" @change="setTheme(opt.value)" />
        <span class="body">
          <span class="label">{{ opt.label }}</span>
          <span class="sub">{{ opt.hint }}</span>
        </span>
      </label>
    </div>

    <h3>Sync</h3>
    <dl class="facts">
      <dt>Status</dt>
      <dd>{{ syncState }}</dd>

      <dt>Last sync</dt>
      <dd>{{ when(lastSyncAt) }}</dd>

      <dt>Queued changes</dt>
      <!-- Non-zero here is normal offline; it only matters if it never drains. -->
      <dd>{{ pendingCount }}</dd>

      <dt v-if="lastSyncError">Last error</dt>
      <dd v-if="lastSyncError" class="error">{{ lastSyncError }}</dd>
    </dl>

    <button type="button" :disabled="syncState === 'syncing'" @click="syncNow()">
      {{ syncState === 'syncing' ? 'Syncing…' : 'Sync now' }}
    </button>

    <h3>Identity</h3>
    <dl class="facts">
      <dt>Account</dt>
      <dd>{{ account?.accountName }}</dd>

      <dt>Signed in as</dt>
      <dd>{{ account?.email }} · {{ account?.role }}</dd>

      <dt>Platform</dt>
      <dd>{{ deviceFlavor() }}</dd>

      <dt>Device id</dt>
      <dd class="mono">{{ id }}</dd>

      <dt>Build</dt>
      <dd class="mono">{{ build }}</dd>
    </dl>

    <h3>Devices on this account</h3>
    <p class="hint">Every register and display that has signed in. Names are set on each device.</p>
    <ul class="devices">
      <li v-for="d in devices" :key="d.id" :class="{ me: d.id === id }">
        <span class="main"><span>{{ d.name || 'Unnamed device' }}<em v-if="d.id === id">this device</em></span><small>{{ d.flavor || 'web' }} · seen {{ when(d.lastSeenAt) }}</small></span>
      </li>
    </ul>

    <template v-if="!canSelfUpdate && !isNative()">
      <h3>Android app</h3>
      <p class="hint">Install once from here; the app then updates itself from this server. Carbon terminals get their build through myPOS instead.</p>
      <div class="row">
        <a class="btn" :href="`${getApiBase()}/updates/download/full`" download>Full (phones, tablets)</a>
        <a class="btn" :href="`${getApiBase()}/updates/download/compat`" download>Compat (Android 7)</a>
      </div>
    </template>

    <template v-if="canSelfUpdate">
      <h3>App updates</h3>
      <p class="hint">
        Build {{ build }}. The app checks the server on every start and downloads a newer build in the background; installing is always your tap.
      </p>
      <p v-if="updateError" class="error" role="alert">{{ updateError }}</p>
      <p v-else-if="update && !update.available" class="ok" role="status">Up to date ({{ update.currentVersionName }}).</p>
      <p v-else-if="update?.available && updateDownload.active" class="hint">Downloading {{ update.versionName }}… {{ progressPct() }}%</p>
      <p v-else-if="update?.available && updateDownload.error" class="error" role="alert">Download failed: {{ updateDownload.error }}</p>
      <div class="row">
        <button type="button" :disabled="checking || updateDownload.active" @click="checkUpdate">{{ checking ? 'Checking…' : 'Check for updates' }}</button>
        <button v-if="updateDownload.ready" type="button" class="primary" @click="installDownloadedUpdate">Install {{ updateDownload.versionName }}</button>
      </div>
    </template>

    <h3>Diagnostics</h3>
    <p class="hint">Sends this device's recent warnings, errors and payment breadcrumbs to the server so support can look at them. No sale amounts or card data are included.</p>
    <button type="button" :disabled="sending" @click="sendLog">{{ sending ? 'Sending…' : sent ? 'Log sent' : 'Send diagnostic log' }}</button>
  </section>
</template>

<style scoped>
.device { display: flex; flex-direction: column; gap: .75rem; max-width: 36rem; align-items: flex-start; }
h2 { margin: 0; font-size: 1.05rem; }
h3 { margin: .75rem 0 0; font-size: .95rem; }
.devices { list-style: none; margin: 0; padding: 0; width: 100%; display: flex; flex-direction: column; gap: .3rem; }
.devices li { display: flex; align-items: center; gap: .5rem; padding: .4rem .6rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); font-size: .875rem; }
.devices .main { display: flex; flex-direction: column; }
.devices em { font-style: normal; font-weight: 500; font-size: .66rem; margin-left: .35rem; padding: .05rem .35rem; border-radius: 4px; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); vertical-align: middle; }
.devices small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
.btn { display: inline-flex; align-items: center; min-height: 2.4rem; padding: .3rem .9rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; background: var(--zfy-surface, #fff); color: var(--zfy-ink, #1a2230); font-weight: 500; font-size: .875rem; text-decoration: none; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .8rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.ok { color: var(--zfy-accent-ink, #0a5a4a); margin: 0; font-size: .875rem; }
.form { display: flex; flex-direction: column; gap: .5rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); align-items: flex-start; width: 100%; }
.form label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; width: 100%; }
.facts { display: grid; grid-template-columns: 10rem 1fr; gap: .3rem 1rem; margin: 0; font-size: .875rem; width: 100%; }
.facts dt { color: var(--zfy-muted, #5a6472); }
.facts dd { margin: 0; }
.mono { font-family: ui-monospace, monospace; font-size: .78rem; word-break: break-all; }
.themes { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .5rem; width: 100%; }
.themes label { display: flex; align-items: center; gap: .6rem; padding: .6rem .75rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; background: var(--zfy-surface, #fff); cursor: pointer; }
.themes label.active { border-color: var(--zfy-accent, #0e7c66); background: var(--zfy-accent-soft, #deeee9); }
.themes .body { display: flex; flex-direction: column; }
.themes .label { font-size: .875rem; font-weight: 600; }
.themes .sub { font-size: .75rem; color: var(--zfy-muted, #5a6472); }
.row { display: flex; gap: .5rem; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; min-height: 2.5rem; padding: .45rem .95rem; border-radius: 8px; border: 1px solid var(--zfy-line, #d6dde4); background: var(--zfy-surface, #fff); color: inherit; text-decoration: none; font-weight: 500; }
.btn:hover { background: var(--zfy-surface-2, #e9edf1); }
</style>
