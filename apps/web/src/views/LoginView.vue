<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  applyLogin,
  getApiBase,
  loadCatalog,
  loadDiscounts,
  loadInventory,
  loadSalesEvents,
  loadTransactions,
  startAutoSync,
} from '@boothly/platform';
import { loadEnabledModules } from '../boot';

const router = useRouter();
const route = useRoute();

const email = ref('');
const password = ref('');
const totp = ref('');
const needsTotp = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

async function submit(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const res = await fetch(`${getApiBase()}/auth/login`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: email.value,
        password: password.value,
        totp: totp.value || undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));

    if (res.status === 401 && body?.error === 'totp_required') {
      needsTotp.value = true;
      return;
    }
    if (!res.ok) {
      // Deliberately not distinguishing unknown email from wrong password —
      // the server already equalises the timing, and the message shouldn't
      // give back what that protects.
      error.value = 'That email and password combination was not recognised.';
      return;
    }

    applyLogin(body);
    // Same order as a cold boot: core data first, then modules, which read it
    // through the SDK as they mount.
    await Promise.all([
      loadCatalog(),
      loadSalesEvents(),
      loadTransactions(),
      loadDiscounts(),
      loadInventory(),
    ]);
    await loadEnabledModules(router);
    startAutoSync();
    const next = typeof route.query.next === 'string' ? route.query.next : '/home';
    await router.replace(next);
  } catch {
    error.value = 'Could not reach the server. Check your connection and try again.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login">
    <form @submit.prevent="submit">
      <h1>Boothly<span>.</span></h1>

      <label>
        <span>Email</span>
        <input v-model="email" type="email" autocomplete="username" required />
      </label>

      <label>
        <span>Password</span>
        <input v-model="password" type="password" autocomplete="current-password" required />
      </label>

      <label v-if="needsTotp">
        <span>Authentication code</span>
        <input v-model="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="8" />
      </label>

      <button type="submit" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>
  </div>
</template>

<style scoped>
.login { display: grid; place-items: center; padding: 1rem; }
form { display: flex; flex-direction: column; gap: .75rem; width: 100%; max-width: 21rem; background: var(--bly-surface, #fff); padding: 1.5rem; border-radius: 14px; border: 1px solid var(--bly-line, #d6dde4); }
h1 { margin: 0 0 .5rem; font-size: 1.5rem; letter-spacing: -.02em; }
h1 span { color: var(--bly-accent, #0e7c66); }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.error { color: var(--bly-danger, #c6512f); margin: 0; font-size: .875rem; }
</style>
