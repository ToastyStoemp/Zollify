<script setup lang="ts">
import { ref } from 'vue';
import { ModalShell } from '@zollify/ui';
import { cleanLocation, type StorageLocation } from '../engine/storage';
import { homeName, locations, removeLocation, rows, saveLocation, setHomeName, swapOrder } from '../state';
import { sdk } from '../runtime';

const error = ref<string | null>(null);

const editing = ref<{ id: string | null; name: string; address: string; note: string } | null>(null);
const formError = ref<string | null>(null);

function startNew(): void {
  editing.value = { id: null, name: '', address: '', note: '' };
  formError.value = null;
}
function startEdit(l: StorageLocation): void {
  editing.value = { id: l.id, name: l.name, address: l.address ?? '', note: l.note ?? '' };
  formError.value = null;
}

async function submit(): Promise<void> {
  const form = editing.value;
  if (!form) return;
  formError.value = null;
  try {
    const clean = cleanLocation(form);
    if (locations.value.some((l) => l.id !== form.id && l.name.toLowerCase() === clean.name.toLowerCase())) {
      throw new Error('There is already a location with that name.');
    }
    await saveLocation({ id: form.id ?? crypto.randomUUID(), ...clean });
    editing.value = null;
  } catch (e) {
    formError.value = e instanceof Error ? e.message : 'Could not save the location.';
  }
}

const holds = (id: string): number => rows.value.reduce((n, r) => n + (r.stored.get(id) ?? 0), 0);

async function remove(l: StorageLocation): Promise<void> {
  error.value = null;
  if (!(await sdk().ui.confirm(`Remove ${l.name}?`, 'Remove location', { confirm: 'Remove' }))) return;
  try {
    await removeLocation(l.id);
  } catch (e) {
    error.value = e instanceof Error ? `${l.name}: ${e.message}` : 'Could not remove the location.';
  }
}

async function moveUp(index: number): Promise<void> {
  const a = locations.value[index];
  const b = locations.value[index - 1];
  if (a && b) await swapOrder(a, b);
}

const homeDraft = ref(homeName.value);
async function saveHome(): Promise<void> {
  if (homeDraft.value.trim() === homeName.value) return;
  await setHomeName(homeDraft.value);
  homeDraft.value = homeName.value;
}
</script>

<template>
  <div class="locations">
    <div class="card home">
      <label>
        <span>Name for the stock you keep with you</span>
        <input v-model="homeDraft" type="text" maxlength="60" placeholder="Home" @change="saveHome" />
      </label>
      <p class="hint">Everything not in a storage location or at one of your stores. Sales at events come out of here.</p>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <ul v-if="locations.length" class="list">
      <li v-for="(l, i) in locations" :key="l.id" class="card">
        <div class="what">
          <strong>{{ l.name }}</strong>
          <span class="meta">{{ holds(l.id) }} unit{{ holds(l.id) === 1 ? '' : 's' }}<template v-if="l.address"> · {{ l.address }}</template></span>
          <span v-if="l.note" class="meta">{{ l.note }}</span>
        </div>
        <div class="actions">
          <button v-if="i > 0" type="button" class="quiet" aria-label="Move up" @click="moveUp(i)">↑</button>
          <button type="button" class="quiet" @click="startEdit(l)">Edit</button>
          <button type="button" class="quiet danger" @click="remove(l)">Remove</button>
        </div>
      </li>
    </ul>
    <p v-else class="empty">No storage locations yet. Add the places you keep stock besides {{ homeName }}.</p>

    <div><button type="button" class="primary" @click="startNew">Add location</button></div>
    <p class="hint">The pick list fetches from {{ homeName }} first, then from the locations in this order.</p>

    <ModalShell v-if="editing" :title="editing.id ? 'Edit location' : 'New location'" @close="editing = null">
      <div class="form">
        <label><span>Name</span><input v-model="editing.name" type="text" maxlength="60" placeholder="Storage unit" /></label>
        <label><span>Address (optional)</span><input v-model="editing.address" type="text" maxlength="200" /></label>
        <label><span>Note (optional)</span><textarea v-model="editing.note" rows="2" maxlength="500" placeholder="Unit 14, code at the gate" /></label>
        <p v-if="formError" class="error" role="alert">{{ formError }}</p>
      </div>
      <template #footer>
        <div class="footer">
          <button type="button" @click="editing = null">Cancel</button>
          <button type="button" class="primary" @click="submit">Save</button>
        </div>
      </template>
    </ModalShell>
  </div>
</template>

<style scoped>
.locations { display: flex; flex-direction: column; gap: .75rem; max-width: 44rem; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .8rem 1rem; }
.home { display: flex; flex-direction: column; gap: .4rem; }
.home label, .form label { display: flex; flex-direction: column; gap: .3rem; font-size: .875rem; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.list li { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; }
.what { display: flex; flex-direction: column; gap: .15rem; min-width: 0; }
.meta { color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.actions { display: flex; gap: .25rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.danger { color: var(--zfy-danger, #c6512f); }
.form { display: flex; flex-direction: column; gap: .75rem; }
.footer { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
