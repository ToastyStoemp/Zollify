<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  applyLogin,
  configureApiBase,
  deviceFlavor,
  getServerUrl,
  isNative,
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
  startRealtime,
} from '@zollify/platform';
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
const server = ref(getServerUrl());
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

onMounted(async () => {
  if (!native || getServerUrl()) await checkFirstRun();
  // The device identity lives in the account's database, so before the first
  // sign-in on this device there is none yet; the server assigns one then.
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
  // Same order as a cold boot: core data first, then modules, which read it through the SDK as they mount.
  await Promise.all([loadCatalog(), loadSalesEvents(), loadTransactions(), loadDiscounts(), loadInventory()]);
  await loadEnabledModules(router);
  startAutoSync();
  startRealtime();
  const next = typeof route.query.next === 'string' ? route.query.next : '/home';
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
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
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
    <form @submit.prevent="mode === 'login' ? login() : register()">
      <h1>Zollify<span>.</span></h1>
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
      </template>
      <template v-else>
        <label v-if="!firstRun"><span>Invite code</span><input v-model="inviteCode" type="text" autocomplete="off" placeholder="From whoever invited you" /></label>
        <label><span>Booth name</span><input v-model="accountName" type="text" :placeholder="firstRun ? 'Your booth or studio' : 'Only for a brand-new account'" /></label>
        <p v-if="!firstRun" class="hint">Joining an existing booth? The invite code puts you in it - the booth name is ignored.</p>
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Creating…' : firstRun ? 'Set up this server' : 'Create account' }}</button>
      </template>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>
  </div>
</template>

<style scoped>
.login { display: grid; place-items: center; padding: 1rem; }
form { display: flex; flex-direction: column; gap: .75rem; width: 100%; max-width: 21rem; background: var(--zfy-surface, #fff); padding: 1.5rem; border-radius: 14px; border: 1px solid var(--zfy-line, #d6dde4); }
h1 { margin: 0; font-size: 1.5rem; letter-spacing: -.02em; }
h1 span { color: var(--zfy-accent, #0e7c66); }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label.inline { flex-direction: row; align-items: center; gap: .4rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .78rem; }
.setup { color: var(--zfy-accent-ink, #0a5a4a); font-size: .85rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; font-size: .875rem; }
.seg { display: flex; }
.seg button { flex: 1; }
</style>
