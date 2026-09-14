<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { authFetch, currentAccount, deviceId, shellConfirm, signOut, stopAutoSync, stopRealtime } from '@zollify/platform';
import { loader } from '../boot';
import { Icon } from '@zollify/ui';

/**
 * Account & security — ported from ZollTool: two-factor authentication with
 * recovery codes, the login sessions on this account with remote sign-out,
 * and the danger zone (delete my login, or the whole account).
 */

const account = currentAccount;
const isAdmin = computed(() => account.value?.role === 'owner' || account.value?.role === 'admin');
const error = ref<string | null>(null);

// ── Two-factor ──────────────────────────────────────────────────────────────
const twofaEnabled = ref<boolean | null>(null);
const setup = ref<{ secret: string; otpauth: string } | null>(null);
const qr = ref('');
const code = ref('');
const recovery = ref<string[] | null>(null);
const busy = ref(false);

async function loadTwofa(): Promise<void> {
  try {
    twofaEnabled.value = ((await authFetch('/2fa/status')) as { enabled: boolean }).enabled;
  } catch {
    twofaEnabled.value = null;
  }
}
async function startSetup(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    setup.value = (await authFetch('/2fa/setup', { method: 'POST' })) as { secret: string; otpauth: string };
    const { toDataURL } = await import('qrcode');
    qr.value = await toDataURL(setup.value.otpauth, { margin: 1, width: 200 });
    code.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not start 2FA setup.';
  } finally {
    busy.value = false;
  }
}
async function confirmSetup(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const res = (await authFetch('/2fa/enable', { method: 'POST', body: JSON.stringify({ code: code.value.trim() }) })) as { enabled: boolean; recovery: string[] };
    recovery.value = res.recovery;
    setup.value = null;
    twofaEnabled.value = true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'That code was not accepted.';
  } finally {
    busy.value = false;
  }
}
async function disableTwofa(): Promise<void> {
  const c = window.prompt('Enter an authenticator or recovery code to disable 2FA:');
  if (!c) return;
  busy.value = true;
  error.value = null;
  try {
    await authFetch('/2fa/disable', { method: 'POST', body: JSON.stringify({ code: c.trim() }) });
    twofaEnabled.value = false;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not disable 2FA.';
  } finally {
    busy.value = false;
  }
}

// ── Sessions ────────────────────────────────────────────────────────────────
interface Session {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  device: string | null;
  ip: string | null;
  geo: string | null;
  flavor: string | null;
  createdAt: number;
  lastUsedAt: number;
}
const sessions = ref<Session[]>([]);
const geo = ref(false);
const myDevice = ref('');
async function loadSessions(): Promise<void> {
  try {
    const res = (await authFetch('/sessions')) as { geo: boolean; sessions: Session[] };
    sessions.value = res.sessions;
    geo.value = res.geo;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load sessions.';
  }
}
const isMine = (s: Session): boolean => !!s.deviceId && s.deviceId === myDevice.value;
async function revoke(id: string): Promise<void> {
  await authFetch(`/sessions/${id}`, { method: 'DELETE' });
  await loadSessions();
}
async function revokeOthers(): Promise<void> {
  if (!(await shellConfirm('Every other device is signed out and must log in again.', 'Log out all other devices?'))) return;
  await authFetch('/sessions/revoke-others', { method: 'POST', body: JSON.stringify({ deviceId: myDevice.value }) });
  await loadSessions();
}
const ago = (ts: number): string => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
};

// ── Danger zone ─────────────────────────────────────────────────────────────
const showDanger = ref(false);
const password = ref('');
const confirmText = ref('');
const deleting = ref(false);
async function confirmDelete(): Promise<void> {
  if (confirmText.value.trim() !== 'DELETE') {
    error.value = 'Type DELETE to confirm.';
    return;
  }
  deleting.value = true;
  error.value = null;
  try {
    await authFetch(isAdmin.value ? '/account/delete' : '/users/me/delete', { method: 'POST', body: JSON.stringify({ password: password.value }) });
    await signOut();
    location.reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not delete.';
  } finally {
    deleting.value = false;
  }
}

/**
 * Everything in memory belongs to the account that just left, so the cleanest
 * teardown is a fresh boot. Modules are unloaded first so their teardown hooks
 * run while the SDK they were given is still valid.
 */
async function leave(): Promise<void> {
  stopAutoSync();
  stopRealtime();
  await loader.unloadAll();
  await signOut();
  window.location.hash = '#/login';
  window.location.reload();
}

onMounted(async () => {
  myDevice.value = await deviceId();
  await Promise.all([loadTwofa(), loadSessions()]);
});
</script>

<template>
  <section class="security">
    <h2>Account &amp; security</h2>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <article class="card">
      <h3>Two-factor authentication</h3>
      <p class="hint">Protect your login with an authenticator app (Google Authenticator, Authy, 1Password…).</p>
      <template v-if="recovery">
        <p class="ok">2FA enabled. Save these recovery codes — each works once if you lose your device; they won't be shown again.</p>
        <div class="codes"><code v-for="c in recovery" :key="c">{{ c }}</code></div>
        <button type="button" @click="recovery = null">Done</button>
      </template>
      <template v-else-if="setup">
        <p class="hint">Scan with your authenticator app, or enter the key by hand:</p>
        <img v-if="qr" :src="qr" alt="2FA QR code" width="200" height="200" class="qr" />
        <code class="secret">{{ setup.secret }}</code>
        <div class="row">
          <input v-model="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="6-digit code" aria-label="Authenticator code" />
          <button type="button" class="primary" :disabled="busy || code.trim().length < 6" @click="confirmSetup">Verify &amp; enable</button>
          <button type="button" @click="setup = null">Cancel</button>
        </div>
      </template>
      <template v-else-if="twofaEnabled">
        <div class="row"><span class="ok"><Icon name="check" :size="14" /> Enabled</span><button type="button" class="quiet danger" :disabled="busy" @click="disableTwofa">Disable…</button></div>
      </template>
      <button v-else type="button" :disabled="busy || twofaEnabled === null" @click="startSetup">Enable 2FA</button>
    </article>

    <article class="card">
      <div class="head">
        <h3>Your login sessions</h3>
        <button type="button" class="quiet" @click="loadSessions">Refresh</button>
        <button v-if="sessions.length > 1" type="button" class="quiet danger" @click="revokeOthers">Log out all others</button>
      </div>
      <p class="hint">Devices currently signed in as you.<template v-if="!geo"> Location is off — showing device and IP.</template></p>
      <button type="button" class="signout" @click="leave">Sign out on this device</button>
      <p v-if="!sessions.length" class="hint">No active sessions.</p>
      <ul v-else class="sessions">
        <li v-for="s in sessions" :key="s.id">
          <span class="main">
            <span>{{ s.deviceName || s.device || 'Session' }}<em v-if="isMine(s)">this device</em><em v-if="s.flavor && s.flavor !== 'web'">{{ s.flavor }}</em></span>
            <small>{{ [s.device, s.ip, s.geo].filter(Boolean).join(' · ') }} · active {{ ago(s.lastUsedAt) }}</small>
          </span>
          <button v-if="!isMine(s)" type="button" class="quiet danger" @click="revoke(s.id)">Log out</button>
        </li>
      </ul>
    </article>

    <article class="card danger-zone">
      <h3>Danger zone</h3>
      <p class="hint">
        <template v-if="isAdmin">Permanently delete this account and <strong>all</strong> of its data — events, products, sales, images and every user. This cannot be undone.</template>
        <template v-else>Permanently delete your own login. The account's shared data stays for the other members.</template>
      </p>
      <button v-if="!showDanger" type="button" class="danger" @click="showDanger = true">{{ isAdmin ? 'Delete account & all data…' : 'Delete my login…' }}</button>
      <form v-else class="form" @submit.prevent="confirmDelete">
        <p class="hint">Confirm your password and type <code>DELETE</code> to proceed.</p>
        <input v-model="password" type="password" autocomplete="current-password" placeholder="Your password" aria-label="Password" />
        <input v-model="confirmText" type="text" placeholder="Type DELETE" aria-label="Confirmation" />
        <div class="row">
          <button type="submit" class="danger" :disabled="deleting || !password">{{ deleting ? 'Deleting…' : isAdmin ? 'Delete everything' : 'Delete my login' }}</button>
          <button type="button" @click="showDanger = false; password = ''; confirmText = ''">Cancel</button>
        </div>
      </form>
    </article>
  </section>
</template>

<style scoped>
.security { display: flex; flex-direction: column; gap: .8rem; max-width: 40rem; }
h2 { margin: 0; font-size: 1.05rem; }
h3 { margin: 0; font-size: .95rem; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .8rem 1rem; display: flex; flex-direction: column; gap: .6rem; align-items: flex-start; }
.card.danger-zone { border-color: var(--zfy-danger, #c6512f); }
.head { display: flex; align-items: center; gap: .5rem; width: 100%; }
.head h3 { flex: 1; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .85rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); display: inline-flex; align-items: center; gap: .3rem; font-weight: 600; }
.codes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .3rem; width: 100%; max-width: 20rem; }
.codes code, .secret { font-family: ui-monospace, monospace; font-size: .85rem; padding: .3rem .5rem; border-radius: 6px; background: var(--zfy-bg, #f1f4f6); }
.qr { border-radius: 8px; background: #fff; }
.row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.sessions { list-style: none; margin: 0; padding: 0; width: 100%; display: flex; flex-direction: column; gap: .3rem; }
.sessions li { display: flex; align-items: center; gap: .5rem; padding: .4rem .6rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); font-size: .875rem; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.main em { font-style: normal; font-weight: 500; font-size: .66rem; margin-left: .35rem; padding: .05rem .35rem; border-radius: 4px; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); vertical-align: middle; }
.main small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
.form { display: flex; flex-direction: column; gap: .5rem; width: 100%; max-width: 22rem; }
.signout { align-self: flex-start; }
</style>
