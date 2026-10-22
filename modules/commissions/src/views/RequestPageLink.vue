<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { QrCode } from '@zollify/ui';
import { api, errorText, type RequestPage } from '../api';
import { sdk } from '../runtime';

/**
 * The public request page's address, with a QR code for the booth sign or a
 * link in the bio. Replacing it retires the old address (a link that ended
 * up somewhere unwanted, say).
 */
const page = ref<RequestPage | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);

onMounted(async () => {
  try {
    page.value = await api.requestPage();
  } catch (err) {
    error.value = errorText(err, 'Could not load the request page address.');
  }
});
async function copy(): Promise<void> {
  if (!page.value) return;
  try {
    await navigator.clipboard.writeText(page.value.url);
    sdk().ui.toast('Copied.');
  } catch {
    sdk().ui.toast('Could not copy - select the address and copy it by hand.', { kind: 'warning' });
  }
}
async function replace(): Promise<void> {
  if (!(await sdk().ui.confirm('The old address stops working: QR codes and links already out there lead nowhere. Commissions already requested are not touched.', 'New request page address', { confirm: 'Replace' }))) return;
  busy.value = true;
  try {
    page.value = await api.newRequestLink();
  } catch (err) {
    error.value = errorText(err, 'Could not replace the address.');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="reqlink">
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="page">
      <QrCode :value="page.url" :size="120" label="QR code for the request page" />
      <div class="side">
        <code class="url">{{ page.url }}</code>
        <p class="hint">{{ page.open ? 'Taking requests.' : 'Closed - tick "Take requests" and save to open it.' }}</p>
        <div class="actions">
          <button type="button" @click="copy">Copy link</button>
          <a :href="page.url" target="_blank" rel="noopener">Open</a>
          <button type="button" :disabled="busy" @click="replace">New address</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.reqlink { display: flex; gap: .8rem; align-items: flex-start; flex-wrap: wrap; }
.side { display: flex; flex-direction: column; gap: .3rem; min-width: 0; flex: 1; }
.url { font-size: .78rem; overflow-wrap: anywhere; user-select: all; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.actions { display: flex; gap: .4rem; flex-wrap: wrap; align-items: center; }
</style>
