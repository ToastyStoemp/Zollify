<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import type { HttpError } from '@zollify/sdk';
import { addTillPerson, getDeviceAccount, refreshTillPeople, setOwnPin, tillPeople, unlockTill, type TillPerson } from '@zollify/platform';
import { Icon } from '@zollify/ui';
import { signOutAndReload } from '../boot';

/**
 * The shared till's lock screen: who is at the till? Tap your name, enter
 * your PIN, and the app is yours - your role, your sales, your cash.
 */

const device = computed(() => getDeviceAccount());
const people = computed(() => tillPeople.value);
const picked = ref<TillPerson | null>(null);
const pin = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

onMounted(() => void refreshTillPeople().catch(() => undefined));

const nameOf = (p: Pick<TillPerson, 'email'>): string => p.email.split('@')[0]!.replace(/[._-]+/g, ' ');
const initials = (p: TillPerson): string =>
  nameOf(p)
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
const roleLabel = (p: TillPerson): string => ({ owner: 'Owner', admin: 'Admin', member: 'Staff' })[p.role];
const lockedText = (p: TillPerson): string | null => (p.lockedUntil && p.lockedUntil > Date.now() ? `Locked until ${new Date(p.lockedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : null);

function pick(p: TillPerson): void {
  if (p.isDevice && !p.hasPin) return void openSetPin();
  picked.value = p;
  pin.value = '';
  error.value = null;
}
function back(): void {
  picked.value = null;
  pin.value = '';
  error.value = null;
}
function press(d: string): void {
  if (busy.value) return;
  error.value = null;
  if (pin.value.length < 8) pin.value += d;
}
function erase(): void {
  pin.value = pin.value.slice(0, -1);
}
async function submit(): Promise<void> {
  if (!picked.value || pin.value.length < 4 || busy.value) return;
  busy.value = true;
  try {
    await unlockTill(picked.value.userId, pin.value);
  } catch (err) {
    const status = (err as HttpError).status;
    error.value = err instanceof Error ? err.message : 'Could not unlock.';
    pin.value = '';
    if (status === 404 || status === 423) {
      await refreshTillPeople().catch(() => undefined);
      if (status === 404) picked.value = null;
    }
  } finally {
    busy.value = false;
  }
}
function onKey(e: KeyboardEvent): void {
  if (!picked.value || adding.value || settingPin.value) return;
  if (/^\d$/.test(e.key)) press(e.key);
  else if (e.key === 'Backspace') erase();
  else if (e.key === 'Enter') void submit();
  else if (e.key === 'Escape') back();
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));

// ── Adding someone ──────────────────────────────────────────────────────────
const adding = ref(false);
const form = reactive({ email: '', password: '', code: '', pin: '', pin2: '', needs2fa: false, needsPin: false });
const formError = ref<string | null>(null);
function openAdd(): void {
  Object.assign(form, { email: '', password: '', code: '', pin: '', pin2: '', needs2fa: false, needsPin: false });
  formError.value = null;
  adding.value = true;
}
async function add(): Promise<void> {
  formError.value = null;
  if (form.pin && form.pin !== form.pin2) return void (formError.value = 'The two PINs differ.');
  busy.value = true;
  try {
    await addTillPerson({ email: form.email.trim(), password: form.password, ...(form.code.trim() ? { code: form.code.trim() } : {}), ...(form.pin ? { pin: form.pin } : {}) });
    adding.value = false;
  } catch (err) {
    const body = ((err as HttpError).body ?? {}) as { needs2fa?: boolean; needsPin?: boolean };
    if (body.needs2fa) form.needs2fa = true;
    if (body.needsPin) form.needsPin = true;
    formError.value = body.needsPin ? 'Choose a PIN for them - they use it to unlock this till.' : err instanceof Error ? err.message : 'Could not add them.';
  } finally {
    busy.value = false;
  }
}

// ── The device's own user setting their PIN ─────────────────────────────────
const settingPin = ref(false);
const own = reactive({ password: '', pin: '', pin2: '' });
function openSetPin(): void {
  Object.assign(own, { password: '', pin: '', pin2: '' });
  formError.value = null;
  settingPin.value = true;
}
async function saveOwnPin(): Promise<void> {
  formError.value = null;
  if (!/^\d{4,8}$/.test(own.pin)) return void (formError.value = 'A PIN is 4 to 8 digits.');
  if (own.pin !== own.pin2) return void (formError.value = 'The two PINs differ.');
  busy.value = true;
  try {
    await setOwnPin(own.password, own.pin);
    settingPin.value = false;
  } catch (err) {
    formError.value = err instanceof Error ? err.message : 'Could not set the PIN.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="lock" role="dialog" aria-modal="true" aria-labelledby="lock-title">
    <div class="panel">
      <header>
        <span class="brand"><img src="/favicon.svg" alt="" class="mark" />{{ device?.accountName }}</span>
        <h1 id="lock-title"><template v-if="picked">Hi <span class="cap">{{ nameOf(picked) }}</span></template><template v-else>Who's at the till?</template></h1>
      </header>

      <!-- Adding someone to this device -->
      <form v-if="adding" class="form" @submit.prevent="add">
        <p class="hint">They sign in once with their own Zollify login; after that their name and PIN unlock this till.</p>
        <p v-if="formError" class="error" role="alert">{{ formError }}</p>
        <label><span>Email</span><input v-model="form.email" type="email" autocomplete="off" required /></label>
        <label><span>Password</span><input v-model="form.password" type="password" autocomplete="off" required /></label>
        <label v-if="form.needs2fa"><span>Authenticator code</span><input v-model="form.code" inputmode="numeric" autocomplete="one-time-code" /></label>
        <div class="two">
          <label><span>{{ form.needsPin ? 'PIN' : 'New PIN (optional)' }}</span><input v-model="form.pin" type="password" inputmode="numeric" pattern="\d{4,8}" maxlength="8" :required="form.needsPin" /></label>
          <label><span>PIN again</span><input v-model="form.pin2" type="password" inputmode="numeric" pattern="\d{4,8}" maxlength="8" :required="!!form.pin" /></label>
        </div>
        <p class="hint">Leave the PIN empty if they already have one.</p>
        <div class="actions">
          <button type="button" @click="adding = false">Cancel</button>
          <button type="submit" class="primary" :disabled="busy">Add to this till</button>
        </div>
      </form>

      <!-- The device's own user without a PIN yet -->
      <form v-else-if="settingPin" class="form" @submit.prevent="saveOwnPin">
        <p class="hint">Choose a PIN to unlock this till as {{ device?.email }}.</p>
        <p v-if="formError" class="error" role="alert">{{ formError }}</p>
        <label><span>Your password</span><input v-model="own.password" type="password" autocomplete="current-password" required /></label>
        <div class="two">
          <label><span>PIN</span><input v-model="own.pin" type="password" inputmode="numeric" maxlength="8" required /></label>
          <label><span>PIN again</span><input v-model="own.pin2" type="password" inputmode="numeric" maxlength="8" required /></label>
        </div>
        <div class="actions">
          <button type="button" @click="settingPin = false">Cancel</button>
          <button type="submit" class="primary" :disabled="busy">Save PIN</button>
        </div>
      </form>

      <!-- PIN pad -->
      <div v-else-if="picked" class="pad">
        <div class="dots" :class="{ shake: !!error }" aria-live="polite" :aria-label="`${pin.length} digits entered`">
          <i v-for="i in Math.max(4, pin.length)" :key="i" :class="{ on: i <= pin.length }" />
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div class="keys">
          <button v-for="d in ['1', '2', '3', '4', '5', '6', '7', '8', '9']" :key="d" type="button" @click="press(d)">{{ d }}</button>
          <button type="button" class="quiet" aria-label="Delete" @click="erase"><Icon name="arrow-left" /></button>
          <button type="button" @click="press('0')">0</button>
          <button type="button" class="primary" aria-label="Unlock" :disabled="pin.length < 4 || busy" @click="submit"><Icon name="check" /></button>
        </div>
        <button type="button" class="quiet link" @click="back">Not <span class="cap">{{ nameOf(picked) }}</span>?</button>
      </div>

      <!-- People -->
      <template v-else>
        <div class="people">
          <button v-for="p in people" :key="p.userId" type="button" class="person" :disabled="!!lockedText(p)" @click="pick(p)">
            <span class="avatar">{{ initials(p) }}</span>
            <strong>{{ nameOf(p) }}</strong>
            <small>{{ lockedText(p) ?? (p.isDevice && !p.hasPin ? 'Set a PIN' : roleLabel(p)) }}</small>
          </button>
          <button type="button" class="person add" @click="openAdd">
            <span class="avatar"><Icon name="plus" /></span>
            <strong>Add someone</strong>
            <small>with their login</small>
          </button>
        </div>
        <button type="button" class="quiet link" @click="signOutAndReload()">Sign this device out</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lock { position: fixed; inset: 0; z-index: 900; display: grid; place-items: center; padding: max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom)); background: var(--zfy-bg, #f1f4f6); overflow-y: auto; }
.panel { width: min(100%, 34rem); display: flex; flex-direction: column; align-items: center; gap: 1.2rem; }
header { display: flex; flex-direction: column; align-items: center; gap: .4rem; text-align: center; }
.brand { display: inline-flex; align-items: center; gap: .45rem; font-size: .85rem; color: var(--zfy-muted, #5a6472); font-weight: 600; }
.mark { width: 1.4rem; height: 1.4rem; }
h1 { margin: 0; font-size: 1.5rem; }
.cap { text-transform: capitalize; }
.people { display: grid; grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr)); gap: .7rem; width: 100%; }
.person { display: flex; flex-direction: column; align-items: center; gap: .3rem; padding: 1rem .6rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 14px; background: var(--zfy-surface, #fff); min-height: 8.5rem; }
.person:disabled { opacity: .55; }
.person strong { text-transform: capitalize; font-size: .95rem; overflow-wrap: anywhere; text-align: center; }
.person small { color: var(--zfy-muted, #5a6472); font-size: .75rem; }
.person.add { border-style: dashed; background: none; }
.avatar { display: grid; place-items: center; width: 3.2rem; height: 3.2rem; border-radius: 50%; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); font-weight: 700; font-size: 1.1rem; }
.pad { display: flex; flex-direction: column; align-items: center; gap: 1rem; }
.dots { display: flex; gap: .7rem; min-height: 1rem; }
.dots i { width: .9rem; height: .9rem; border-radius: 50%; border: 2px solid var(--zfy-ink, #1a2230); }
.dots i.on { background: var(--zfy-ink, #1a2230); }
.dots.shake { animation: shake .3s; }
@keyframes shake { 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
.keys { display: grid; grid-template-columns: repeat(3, 4.4rem); gap: .7rem; }
.keys button { height: 4.4rem; border-radius: 50%; font-size: 1.4rem; font-weight: 600; display: grid; place-items: center; }
.link { border: 0; background: none; color: var(--zfy-accent-ink, #0a5a4a); font-weight: 600; font-size: .85rem; min-height: 2.2rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); text-align: center; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.form { width: 100%; display: flex; flex-direction: column; gap: .7rem; padding: 1rem; border-radius: 14px; background: var(--zfy-surface, #fff); border: 1px solid var(--zfy-line, #d6dde4); }
.form label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.actions { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
