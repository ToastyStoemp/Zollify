<script setup lang="ts">
import { ref, shallowRef } from 'vue';
import { BackupParseError, planImport, unpackZip, type ImportPlan } from '../import';
import { sdk } from '../runtime';

// Shallow on purpose: a deep-reactive plan would proxy every row (thousands of sales, image blobs) for nothing.
const plan = shallowRef<ImportPlan | null>(null);
const error = ref<string | null>(null);
const running = ref(false);
const done = ref<{ products: number; events: number; stock: number; inventory: number; transactions: number; discounts: number; images: number } | null>(null);
const progress = ref('');
const fileName = ref('');

/**
 * Parse first, import second, with the plan shown in between.
 *
 * Importing straight from the file picker is how someone discovers they chose
 * the wrong backup after it has already overwritten a live catalogue.
 */
async function choose(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  error.value = null;
  plan.value = null;
  done.value = null;
  fileName.value = file.name;

  try {
    if (/\.zip$/i.test(file.name)) {
      // The zip backup carries the photos beside the JSON. fflate is loaded on
      // demand: the JSON-only path never pays for it.
      const { unzipSync } = await import('fflate');
      const { json, images } = unpackZip(unzipSync(new Uint8Array(await file.arrayBuffer())));
      plan.value = planImport(json, images);
    } else {
      plan.value = planImport(JSON.parse(await file.text()));
    }
  } catch (err) {
    plan.value = null;
    error.value =
      err instanceof BackupParseError
        ? err.message
        : err instanceof SyntaxError
          ? "That file isn't valid JSON."
          : err instanceof Error
            ? err.message
            : 'Could not read that file.';
  }
}

async function run(): Promise<void> {
  if (!plan.value) return;

  const confirmed = await sdk().ui.confirm(
    `Import ${plan.value.products.length} products, ${plan.value.events.length} events and ${plan.value.transactions.length} past sales into this account? ` +
      'Existing products and events with the same id will be overwritten; sales already present are left alone.',
    'Run the import',
  );
  if (!confirmed) return;

  running.value = true;
  error.value = null;
  try {
    // Written through core so every row lands in the sync outbox and reaches
    // the other devices on the account. A server-side import would leave this
    // device's local copy to be re-pulled, and a module-local table would be
    // invisible to sync entirely.
    const data = sdk().data;
    for (const product of plan.value.products) await data.products.upsert(product);
    for (const event of plan.value.events) await data.events.upsert(event);
    for (const rule of plan.value.discounts) await data.discounts.upsert(rule);
    for (const entry of plan.value.eventStock) await data.events.setStock(entry);
    for (const item of plan.value.inventory) {
      await data.inventory.setOnHand(item.productId, item.variantId, item.onHand);
    }
    progress.value = `Restoring ${plan.value.transactions.length} past sales…`;
    const transactions = await data.transactions.restore(plan.value.transactions);
    // Photos last, and one at a time: they are the bulk of the bytes, and a
    // failure here leaves a complete catalogue that merely lacks pictures.
    let images = 0;
    for (const image of plan.value.images) {
      progress.value = `Storing photo ${++images} of ${plan.value.images.length}…`;
      await data.images.put(image);
    }
    progress.value = '';

    done.value = {
      products: plan.value.products.length,
      events: plan.value.events.length,
      stock: plan.value.eventStock.length,
      inventory: plan.value.inventory.length,
      transactions,
      discounts: plan.value.discounts.length,
      images,
    };
    sdk().ui.toast('Import finished. You can switch this module off now.', { kind: 'success' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'The import did not finish.';
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <section class="import">
    <h1>Import from ZollTool</h1>
    <p class="lede">
      Reads one ZollTool backup (version 2) into this account. Use the <strong>.zip</strong> backup
      to bring product photos across; the .json alone has no photo bytes. Business data only — users,
      API keys and integration settings are re-entered by hand.
    </p>

    <label class="picker">
      <span>Choose a backup file</span>
      <input type="file" accept="application/json,.json,application/zip,.zip" @change="choose" />
    </label>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div v-if="plan" class="plan">
      <h2>What this will import</h2>
      <p class="file">{{ fileName }}</p>

      <ul class="counts">
        <li><strong>{{ plan.products.length }}</strong> products</li>
        <li><strong>{{ plan.events.length }}</strong> events</li>
        <li><strong>{{ plan.eventStock.length }}</strong> event claims</li>
        <li><strong>{{ plan.inventory.length }}</strong> opening stock counts</li>
        <li><strong>{{ plan.transactions.length }}</strong> past sales</li>
        <li><strong>{{ plan.discounts.length }}</strong> discount rules</li>
        <li><strong>{{ plan.images.length }}</strong> photos</li>
      </ul>

      <template v-if="plan.skipped.length">
        <h3>Not imported</h3>
        <ul class="skipped">
          <li v-for="item in plan.skipped" :key="item.what">
            <strong>{{ item.what }} ({{ item.count }})</strong>
            <span>{{ item.why }}</span>
          </li>
        </ul>
      </template>

      <ul v-if="plan.warnings.length" class="warnings">
        <li v-for="(warning, i) in plan.warnings" :key="i">{{ warning }}</li>
      </ul>

      <button type="button" class="primary" :disabled="running" @click="run">
        {{ running ? progress || 'Importing…' : 'Run the import' }}
      </button>
    </div>

    <p v-if="done" class="done" role="status">
      Imported {{ done.products }} products, {{ done.events }} events, {{ done.stock }} event claims,
      {{ done.inventory }} opening stock counts, {{ done.transactions }} past sales, {{ done.discounts }} discount rules and {{ done.images }} photos.
      Photos sync to your other devices as thumbnails; the full-size copies stay on this one.
      Switch this module off in Modules — it has done its job.
    </p>
  </section>
</template>

<style scoped>
.import { display: flex; flex-direction: column; gap: 1rem; max-width: 44rem; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: 1.05rem; }
h3 { margin: .5rem 0 0; font-size: .95rem; }
.lede, .file { color: var(--zfy-muted, #5a6472); margin: 0; }
.file { font-size: .85rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.done { color: var(--zfy-accent-ink, #0a5a4a); margin: 0; }
.picker { display: flex; flex-direction: column; gap: .35rem; font-size: .9rem; }
.plan { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .6rem; align-items: flex-start; }
.counts { list-style: none; margin: 0; padding: 0; display: flex; gap: 1.25rem; font-size: .9rem; }
.counts strong { font-variant-numeric: tabular-nums; }
.skipped, .warnings { margin: 0; padding-left: 1.1rem; display: flex; flex-direction: column; gap: .3rem; font-size: .85rem; color: var(--zfy-muted, #5a6472); }
.skipped span { display: block; }
.warnings { color: var(--zfy-warning-ink, #8a5a1e); }
</style>
