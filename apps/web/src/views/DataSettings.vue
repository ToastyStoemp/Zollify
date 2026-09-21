<script setup lang="ts">
import { ref } from 'vue';
import {
  RestoreError,
  backupFilename,
  createBackup,
  inspectBackup,
  restoreBackup,
  saveFile,
  shellConfirm,
  syncNow,
  wipeAccountData,
  currentAccount,
  type BackupSummary,
} from '@zollify/platform';

const busy = ref<'export' | 'restore' | 'wipe' | null>(null);

/** Owner only: server-side erase plus a local reset; the page reloads into an empty booth. */
async function wipe(): Promise<void> {
  const ok = await shellConfirm(
    'Erase every product, event, sale and photo in this booth, on the server and on this device? Export a backup first - this cannot be undone.',
    'Erase everything',
  );
  if (!ok) return;
  busy.value = 'wipe';
  error.value = null;
  try {
    await wipeAccountData();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not erase the booth data.';
    busy.value = null;
  }
}
const error = ref<string | null>(null);
const status = ref<string | null>(null);
const pending = ref<{ summary: BackupSummary; raw: unknown; name: string } | null>(null);

/**
 * Writes the backup out as a downloaded file.
 *
 * A file the user keeps is the point - the data lives in this browser's
 * storage, so anything that stays in the browser is lost with it.
 */
async function exportBackup(): Promise<void> {
  busy.value = 'export';
  error.value = null;
  status.value = null;
  try {
    const backup = await createBackup();
    await saveFile(backupFilename(backup), JSON.stringify(backup, null, 2), 'application/json');

    status.value =
      `Exported ${backup.products.length} products (${backup.images?.length ?? 0} photos), ${backup.events.length} events and ` +
      `${backup.transactions.length} sales.`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not create a backup.';
  } finally {
    busy.value = null;
  }
}

async function choose(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  error.value = null;
  status.value = null;
  pending.value = null;

  try {
    const raw = JSON.parse(await file.text()) as unknown;
    pending.value = { summary: inspectBackup(raw), raw, name: file.name };
  } catch (err) {
    error.value =
      err instanceof RestoreError
        ? err.message
        : err instanceof SyntaxError
          ? "That file isn't valid JSON."
          : err instanceof Error
            ? err.message
            : 'Could not read that file.';
  } finally {
    // Allow re-picking the same file after a failure.
    input.value = '';
  }
}

async function confirmRestore(): Promise<void> {
  if (!pending.value) return;
  const { summary, raw } = pending.value;

  const ok = await shellConfirm(
    summary.sameAccount
      ? 'Rows from the backup are merged into this account. Anything newer here is kept.'
      : `This backup came from "${summary.accountName}", not this account. Restore it anyway?`,
    'Restore this backup',
  );
  if (!ok) return;

  busy.value = 'restore';
  error.value = null;
  try {
    const result = await restoreBackup(raw);
    pending.value = null;
    status.value =
      `Restored ${result.products} products (${result.images} photos), ${result.events} events and ` +
      `${result.transactions} sales. Syncing to your other devices…`;
    void syncNow();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'The restore did not finish.';
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <section class="data">
    <h2>Backup &amp; restore</h2>
    <p class="hint">
      Your booth's data lives on this device. Sync copies it to your other devices, but an exported
      file is the only thing that survives losing them all - export before every convention.
    </p>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="status" class="ok" role="status">{{ status }}</p>

    <div class="actions">
      <button type="button" class="primary" :disabled="busy !== null" @click="exportBackup">
        {{ busy === 'export' ? 'Exporting…' : 'Export a backup' }}
      </button>

      <label class="picker">
        <span>Restore from a file</span>
        <input type="file" accept="application/json,.json" :disabled="busy !== null" @change="choose" />
      </label>
    </div>

    <div v-if="pending" class="preview">
      <h3>{{ pending.name }}</h3>
      <p class="meta">
        Exported {{ new Date(pending.summary.exportedAt).toLocaleString() }} from
        <strong>{{ pending.summary.accountName }}</strong>
      </p>
      <p v-if="!pending.summary.sameAccount" class="warn">
        This backup is from a different account. Restoring merges its rows into this one.
      </p>
      <ul class="counts">
        <li><strong>{{ pending.summary.products }}</strong> products</li>
        <li><strong>{{ pending.summary.events }}</strong> events</li>
        <li><strong>{{ pending.summary.inventory }}</strong> stock counts</li>
        <li><strong>{{ pending.summary.eventStock }}</strong> event claims</li>
        <li><strong>{{ pending.summary.transactions }}</strong> sales</li>
        <li><strong>{{ pending.summary.images }}</strong> photos</li>
      </ul>
      <div class="row">
        <button type="button" @click="pending = null">Cancel</button>
        <button type="button" class="primary" :disabled="busy !== null" @click="confirmRestore">
          {{ busy === 'restore' ? 'Restoring…' : 'Restore' }}
        </button>
      </div>
    </div>

    <template v-if="currentAccount?.role === 'owner'">
      <h2 class="danger-h">Start from scratch</h2>
      <p class="hint">
        Erases every product, event, sale and photo in this booth - on the server and on this device.
        Other devices empty themselves at their next sync. Users, invites and the booth profile stay.
      </p>
      <div class="actions">
        <button type="button" class="danger" :disabled="busy !== null" @click="wipe">
          {{ busy === 'wipe' ? 'Erasing…' : 'Erase everything' }}
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.data { display: flex; flex-direction: column; gap: .85rem; max-width: 38rem; }
h2 { margin: 0; font-size: 1.05rem; }
h3 { margin: 0; font-size: .95rem; }
.hint, .meta { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .875rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.ok { color: var(--zfy-accent-ink, #0a5a4a); margin: 0; }
.warn { color: var(--zfy-danger, #c6512f); margin: 0; font-size: .875rem; }
.actions { display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap; }
.picker { display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; }
.preview { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .6rem; }
.counts { list-style: none; margin: 0; padding: 0; display: flex; gap: 1.25rem; flex-wrap: wrap; font-size: .875rem; }
.counts strong { font-variant-numeric: tabular-nums; }
.row { display: flex; gap: .5rem; justify-content: flex-end; }
.danger-h { margin-top: 1rem; color: var(--zfy-danger, #c6512f); }
button.danger { border-color: var(--zfy-danger, #c6512f); color: var(--zfy-danger, #c6512f); }
</style>
