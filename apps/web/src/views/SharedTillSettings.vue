<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { roleAtLeast } from '@zollify/sdk';
import {
  currentAccount,
  getDeviceAccount,
  lockTill,
  refreshTillPeople,
  removeTillPerson,
  saveTillSettings,
  setOwnPin,
  shellConfirm,
  tillPeople,
  tillSettings,
} from '@zollify/platform';
import BadgeDialog from './BadgeDialog.vue';

/**
 * Settings → This device → Shared till. Several people take turns at this
 * device, each unlocking it with their own PIN, so the till knows who sells
 * and everyone keeps their own role and cash.
 */

const me = currentAccount;
/** The device's own user or an admin decides whether this till locks; staff cannot switch it off. */
const canManage = computed(() => {
  const acct = me.value;
  return !!acct && (acct.userId === getDeviceAccount()?.userId || roleAtLeast(acct.role, 'admin'));
});
const myPin = computed(() => tillPeople.value.find((p) => p.userId === me.value?.userId)?.hasPin ?? null);
const others = computed(() => tillPeople.value.filter((p) => !p.isDevice));
const error = ref<string | null>(null);
const ok = ref<string | null>(null);

onMounted(() => void refreshTillPeople().catch(() => undefined));

function update(patch: Partial<typeof tillSettings.value>): void {
  if (patch.enabled && tillPeople.value.find((p) => p.isDevice)?.hasPin === false && me.value?.userId === getDeviceAccount()?.userId) {
    error.value = 'Set your own PIN first - otherwise nobody could unlock this till as you.';
    return;
  }
  error.value = null;
  saveTillSettings({ ...tillSettings.value, ...patch });
}

const pinForm = reactive({ open: false, password: '', pin: '', pin2: '' });
async function savePin(): Promise<void> {
  error.value = null;
  ok.value = null;
  if (!/^\d{4,8}$/.test(pinForm.pin)) return void (error.value = 'A PIN is 4 to 8 digits.');
  if (pinForm.pin !== pinForm.pin2) return void (error.value = 'The two PINs differ.');
  try {
    await setOwnPin(pinForm.password, pinForm.pin);
    Object.assign(pinForm, { open: false, password: '', pin: '', pin2: '' });
    ok.value = 'PIN saved. It works on every till you are added to.';
    await refreshTillPeople().catch(() => undefined);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the PIN.';
  }
}

async function remove(userId: string, email: string): Promise<void> {
  if (!(await shellConfirm(`${email} can no longer unlock this till. They can be added again with their password.`, 'Remove from this till?'))) return;
  await removeTillPerson(userId).catch((err) => (error.value = err instanceof Error ? err.message : 'Could not remove them.'));
}
const IDLE = [0, 1, 2, 5, 10, 30];
const badgeOpen = ref(false);
</script>

<template>
  <h3>Shared till</h3>
  <p class="hint">Several people take turns at this device: each unlocks it with their own PIN, sells under their own name and counts their own cash. Staff stay staff, whoever signed the device in.</p>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <p v-if="ok" class="ok">{{ ok }}</p>

  <div class="toggles">
    <label>
      <input type="checkbox" :checked="tillSettings.enabled" :disabled="!canManage" @change="update({ enabled: ($event.target as HTMLInputElement).checked })" />
      <span class="body"><span class="label">Lock with a PIN</span><span class="sub">The till opens locked; tap your name and enter your PIN. Unlocking works offline for anyone who unlocked online once.</span></span>
    </label>
    <template v-if="tillSettings.enabled">
      <label class="select">
        <span class="body"><span class="label">Lock when idle</span><span class="sub">Nobody touched the screen for this long.</span></span>
        <select :value="tillSettings.idleMinutes" :disabled="!canManage" @change="update({ idleMinutes: Number(($event.target as HTMLSelectElement).value) })">
          <option v-for="m in IDLE" :key="m" :value="m">{{ m ? `${m} min` : 'Never' }}</option>
        </select>
      </label>
      <label>
        <input type="checkbox" :checked="tillSettings.badgeNeedsPin" :disabled="!canManage" @change="update({ badgeNeedsPin: ($event.target as HTMLInputElement).checked })" />
        <span class="body"><span class="label">Ask for the PIN after a badge</span><span class="sub">Off, scanning a staff badge unlocks at once. On, a lost or copied card is not enough on its own.</span></span>
      </label>
      <label>
        <input type="checkbox" :checked="tillSettings.lockAfterSale" :disabled="!canManage" @change="update({ lockAfterSale: ($event.target as HTMLInputElement).checked })" />
        <span class="body"><span class="label">Lock after each sale</span><span class="sub">A few seconds after a sale is paid - for a till that changes hands all the time.</span></span>
      </label>
    </template>
  </div>

  <div class="people">
    <div class="line">
      <span>Your PIN</span>
      <strong>{{ myPin === null ? '' : myPin ? 'Set' : 'Not set' }}</strong>
      <button type="button" class="btn" @click="pinForm.open = !pinForm.open">{{ myPin ? 'Change' : 'Set PIN' }}</button>
    </div>
    <div class="line">
      <span>Your badge</span>
      <button type="button" class="btn" @click="badgeOpen = true">Show or print</button>
    </div>
    <BadgeDialog v-if="badgeOpen && me" :user-id="me.userId" :email="me.email" @close="badgeOpen = false" />
    <form v-if="pinForm.open" class="form" @submit.prevent="savePin">
      <label><span>Your password</span><input v-model="pinForm.password" type="password" autocomplete="current-password" required /></label>
      <label><span>New PIN (4 to 8 digits)</span><input v-model="pinForm.pin" type="password" inputmode="numeric" maxlength="8" required /></label>
      <label><span>PIN again</span><input v-model="pinForm.pin2" type="password" inputmode="numeric" maxlength="8" required /></label>
      <button type="submit" class="btn">Save PIN</button>
    </form>

    <template v-if="tillSettings.enabled">
      <div v-for="p in others" :key="p.userId" class="line">
        <span>{{ p.email }}</span>
        <small>{{ { owner: 'Owner', admin: 'Admin', member: 'Staff' }[p.role] }}</small>
        <button v-if="canManage" type="button" class="btn" @click="remove(p.userId, p.email)">Remove</button>
      </div>
      <p class="hint">Add people from the lock screen: <button type="button" class="inline" @click="lockTill()">lock the till</button>, then "Add someone" - they sign in once with their own login. After that their staff badge works here too; admins print badges under Settings → Team.</p>
    </template>
  </div>
</template>

<style scoped>
h3 { margin: .75rem 0 0; font-size: .95rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .8rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.ok { color: var(--zfy-accent-ink, #0a5a4a); margin: 0; font-size: .875rem; }
.toggles { display: flex; flex-direction: column; gap: .5rem; width: 100%; }
.toggles label { display: flex; align-items: flex-start; gap: .6rem; padding: .6rem .75rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; background: var(--zfy-surface, #fff); cursor: pointer; }
.toggles label.select { align-items: center; justify-content: space-between; }
.toggles input { margin-top: .2rem; }
.toggles .body { display: flex; flex-direction: column; }
.toggles .label { font-size: .875rem; font-weight: 600; }
.toggles .sub { font-size: .75rem; color: var(--zfy-muted, #5a6472); }
.people { display: flex; flex-direction: column; gap: .4rem; width: 100%; }
.line { display: flex; align-items: center; gap: .6rem; padding: .4rem .6rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); font-size: .875rem; }
.line > span { flex: 1; overflow-wrap: anywhere; }
.line small { color: var(--zfy-muted, #5a6472); }
.form { display: flex; flex-direction: column; gap: .5rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); }
.form label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.btn { display: inline-flex; align-items: center; min-height: 2.2rem; padding: .3rem .8rem; border-radius: 8px; border: 1px solid var(--zfy-line, #d6dde4); background: var(--zfy-surface, #fff); color: inherit; font-size: .82rem; align-self: flex-start; }
.inline { border: 0; padding: 0; min-height: 0; background: none; color: var(--zfy-accent-ink, #0a5a4a); font-weight: 600; font-size: inherit; }
</style>
