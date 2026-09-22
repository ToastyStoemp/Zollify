<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { sdk } from '../runtime';

interface ConnectionState {
  connected: boolean;
  shop: string | null;
  apiVersion: string | null;
}

const state = ref<ConnectionState>({ connected: false, shop: null, apiVersion: null });
const shop = ref('');
const accessToken = ref('');
const busy = ref(false);
const disconnecting = ref(false);
const error = ref<string | null>(null);

async function refresh(): Promise<void> {
  try {
    state.value = await sdk().http.get<ConnectionState>('connection');
    shop.value = state.value.shop ?? '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not read the connection.';
  }
}

onMounted(refresh);

async function connect(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await sdk().http.post('connection', { shop: shop.value.trim(), accessToken: accessToken.value.trim() });
    // Cleared immediately: the token is stored server-side and there is no
    // reason for it to sit in this page's memory afterwards.
    accessToken.value = '';
    await refresh();
    sdk().ui.toast('Shopify store connected.', { kind: 'success' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not connect that store.';
  } finally {
    busy.value = false;
  }
}

async function disconnect(): Promise<void> {
  const ok = await sdk().ui.confirm(
    'Disconnect the Shopify store? The stored access token is deleted.',
    'Disconnect Shopify',
  );
  if (!ok) return;
  disconnecting.value = true;
  error.value = null;
  try {
    await sdk().http.del('connection');
    await refresh();
    sdk().ui.toast('Shopify store disconnected.', { kind: 'success' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not disconnect.';
  } finally {
    disconnecting.value = false;
  }
}
</script>

<template>
  <section class="connection">
    <h2>Shopify connection</h2>
    <p class="hint">
      The access token is stored encrypted on the server and never sent back to this page. Create a
      custom app in your Shopify admin and paste its Admin API token here.
    </p>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <p v-if="state.connected" class="status">
      Connected to <strong>{{ state.shop }}</strong>
      <span v-if="state.apiVersion"> · API {{ state.apiVersion }}</span>
    </p>

    <form class="form" @submit.prevent="connect">
      <label>
        <span>Shop domain</span>
        <input v-model="shop" type="text" placeholder="your-store.myshopify.com" required />
      </label>
      <label>
        <span>Admin API access token</span>
        <input
          v-model="accessToken"
          type="password"
          autocomplete="off"
          :placeholder="state.connected ? 'Leave blank to keep the current token' : 'shpat_…'"
          :required="!state.connected"
        />
      </label>
      <div class="actions">
        <button v-if="state.connected" type="button" :disabled="disconnecting || busy" @click="disconnect">
          {{ disconnecting ? 'Disconnecting…' : 'Disconnect' }}
        </button>
        <button type="submit" :disabled="busy || disconnecting">
          {{ busy ? 'Saving…' : state.connected ? 'Update' : 'Connect' }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.connection { display: flex; flex-direction: column; gap: .75rem; max-width: 34rem; }
h2 { margin: 0; font-size: 1.05rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .875rem; }
.status { margin: 0; font-size: .9rem; color: var(--zfy-accent-ink, #0a5a4a); }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.form { display: flex; flex-direction: column; gap: .6rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.actions { display: flex; gap: .5rem; justify-content: flex-end; }
</style>
