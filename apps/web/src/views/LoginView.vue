<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  applyLogin,
  configureApiBase,
  deviceFlavor,
  getServerUrl,
  isNative,
  nativeHeaders,
  setServerUrl,
  deviceId,
  deviceName,
  getApiBase,
  loadCatalog,
  loadDiscounts,
  loadInventory,
  loadSalesEvents,
  loadTransactions,
  startAutoSync,
  startTillLock,
  startRealtime,
} from '@zollify/platform';
import { QrCode } from '@zollify/ui';
import { loadEnabledModules } from '../boot';

/**
 * Sign in, or create an account with an invite code - ported from ZollTool's
 * web auth gate. A second factor is asked for when the account has one, and
 * "remember this device" keeps a trust token so it is not asked again here.
 */
const router = useRouter();
const route = useRoute();

const mode = ref<'login' | 'register'>('login');
/** Android app only: which Zollify server this device talks to. */
const native = isNative();
/** Pre-filled with the hosted server; still editable for anyone self-hosting. */
const server = ref(getServerUrl() || 'https://zollify.app');
function pointAtServer(): boolean {
  if (!native) return true;
  const url = server.value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/.test(url)) {
    error.value = 'Enter the server address, like https://zollify.example.com';
    return false;
  }
  setServerUrl(url);
  configureApiBase(`${url}/api`);
  return true;
}
const email = ref('');
const password = ref('');
const code = ref('');
const needs2fa = ref(false);
const remember = ref(true);
const inviteCode = ref('');
const accountName = ref('');
const error = ref<string | null>(null);
const busy = ref(false);
const TRUST_KEY = 'zollify.deviceTrust';
let myDeviceId = '';
let myDeviceName = '';

/** A server with no users yet: the first registration creates its owner, no invite needed. */
const firstRun = ref(false);
async function checkFirstRun(): Promise<void> {
  try {
    const res = await fetch(`${getApiBase()}/setup`);
    firstRun.value = res.ok && ((await res.json()) as { needsOwner?: boolean }).needsOwner === true;
  } catch {
    firstRun.value = false;
  }
  if (firstRun.value) mode.value = 'register';
}

/** An invite link (`/login?invite=…`, e.g. a store inviting an artist) opens straight on Create account. */
const invitedWith = typeof route.query.invite === 'string' ? route.query.invite.slice(0, 40) : '';
if (invitedWith) {
  inviteCode.value = invitedWith;
  mode.value = 'register';
}

onMounted(async () => {
  if (!native || getServerUrl()) await checkFirstRun();
  // Before the first sign-in the device has a provisional id, which the
  // account adopts once signed in - so even that first session names it.
  try {
    myDeviceId = await deviceId();
    myDeviceName = (await deviceName()) ?? '';
  } catch {
    /* signed out on a fresh device */
  }
});

async function afterLogin(body: unknown): Promise<void> {
  applyLogin(body as never);
  const trust = (body as { deviceTrustToken?: string }).deviceTrustToken;
  if (trust) {
    try {
      localStorage.setItem(TRUST_KEY, trust);
    } catch {
      /* no storage */
    }
  }
  // Whatever this device already has locally - instant, no network.
  await Promise.all([loadCatalog(), loadSalesEvents(), loadTransactions(), loadDiscounts(), loadInventory()]);
  const next = typeof route.query.next === 'string' ? route.query.next : '/home';
  // Signed in now: go in straight away. Modules download and data syncs in
  // the background, with a progress card while a first sync runs - rather
  // than holding the user on "Signing in…" for all of it.
  const setup = (async () => {
    // Same order as a cold boot: modules mount before the first pull reloads the stores they read.
    await loadEnabledModules(router).catch((err) => console.error('[zollify] module boot failed', err));
    startAutoSync();
    startRealtime();
    startTillLock({ unlocked: true });
  })();
  // A module screen (e.g. the till) only exists once its module is loaded.
  if (next.startsWith('/m/')) await setup;
  await router.replace(next);
}

async function login(): Promise<void> {
  error.value = null;
  if (!pointAtServer()) return;
  busy.value = true;
  try {
    let trustToken: string | undefined;
    try {
      trustToken = localStorage.getItem(TRUST_KEY) ?? undefined;
    } catch {
      /* no storage */
    }
    const res = await fetch(`${getApiBase()}/auth/login`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...nativeHeaders() },
      body: JSON.stringify({
        email: email.value,
        password: password.value,
        deviceId: myDeviceId,
        deviceName: myDeviceName || undefined,
        flavor: deviceFlavor(),
        code: code.value.trim() || undefined,
        trustToken,
        rememberDevice: remember.value,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; needs2fa?: boolean };
    if (res.status === 401 && body.needs2fa) {
      if (needs2fa.value && code.value) error.value = body.error ?? 'That code was not accepted.';
      needs2fa.value = true;
      return;
    }
    if (!res.ok) {
      // Unknown email and wrong password read the same on purpose.
      error.value = 'That email and password combination was not recognised.';
      return;
    }
    await afterLogin(body);
  } catch {
    error.value = 'Could not reach the server. Check your connection and try again.';
  } finally {
    busy.value = false;
  }
}

// ── Sign in with another device (QR) ─────────────────────────────────────────
// This device shows a code that rotates every few seconds; a device that is
// already signed in scans it and approves. Only this device holds the poll
// secret, so the code on screen can't be used to collect the session.

const qrMode = ref(false);
const qrValue = ref('');
const qrState = ref<'waiting' | 'expired' | 'denied'>('waiting');
let link: { id: string; pollSecret: string } | null = null;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
const POLL_MS = 2000;

/** The address the QR points at: this server's link screen, so a phone's own camera app can open it too. */
function qrUrl(code: string): string {
  const base = native ? getServerUrl().replace(/\/+$/, '') + '/' : `${location.origin}${location.pathname}`;
  return `${base}#/link?c=${encodeURIComponent(code)}`;
}

function stopQr(): void {
  clearTimeout(pollTimer);
  pollTimer = undefined;
  link = null;
}

async function startQr(): Promise<void> {
  error.value = null;
  if (!pointAtServer()) return;
  stopQr();
  qrMode.value = true;
  qrState.value = 'waiting';
  qrValue.value = '';
  try {
    const res = await fetch(`${getApiBase()}/auth/link/start`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...nativeHeaders() },
      body: JSON.stringify({ deviceId: myDeviceId || undefined, deviceName: myDeviceName || undefined, flavor: deviceFlavor() }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; pollSecret?: string; code?: string; error?: string };
    if (!res.ok || !body.id || !body.pollSecret || !body.code) {
      error.value = body.error ?? 'Could not start sign-in by QR.';
      qrMode.value = false;
      return;
    }
    link = { id: body.id, pollSecret: body.pollSecret };
    qrValue.value = qrUrl(body.code);
    pollTimer = setTimeout(pollQr, POLL_MS);
  } catch {
    error.value = 'Could not reach the server. Check your connection and try again.';
    qrMode.value = false;
  }
}

async function pollQr(): Promise<void> {
  const current = link;
  if (!current) return;
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}/auth/link/poll`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...nativeHeaders() },
      body: JSON.stringify(current),
    });
  } catch {
    // A dropped request mid-wait isn't the end - try again next tick.
    if (link === current) pollTimer = setTimeout(pollQr, POLL_MS);
    return;
  }
  // Cancelled, or a fresh code was started while this one was in flight.
  if (link !== current) return;
  const body = (await res.json().catch(() => ({}))) as { status?: string; code?: string };

  if (res.ok && body.status === 'approved') {
    stopQr();
    busy.value = true;
    try {
      await afterLogin(body);
    } finally {
      busy.value = false;
    }
    return;
  }
  if (res.ok && body.status === 'pending') {
    if (body.code) qrValue.value = qrUrl(body.code);
    pollTimer = setTimeout(pollQr, POLL_MS);
    return;
  }
  if (res.status >= 500 || res.status === 429) {
    pollTimer = setTimeout(pollQr, POLL_MS * 2);
    return;
  }
  stopQr();
  qrState.value = body.status === 'denied' ? 'denied' : 'expired';
}

function closeQr(): void {
  stopQr();
  qrMode.value = false;
}

onBeforeUnmount(stopQr);

/** Account creation is bot-gated by a proof-of-work challenge solved here before the request. */
async function register(): Promise<void> {
  error.value = null;
  if (!pointAtServer()) return;
  busy.value = true;
  try {
    const challenge = (await (await fetch(`${getApiBase()}/captcha/challenge`)).json()) as { token: string; nonce: string; difficulty: number };
    const { solveChallenge } = await import('../lib/captcha');
    const captchaSolution = solveChallenge(challenge.nonce, challenge.difficulty);
    const res = await fetch(`${getApiBase()}/auth/register`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...nativeHeaders() },
      body: JSON.stringify({
        email: email.value,
        password: password.value,
        inviteCode: inviteCode.value.trim() || undefined,
        accountName: accountName.value.trim() || undefined,
        captchaToken: challenge.token,
        captchaSolution,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      error.value = body.error ?? 'Could not create the account.';
      return;
    }
    // Registering signs you in as well.
    await afterLogin(body);
  } catch {
    error.value = 'Could not reach the server. Check your connection and try again.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login">
    <section v-if="qrMode" class="panel qr-panel" aria-live="polite">
      <h1><img src="/favicon.svg" alt="" class="mark" />Zollify<span>.</span></h1>
      <template v-if="qrState === 'waiting'">
        <p class="lede">On a phone or tablet that's already signed in, open <strong>Settings → Account &amp; security → Sign in another device</strong> and scan this code. A phone's camera app works too.</p>
        <QrCode v-if="qrValue" :value="qrValue" :size="220" label="Sign-in QR code" class="qr" />
        <span v-else class="qr qr-wait" aria-hidden="true"></span>
        <p class="hint">{{ busy ? 'Approved - signing in…' : 'The code changes every few seconds. Waiting for approval…' }}</p>
      </template>
      <template v-else>
        <p class="error" role="alert">{{ qrState === 'denied' ? 'The other device declined this sign-in.' : 'This code has expired.' }}</p>
        <button type="button" class="primary" @click="startQr">Show a new code</button>
      </template>
      <button type="button" class="quiet" @click="closeQr">Sign in with a password instead</button>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </section>
    <form v-else class="panel" @submit.prevent="mode === 'login' ? login() : register()">
      <h1><img src="/favicon.svg" alt="" class="mark" />Zollify<span>.</span></h1>
      <p v-if="firstRun" class="hint setup">First run - the account you create now owns this server.</p>
      <div v-if="!firstRun" class="seg" role="tablist">
        <button type="button" role="tab" :aria-selected="mode === 'login'" :class="{ on: mode === 'login' }" @click="mode = 'login'; error = null">Sign in</button>
        <button type="button" role="tab" :aria-selected="mode === 'register'" :class="{ on: mode === 'register' }" @click="mode = 'register'; error = null">Create account</button>
      </div>

      <label v-if="native"><span>Server</span><input v-model="server" type="url" inputmode="url" autocomplete="url" placeholder="https://zollify.example.com" required @change="pointAtServer() && checkFirstRun()" /></label>
      <label><span>Email</span><input v-model="email" type="email" autocomplete="username" autofocus required /></label>
      <label><span>Password</span><input v-model="password" type="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" :minlength="mode === 'register' ? 8 : undefined" required /></label>

      <template v-if="mode === 'login'">
        <template v-if="needs2fa">
          <label><span>Authenticator code</span><input v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="6-digit code, or a recovery code" /></label>
          <label class="inline"><input v-model="remember" type="checkbox" /> <span>Remember this device</span></label>
        </template>
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
        <button type="button" class="quiet" :disabled="busy" @click="startQr">Sign in with another device</button>
      </template>
      <template v-else>
        <label v-if="!firstRun"><span>Invite code</span><input v-model="inviteCode" type="text" autocomplete="off" placeholder="From whoever invited you" /></label>
        <label><span>Business name</span><input v-model="accountName" type="text" :placeholder="firstRun ? 'Your business or studio' : 'Only for a brand-new account'" /></label>
        <p v-if="!firstRun" class="hint">Joining an existing business? The invite code puts you in it - the business name is ignored.</p>
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Creating…' : firstRun ? 'Set up this server' : 'Create account' }}</button>
      </template>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>
  </div>
</template>

<style scoped>
.login {
  display: grid; place-items: center; padding: 1rem;
  /* Centred in the viewport, clear of the status and gesture bars in the app. */
  min-height: 100dvh;
  padding-top: calc(1rem + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)));
  padding-bottom: calc(1rem + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
}
.panel { display: flex; flex-direction: column; gap: .75rem; width: 100%; max-width: 21rem; background: var(--zfy-surface, #fff); padding: 1.5rem; border-radius: 14px; border: 1px solid var(--zfy-line, #d6dde4); }
h1 { margin: 0; font-size: 1.5rem; letter-spacing: -.02em; display: flex; align-items: center; gap: .5rem; }
h1 .mark { width: 2rem; height: 2rem; border-radius: 8px; }
h1 span { color: var(--zfy-accent, #0e7c66); }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label.inline { flex-direction: row; align-items: center; gap: .4rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .78rem; }
.setup { color: var(--zfy-accent-ink, #0a5a4a); font-size: .85rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; font-size: .875rem; }
.seg { display: flex; }
.seg button { flex: 1; }
.qr-panel { align-items: stretch; text-align: center; }
.qr-panel h1 { justify-content: center; }
.lede { margin: 0; font-size: .875rem; text-align: left; }
.qr { align-self: center; }
.qr-wait { display: block; width: 220px; height: 220px; border-radius: 12px; background: var(--zfy-bg, #f1f4f6); }
</style>
