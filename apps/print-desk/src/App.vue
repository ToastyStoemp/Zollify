<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { QrCode } from '@zollify/ui';
import type { CatalogRow, CopyProgress, PrintLink, Printer, Session, Settings, Theme } from '../electron/shared';
import { PAPERS } from '../electron/shared';
import PrintSettings from './PrintSettings.vue';

const api = window.printDesk;

const settings = ref<Settings | null>(null);
const session = ref<Session | null>(null);
const rows = ref<CatalogRow[]>([]);
const printers = ref<Printer[]>([]);
const qty = reactive<Record<string, number>>({});
/** Per item of the current or last print run: copies left, from the print queue. */
const progress = reactive<Record<string, CopyProgress>>({});
const open = ref<string | null>(null);
const busy = ref('');
const error = ref('');
const filter = ref('');

const login = reactive({ server: '', email: '', password: '', code: '', needs2fa: false });

const links = computed<Record<string, PrintLink>>(() => (session.value && settings.value ? (settings.value.links[session.value.accountId] ?? {}) : {}));
/** Over the whole catalogue, not the filtered rows, so the column does not come and go while typing a filter. */
const hasSku = computed(() => rows.value.some((r) => r.sku));
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return q ? rows.value.filter((r) => `${r.title} ${r.variant} ${r.sku}`.toLowerCase().includes(q)) : rows.value;
});
const queued = computed(() => rows.value.filter((r) => (qty[r.key] ?? 0) > 0 && links.value[r.key]?.file));
const totalCopies = computed(() => queued.value.reduce((n, r) => n + (qty[r.key] ?? 0), 0));
/** Copies of the current run not printed yet; null once nothing is printing. */
const copiesLeft = computed(() => {
  const active = Object.values(progress).filter((p) => !p.done);
  return active.length ? Object.values(progress).reduce((n, p) => n + p.left, 0) : null;
});

async function guard<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  busy.value = what;
  error.value = '';
  try {
    return await fn();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return undefined;
  } finally {
    busy.value = '';
  }
}

onMounted(async () => {
  settings.value = await api.settings.get();
  login.server = settings.value.server || 'https://';
  session.value = await api.zollify.resume();
  if (session.value) await loadAll();
  api.photocraft.onQueue((p) => {
    progress[p.key] = p;
  });
});

async function loadAll(): Promise<void> {
  await Promise.all([refreshCatalog(), refreshPrinters()]);
}
async function refreshCatalog(): Promise<void> {
  await guard('Loading catalogue', async () => {
    rows.value = await api.zollify.catalog();
  });
}
async function refreshPrinters(): Promise<void> {
  try {
    printers.value = await api.photocraft.printers();
  } catch (err) {
    printers.value = [];
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function signIn(): Promise<void> {
  busy.value = 'Signing in';
  error.value = '';
  try {
    session.value = await api.zollify.login({ server: login.server.trim(), email: login.email.trim(), password: login.password, code: login.code.trim() || undefined });
    login.password = '';
    login.code = '';
    login.needs2fa = false;
    settings.value = await api.settings.get();
    await loadAll();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    login.needs2fa = msg.includes('2FA:');
    error.value = msg.replace(/^.*2FA:/, '');
  } finally {
    busy.value = '';
  }
}
// ── Sign in by QR: a signed-in phone scans and approves; this app polls for the session ──
const QR_POLL_MS = 2000;
const qr = reactive({ mode: false, value: '', state: 'waiting' as 'waiting' | 'denied' | 'expired' });
let link: { id: string; pollSecret: string } | null = null;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

function stopQr(): void {
  clearTimeout(pollTimer);
  pollTimer = undefined;
  link = null;
}
/** An http(s) address with a host: localhost and bare IPs included. */
function serverOk(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname;
  } catch {
    return false;
  }
}
async function startQr(): Promise<void> {
  stopQr();
  error.value = '';
  if (!serverOk(login.server)) {
    error.value = 'Enter your Zollify server address first, e.g. https://zollify.example.com';
    return;
  }
  qr.mode = true;
  qr.state = 'waiting';
  qr.value = '';
  try {
    const started = await api.zollify.linkStart(login.server.trim());
    link = { id: started.id, pollSecret: started.pollSecret };
    qr.value = started.qr;
    pollTimer = setTimeout(pollQr, QR_POLL_MS);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    qr.mode = false;
  }
}
async function pollQr(): Promise<void> {
  const current = link;
  if (!current) return;
  let r: Awaited<ReturnType<typeof api.zollify.linkPoll>>;
  try {
    r = await api.zollify.linkPoll(current.id, current.pollSecret);
  } catch {
    // A dropped request mid-wait is not the end: try again next tick.
    if (link === current) pollTimer = setTimeout(pollQr, QR_POLL_MS);
    return;
  }
  // Cancelled, or a fresh code was started while this one was in flight.
  if (link !== current) return;
  if (r.status === 'approved' && r.session) {
    stopQr();
    qr.mode = false;
    session.value = r.session;
    settings.value = await api.settings.get();
    await loadAll();
    return;
  }
  if (r.status === 'pending') {
    if (r.qr) qr.value = r.qr;
    pollTimer = setTimeout(pollQr, QR_POLL_MS);
    return;
  }
  stopQr();
  qr.state = r.status === 'denied' ? 'denied' : 'expired';
}
function closeQr(): void {
  stopQr();
  qr.mode = false;
}
onBeforeUnmount(stopQr);

async function signOut(): Promise<void> {
  await api.zollify.logout();
  session.value = null;
  rows.value = [];
}

async function saveLink(key: string, link: PrintLink): Promise<void> {
  if (!settings.value || !session.value) return;
  const acc = session.value.accountId;
  const all = { ...settings.value.links, [acc]: { ...(settings.value.links[acc] ?? {}), [key]: link } };
  settings.value = await api.settings.set({ links: all });
}
async function pickFile(row: CatalogRow): Promise<void> {
  const file = await api.pickFile();
  if (!file) return;
  const cur = links.value[row.key];
  await saveLink(row.key, { file, params: cur?.params ?? defaultParams() });
}
function defaultParams(): Record<string, unknown> {
  const def = printers.value.find((p) => p.default)?.name;
  return { ...(def ? { printer: def } : {}), paper: 'a4', orientation: 'portrait', scaleToFit: true, colorHandling: 'printerManages' };
}
async function pickExe(): Promise<void> {
  const exe = await api.pickExe();
  if (!exe) return;
  settings.value = await api.settings.set({ photocraft: exe });
  await refreshPrinters();
}
async function setTheme(theme: Theme): Promise<void> {
  settings.value = await api.settings.set({ theme });
}
async function toggleAddToStock(on: boolean): Promise<void> {
  settings.value = await api.settings.set({ addToStock: on });
}

async function printAll(): Promise<void> {
  const jobs = queued.value.map((r) => ({ key: r.key, file: links.value[r.key]!.file, params: links.value[r.key]!.params, copies: qty[r.key]! }));
  // A new run starts a fresh count; rows from a finished run drop out of it.
  for (const k of Object.keys(progress)) if (progress[k]!.done) delete progress[k];
  for (const j of jobs) progress[j.key] = { key: j.key, copies: j.copies, left: j.copies, status: 'Waiting', done: false };
  await guard(`Sending ${totalCopies.value} copies`, async () => {
    const done = await api.photocraft.print(jobs);
    const printed = done.filter((r) => r.ok);
    if (settings.value?.addToStock && printed.length) {
      const byKey = new Map(rows.value.map((r) => [r.key, r]));
      await api.zollify.setOnHand(
        printed.map((r) => {
          const row = byKey.get(r.key)!;
          return { productId: row.productId, variantId: row.variantId, onHand: row.onHand + (qty[r.key] ?? 0) };
        }),
      );
      for (const r of printed) {
        const row = byKey.get(r.key)!;
        row.onHand += qty[r.key] ?? 0;
      }
    }
    for (const r of printed) qty[r.key] = 0;
  });
}
</script>

<template>
  <label class="theme">
    <span class="muted">Theme</span>
    <select :value="settings?.theme ?? 'system'" @change="setTheme(($event.target as HTMLSelectElement).value as Theme)">
      <option value="system">Device</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>
  <main v-if="!session" class="login">
    <h1>Zollify Print Desk</h1>
    <section v-if="qr.mode" class="qr-panel" aria-live="polite">
      <template v-if="qr.state === 'waiting'">
        <p class="muted">On a phone or tablet that is already signed in, open <strong>Settings → Account &amp; security → Sign in another device</strong> and scan this code. A phone's camera app works too.</p>
        <QrCode v-if="qr.value" :value="qr.value" :size="220" label="Sign-in QR code" class="qr" />
        <span v-else class="qr qr-wait" aria-hidden="true"></span>
        <p class="muted">{{ busy || 'The code changes every few seconds. Waiting for approval…' }}</p>
      </template>
      <template v-else>
        <p class="error" role="alert">{{ qr.state === 'denied' ? 'The other device declined this sign-in.' : 'This code has expired.' }}</p>
        <button type="button" class="primary" @click="startQr">Show a new code</button>
      </template>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button type="button" class="quiet" @click="closeQr">Sign in with a password instead</button>
    </section>
    <form v-else @submit.prevent="signIn">
      <p class="muted">Sign in with your Zollify account. Files and print settings stay on this computer.</p>
      <label><span>Zollify server</span><input v-model="login.server" type="url" required placeholder="https://zollify.example.com" /></label>
      <label><span>Email</span><input v-model="login.email" type="email" required autocomplete="username" /></label>
      <label><span>Password</span><input v-model="login.password" type="password" required autocomplete="current-password" /></label>
      <label v-if="login.needs2fa"><span>Authenticator code</span><input v-model="login.code" inputmode="numeric" autocomplete="one-time-code" /></label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button type="submit" class="primary" :disabled="!!busy">{{ busy || 'Sign in' }}</button>
      <button type="button" class="quiet" :disabled="!!busy" @click="startQr">Sign in from another device with a QR code</button>
    </form>
  </main>

  <main v-else class="desk">
    <header>
      <div>
        <strong>{{ session.email }}</strong>
        <button type="button" class="quiet" @click="signOut">Sign out</button>
        <button type="button" class="quiet" :disabled="!!busy" @click="refreshCatalog">Reload catalogue</button>
      </div>
      <div class="exe">
        <span class="muted">photocraft-cli:</span>
        <code :title="settings?.photocraft">{{ settings?.photocraft || 'not found' }}</code>
        <button type="button" class="quiet" @click="pickExe">Browse</button>
      </div>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div class="toolbar">
      <input v-model="filter" type="search" placeholder="Filter products" />
      <label class="inline"><input type="checkbox" :checked="settings?.addToStock" @change="toggleAddToStock(($event.target as HTMLInputElement).checked)" /> Add printed copies to Zollify stock</label>
      <span class="muted">{{ queued.length }} items, {{ totalCopies }} copies</span>
      <button type="button" class="primary" :disabled="!!busy || !queued.length" @click="printAll">{{ busy || 'Print all' }}</button>
    </div>
    <p v-if="copiesLeft !== null" class="queue" role="status">Printing: <strong>{{ copiesLeft }}</strong> {{ copiesLeft === 1 ? 'copy' : 'copies' }} left, as the print queue reports it</p>

    <table>
      <thead>
        <tr><th>Product</th><th v-if="hasSku">SKU</th><th>On hand</th><th>File</th><th>Printer / paper</th><th>Print</th><th>Result</th></tr>
      </thead>
      <tbody>
        <template v-for="row in shown" :key="row.key">
          <tr>
            <td><div>{{ row.title }}</div><div v-if="row.variant" class="muted">{{ row.variant }}</div></td>
            <td v-if="hasSku"><code>{{ row.sku }}</code></td>
            <td>{{ row.onHand }}</td>
            <td>
              <button type="button" class="quiet" :title="links[row.key]?.file" @click="pickFile(row)">{{ links[row.key]?.file ? links[row.key]!.file.split(/[\\/]/).pop() : 'Link a file' }}</button>
            </td>
            <td>
              <span v-if="links[row.key]">{{ links[row.key]!.params.printer || 'default printer' }}, {{ links[row.key]!.params.paper || 'letter' }} {{ links[row.key]!.params.orientation || '' }}</span>
              <button v-if="links[row.key]" type="button" class="quiet" @click="open = open === row.key ? null : row.key">{{ open === row.key ? 'Close' : 'Settings' }}</button>
            </td>
            <td><input v-model.number="qty[row.key]" type="number" min="0" max="999" :disabled="!links[row.key]?.file" /></td>
            <td>
              <template v-if="progress[row.key]">
                <span v-if="progress[row.key]!.failed" class="error">{{ progress[row.key]!.status }}</span>
                <span v-else-if="progress[row.key]!.done" class="ok">{{ progress[row.key]!.copies }} printed</span>
                <template v-else>
                  <progress :max="progress[row.key]!.copies" :value="progress[row.key]!.copies - progress[row.key]!.left"></progress>
                  <div>{{ progress[row.key]!.copies - progress[row.key]!.left }} / {{ progress[row.key]!.copies }} · {{ progress[row.key]!.status }}</div>
                </template>
              </template>
            </td>
          </tr>
          <tr v-if="open === row.key && links[row.key]" class="settings">
            <td :colspan="hasSku ? 7 : 6">
              <PrintSettings :params="links[row.key]!.params" :printers="printers" :papers="PAPERS" @update="saveLink(row.key, { file: links[row.key]!.file, params: $event })" />
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <p v-if="!rows.length && !busy" class="muted">No art prints yet. Give products the type "Art Print" in Zollify's catalogue, then reload.</p>
  </main>
</template>

<style scoped>
.theme { position: fixed; right: 1rem; bottom: 1rem; flex-direction: row; align-items: center; gap: .4rem; z-index: 1; }
.login { max-width: 24rem; margin: 10vh auto; padding: 1.5rem; background: var(--zfy-surface); border-radius: 12px; }
.login form { display: flex; flex-direction: column; gap: .8rem; }
.login h1 { margin: 0 0 .25rem; font-size: 1.3rem; }
.login .muted { margin: 0; }
.qr-panel { display: flex; flex-direction: column; align-items: center; gap: .8rem; text-align: center; }
.qr-wait { display: block; width: 220px; height: 220px; border-radius: 12px; background: #fff; opacity: .5; }
.desk { padding: 1rem; display: flex; flex-direction: column; gap: .8rem; }
header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
.exe { display: flex; align-items: center; gap: .4rem; }
.exe code { max-width: 28rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toolbar { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.toolbar input[type='search'] { flex: 1; min-width: 12rem; }
table { width: 100%; border-collapse: collapse; background: var(--zfy-surface); border-radius: 10px; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--zfy-line); vertical-align: top; }
th { font-size: .8rem; color: var(--zfy-muted); font-weight: 600; }
tr.settings td { background: var(--zfy-bg); }
.queue { margin: 0; }
td progress { width: 8rem; accent-color: var(--zfy-primary); }
</style>
