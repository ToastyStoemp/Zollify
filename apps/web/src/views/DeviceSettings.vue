<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { DeviceSummary } from '@zollify/shared';
import {
  authFetch,
  getApiBase,
  isNative,
  checkForUpdate,
  checkShellUpdate,
  currentAppVersion,
  currentShellVersion,
  downloadUpdate,
  installDownloadedUpdate,
  queueShellUpdate,
  shellUpdateQueued,
  reloadShellNow,
  selfUpdates,
  updateDownload,
  type ShellUpdateCheck,
  type UpdateCheck,
  afterSalePrefs,
  currentAccount,
  refreshTseInfo,
  setTseSettings,
  defaultTillId,
  tseMode,
  setMainTseDevice,
  removeMainTseDevice,
  assignTseHost,
  assignedTseHost,
  shellConfirm,
  tseState,
  type TseDriverId,
  deviceFlavor,
  loadAfterSalePrefs,
  setAfterSalePrefs,
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
  void loadAfterSalePrefs().catch(() => {});
  try {
    id.value = await deviceId();
    name.value = (await deviceName()) ?? '';
    devices.value = (await authFetch('/devices')) as DeviceSummary[];
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not read this device.';
  }
});

// ── KassenSichV: this device's TSE ─────────────────────────────────────────
const checkingTse = ref(false);
async function chooseTse(driver: TseDriverId): Promise<void> {
  // A till needs a serial number for the TSE; suggest one from the device id.
  const clientId = tseState.settings.clientId || (driver !== 'none' && id.value ? defaultTillId(id.value) : '');
  // Without its own TSE a device can't sign for others any more.
  if (driver === 'none' && isMainTse.value) await setMainTseDevice(false);
  await setTseSettings({ driver, clientId });
  if (tseMode() !== 'none') await checkTse();
}

/** The account's main TSE devices: other devices without a TSE sign through them. */
const isMainTse = computed(() => !!id.value && tseState.mainDevices.includes(id.value));
const deviceLabel = (d: string): string => devices.value.find((x) => x.id === d)?.name || `Device ${d.slice(0, 8)}`;
const mainTseNames = computed(() => tseState.mainDevices.filter((d) => d !== id.value).map(deviceLabel));
const tseError = ref<string | null>(null);
/** Main TSE devices this till could be assigned to. */
const hostChoices = computed(() => tseState.mainDevices.filter((d) => d !== id.value));
const hostPick = ref('');
const assigned = computed(() => assignedTseHost());
watch(hostChoices, (list) => {
  if (!list.includes(hostPick.value)) hostPick.value = list[0] ?? '';
}, { immediate: true });
async function assignHost(): Promise<void> {
  tseError.value = null;
  const host = hostPick.value || hostChoices.value[0];
  if (!host) return;
  const till = tseState.settings.clientId.trim() || defaultTillId(id.value);
  const ok = await shellConfirm(
    `This till (${till}) will sign through ${deviceLabel(host)} from now on. This can't be changed afterwards: German rules tie a till to one TSE, and the tax office is told which. ` +
      `If that device is ever replaced, this device needs a new till serial number - a new till, registered again.`,
    'Assign main TSE device?',
  );
  if (!ok) return;
  try {
    await assignTseHost(host);
    await checkTse();
  } catch (err) {
    tseError.value = err instanceof Error ? err.message : String(err);
  }
}
async function removeMain(d: string): Promise<void> {
  const ok = await shellConfirm(
    `Tills assigned to ${deviceLabel(d)} can't move to another TSE: until they get a new till serial number, their sales count as signed during an outage, by another main TSE device.`,
    'Remove main TSE device?',
  );
  if (ok) await removeMainTseDevice(d);
}
const fmtWhen = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

async function toggleMainTse(on: boolean): Promise<void> {
  tseError.value = null;
  try {
    await setMainTseDevice(on);
  } catch (err) {
    tseError.value = err instanceof Error ? err.message : String(err);
  }
}
/** A German receipt must name the seller and their address (§ 6 KassenSichV); the receipt takes them from the profile. */
const sellerMissing = computed(() => {
  const a = account.value?.profile.artist;
  return !(a?.companyName?.trim() || a?.fullName?.trim()) || !a?.street?.trim() || !a?.postCodeCity?.trim();
});
async function checkTse(): Promise<void> {
  checkingTse.value = true;
  try {
    await refreshTseInfo();
  } finally {
    checkingTse.value = false;
  }
}

// ── Diagnostics: send this device's log to the server for support ──────────
const sending = ref(false);
const sent = ref(false);
// ── App updates (Android, not Carbon) ───────────────────────────────────────
const canSelfUpdate = ref(false);
const update = ref<UpdateCheck | null>(null);
const checking = ref(false);
const updateError = ref<string | null>(null);
// The package this install actually is, independent of whether it can
// self-update from here (Carbon can't, but "what am I running" is still
// worth answering) - shown unconditionally, not only after a check.
const appVersion = ref<{ versionCode: number; versionName: string; flavor: string } | null>(null);
const shellVersion = ref<string | null>(null);
onMounted(async () => {
  canSelfUpdate.value = await selfUpdates().catch(() => false);
  appVersion.value = await currentAppVersion().catch(() => null);
  shellVersion.value = await currentShellVersion().catch(() => null);
});

// ── Content updates (every flavour, including Carbon) ───────────────────────
const shellCheck = ref<ShellUpdateCheck | null>(null);
// Distinguishes "haven't checked yet" from "checked, and there's genuinely
// nothing to report" (checkShellUpdate() returns null without throwing when
// the plugin isn't in this build, or the server has never published) -
// without this, both looked identical: no status line at all.
const shellChecked = ref(false);
const shellQueuing = ref(false);
const shellQueued = ref(false);
const shellError = ref<string | null>(null);

/** One button drives both checks: the native APK path (withheld on Carbon) and the content path (works everywhere). Either half can fail without blocking the other. */
async function checkUpdate(): Promise<void> {
  checking.value = true;
  updateError.value = null;
  shellError.value = null;
  shellQueued.value = false;
  try {
    update.value = await checkForUpdate();
    if (update.value?.available) await downloadUpdate(update.value);
  } catch (err) {
    updateError.value = err instanceof Error ? err.message : 'Could not check for updates.';
  }
  try {
    shellCheck.value = await checkShellUpdate();
    shellChecked.value = true;
    if (shellCheck.value?.available) {
      // Already downloaded and waiting for a restart: say so, don't fetch it again.
      if (!shellUpdateQueued(shellCheck.value.latestVersion)) {
        shellQueuing.value = true;
        await queueShellUpdate(shellCheck.value);
      }
      shellQueued.value = true;
    }
  } catch (err) {
    shellError.value = err instanceof Error ? err.message : 'Could not check for content updates.';
  } finally {
    checking.value = false;
    shellQueuing.value = false;
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

    <h3>After a sale</h3>
    <p class="hint">What this screen shows once a payment goes through - on a register and on a customer display alike. Set on each device on its own, so the till and the screen facing the customer can differ.</p>
    <div class="toggles">
      <label>
        <input type="checkbox" :checked="afterSalePrefs.thankYou" @change="setAfterSalePrefs({ thankYou: ($event.target as HTMLInputElement).checked })" />
        <span class="body"><span class="label">Thank-you screen</span><span class="sub">"Thank you!" and the amount paid.</span></span>
      </label>
      <label>
        <input type="checkbox" :checked="afterSalePrefs.receiptQr" @change="setAfterSalePrefs({ receiptQr: ($event.target as HTMLInputElement).checked })" />
        <span class="body"><span class="label">Receipt QR code</span><span class="sub">The customer scans it for their receipt online. Shows the receipt only - never other sales or your stock.</span></span>
      </label>
    </div>

    <h3>TSE (Germany)</h3>
    <p class="hint">
      German law (KassenSichV) wants every sale on an electronic till signed by a certified security device (TSE).
      A device with a TSE signs its own sales, and - as a main TSE device - those of devices without one, such as a backup
      phone, over the live connection. A TSE that fails doesn't stop the till - the receipt says the sale was not signed.
    </p>
    <div class="tse-form">
      <label>
        <span>TSE</span>
        <select :value="tseState.settings.driver" @change="chooseTse(($event.target as HTMLSelectElement).value as TseDriverId)">
          <option value="none">{{ mainTseNames.length ? 'None - sign through a main TSE device' : 'None' }}</option>
          <option value="swissbit">Swissbit TSE (USB or microSD)</option>
          <option value="test">Test TSE - development only, not certified</option>
        </select>
      </label>
      <label v-if="tseMode() === 'own'" class="check">
        <input type="checkbox" :checked="isMainTse" @change="toggleMainTse(($event.target as HTMLInputElement).checked)" />
        <span>Main TSE device - devices without a TSE of their own sign through this one. Keep it on and connected while they sell.</span>
      </label>
      <template v-else-if="tseMode() === 'remote'">
        <div v-if="assigned" class="hint">
          Signs through <strong>{{ deviceLabel(assigned) }}</strong> - assigned to this till, can't be changed. Needs a connection while selling.
          While it is out, another main TSE device signs and the outage is logged.
        </div>
        <div v-else class="assign">
          <p class="error" role="alert">No main TSE device assigned to this till - its sales at events in Germany are not signed.</p>
          <label>
            <span>Main TSE device for this till</span>
            <select v-model="hostPick">
              <option v-for="d in hostChoices" :key="d" :value="d">{{ deviceLabel(d) }}</option>
            </select>
          </label>
          <small>Once assigned this can't be changed: a till belongs to one TSE.</small>
          <div class="row"><button type="button" @click="assignHost">Assign</button></div>
        </div>
        <details v-if="tseState.outages.length" class="outages">
          <summary>TSE outages ({{ tseState.outages.length }})</summary>
          <ul>
            <li v-for="(o, i) in [...tseState.outages].reverse().slice(0, 20)" :key="i">
              {{ fmtWhen(o.from) }} - {{ o.to ? fmtWhen(o.to) : 'ongoing' }}: {{ o.reason }}
            </li>
          </ul>
        </details>
      </template>
      <p v-else-if="tseState.settings.driver === 'none'" class="hint">No main TSE device on this account yet - this device signs nothing.</p>
      <p v-if="tseState.mainDevices.length" class="hint">Main TSE devices:</p>
      <ul v-if="tseState.mainDevices.length" class="main-tse">
        <li v-for="d in tseState.mainDevices" :key="d">
          <span>{{ d === id ? 'This device' : deviceLabel(d) }}</span>
          <button v-if="d !== id" type="button" class="quiet" @click="removeMain(d)">Remove</button>
        </li>
      </ul>
      <p v-if="tseError" class="error" role="alert">{{ tseError }}</p>
      <template v-if="tseMode() !== 'none'">
        <label>
          <span>Till serial number</span>
          <input :value="tseState.settings.clientId" type="text" maxlength="30" @change="setTseSettings({ clientId: ($event.target as HTMLInputElement).value.trim() })" />
          <small>Printed on receipts and given when registering the till with the tax office. Receipt numbers count up per till serial number, so changing it starts them again from 1.</small>
        </label>
        <label>
          <span>Sign</span>
          <select :value="tseState.settings.scope" @change="setTseSettings({ scope: ($event.target as HTMLSelectElement).value as 'germany' | 'always' })">
            <option value="germany">Sales at events in Germany</option>
            <option value="always">Every sale</option>
          </select>
        </label>
        <div class="row">
          <button type="button" :disabled="checkingTse" @click="checkTse">{{ checkingTse ? 'Checking…' : 'Check TSE' }}</button>
        </div>
        <p v-if="sellerMissing" class="error" role="alert">
          Receipts in Germany must show your business name and address. Add them under Settings → Profile, or set them in the till's
          receipt settings.
        </p>
        <p v-if="tseState.error" class="error" role="alert">{{ tseState.error }}</p>
        <dl v-else-if="tseState.info" class="facts">
          <dt>Status</dt>
          <dd :class="tseState.info.certified ? 'ok' : 'warn'">
            {{ tseState.info.certified ? 'Ready' : 'Ready - test TSE, not for real sales' }}{{ tseMode() === 'remote' ? ' (through a main TSE device)' : '' }}
          </dd>
          <dt>TSE serial</dt>
          <dd class="mono">{{ tseState.info.serial }}</dd>
          <dt>Signature</dt>
          <dd>{{ tseState.info.algorithm }}</dd>
          <dt v-if="tseState.info.expires">Certificate until</dt>
          <dd v-if="tseState.info.expires">{{ tseState.info.expires }}</dd>
        </dl>
      </template>
    </div>

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

    <template v-if="isNative()">
      <h3>App updates</h3>
      <dl class="facts">
        <dt>Package</dt>
        <dd class="mono">{{ appVersion ? `${appVersion.flavor} · v${appVersion.versionName} (${appVersion.versionCode})` : '…' }}</dd>
        <dt>Content build</dt>
        <dd class="mono">{{ shellVersion ?? build }}<span v-if="!shellVersion" class="warn"> (content updates unavailable on this install)</span></dd>
      </dl>
      <p class="hint">
        "Check for updates" covers both halves: the app itself (not on Carbon terminals - they take their APK through myPOS instead) and the content it runs, which updates on every flavour without a new install.
      </p>

      <p v-if="updateError" class="error" role="alert">{{ updateError }}</p>
      <p v-else-if="canSelfUpdate && update && !update.available" class="ok" role="status">App up to date ({{ update.currentVersionName }}).</p>
      <p v-else-if="canSelfUpdate && update?.available && updateDownload.active" class="hint">Downloading app {{ update.versionName }}… {{ progressPct() }}%</p>
      <p v-else-if="canSelfUpdate && update?.available && updateDownload.error" class="error" role="alert">App download failed: {{ updateDownload.error }}</p>

      <p v-if="shellError" class="error" role="alert">{{ shellError }}</p>
      <p v-else-if="shellQueuing" class="hint">Downloading content update…</p>
      <p v-else-if="shellQueued" class="ok" role="status">Content {{ shellCheck?.latestVersion }} downloaded - ready next time the app opens.</p>
      <p v-else-if="shellCheck && !shellCheck.available" class="ok" role="status">Content up to date ({{ shellCheck.currentVersion }}).</p>
      <p v-else-if="shellChecked && !shellCheck" class="warn" role="status">Content updates aren't available here - either this install predates them (reinstall the app) or the server has nothing published (check Server admin).</p>

      <div class="row">
        <button type="button" :disabled="checking || updateDownload.active" @click="checkUpdate">{{ checking ? 'Checking…' : 'Check for updates' }}</button>
        <button v-if="shellQueued" type="button" class="primary" @click="reloadShellNow">Reload now</button>
        <button v-if="canSelfUpdate && updateDownload.ready" type="button" class="primary" @click="installDownloadedUpdate">Install {{ updateDownload.versionName }}</button>
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
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .8rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.warn { color: var(--zfy-warning-ink, #8a5a1e); margin: 0; }
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
.toggles { display: flex; flex-direction: column; gap: .5rem; width: 100%; }
.toggles label { display: flex; align-items: flex-start; gap: .6rem; padding: .6rem .75rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; background: var(--zfy-surface, #fff); cursor: pointer; }
.toggles input { margin-top: .2rem; }
.toggles .body { display: flex; flex-direction: column; }
.toggles .label { font-size: .875rem; font-weight: 600; }
.toggles .sub { font-size: .75rem; color: var(--zfy-muted, #5a6472); }
.tse-form { display: flex; flex-direction: column; gap: .6rem; width: 100%; }
.tse-form label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.tse-form small { color: var(--zfy-muted, #5a6472); font-size: .75rem; }
.tse-form label.check { flex-direction: row; align-items: flex-start; gap: .5rem; }
.assign { display: flex; flex-direction: column; gap: .4rem; }
.assign label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.outages { font-size: .8rem; color: var(--zfy-muted, #5a6472); }
.outages ul { margin: .3rem 0 0; padding-left: 1.1rem; }
.main-tse { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.main-tse li { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
.row { display: flex; gap: .5rem; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; min-height: 2.5rem; padding: .45rem .95rem; border-radius: 8px; border: 1px solid var(--zfy-line, #d6dde4); background: var(--zfy-surface, #fff); color: inherit; text-decoration: none; font-weight: 500; font-size: .875rem; }
.btn:hover { background: var(--zfy-surface-2, #e9edf1); }
</style>
