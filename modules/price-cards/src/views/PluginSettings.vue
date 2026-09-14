<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Icon } from '@zollify/ui';
import { sdk } from '../runtime';

/**
 * The Photoshop plugin's access — ported from ZollPriceCards. The plugin
 * reads the catalogue as price rows and writes the current price onto the
 * text layers of the booth's PSD templates; the designs stay on the artist's
 * machine. The token is shown once, when minted.
 */
const createdAt = ref<number | null>(null);
const token = ref<string | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const copied = ref(false);

const serviceUrl = computed(() => `${location.origin}/p/price-cards`);

onMounted(async () => {
  try {
    createdAt.value = (await sdk().http.get<{ createdAt: number | null }>('token')).createdAt;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the plugin status.';
  }
});

async function mint(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    token.value = (await sdk().http.post<{ token: string }>('token')).token;
    createdAt.value = Date.now();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not mint a token.';
  } finally {
    busy.value = false;
  }
}
async function revoke(): Promise<void> {
  if (!(await sdk().ui.confirm('The plugin stops working until you mint a new token.', 'Revoke plugin access?'))) return;
  busy.value = true;
  try {
    await sdk().http.del('token');
    token.value = null;
    createdAt.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not revoke the token.';
  } finally {
    busy.value = false;
  }
}
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* clipboard blocked — the value is on screen */
  }
}
</script>

<template>
  <section class="plugin">
    <h2>Photoshop plugin</h2>
    <p class="hint">Keep your price-card designs exactly as they are — the ZollPriceCards Photoshop plugin pulls current prices from here and writes them onto the text layers of your PSD templates. Paste the service URL and a plugin token into the plugin.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <label>
      <span>Service URL</span>
      <div class="row"><code>{{ serviceUrl }}</code><button type="button" class="quiet" @click="copy(serviceUrl)"><Icon name="copy" :size="14" /> Copy</button></div>
    </label>

    <label>
      <span>Plugin token</span>
      <div v-if="token" class="row"><code>{{ token }}</code><button type="button" class="quiet" @click="copy(token)"><Icon name="copy" :size="14" /> {{ copied ? 'Copied' : 'Copy' }}</button></div>
      <small v-if="token" class="warn">Shown once — paste it into the plugin now. Minting again replaces it.</small>
      <small v-else-if="createdAt">A token was minted on {{ new Date(createdAt).toLocaleDateString() }}. Mint a new one if it was lost; the old one stops working.</small>
      <small v-else>No token yet.</small>
    </label>

    <div class="actions">
      <button type="button" class="primary" :disabled="busy" @click="mint">{{ createdAt ? 'Mint a new token' : 'Mint token' }}</button>
      <button v-if="createdAt" type="button" class="danger" :disabled="busy" @click="revoke">Revoke</button>
    </div>
    <p class="hint">The plugin asks <code>prices.json?currency=EUR&amp;exchangeRate=1&amp;rounding=0</code> with the token as a bearer header and gets one row per sellable item, keyed by SKU, with tier ladders for "3 for 25" deals.</p>
  </section>
</template>

<style scoped>
.plugin { display: flex; flex-direction: column; gap: .8rem; max-width: 40rem; }
h2 { margin: 0; font-size: 1.05rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .85rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.warn { color: var(--zfy-warning-ink, #8a5a1e); }
label { display: flex; flex-direction: column; gap: .3rem; font-size: .875rem; }
small { color: var(--zfy-muted, #5a6472); font-size: .78rem; }
.row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
code { font-family: ui-monospace, monospace; font-size: .8rem; padding: .35rem .6rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); overflow-wrap: anywhere; }
.row .quiet { display: inline-flex; align-items: center; gap: .3rem; min-height: 1.9rem; font-size: .8rem; }
.actions { display: flex; gap: .5rem; }
</style>
