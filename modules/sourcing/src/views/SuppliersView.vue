<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { suppliersApi, type Supplier } from '../api';
import { sdk } from '../runtime';

const suppliers = ref<Supplier[]>([]);
const editing = ref<Omit<Supplier, 'updatedAt'> | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);

async function refresh(): Promise<void> {
  try {
    suppliers.value = (await suppliersApi.list()).suppliers;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load suppliers.';
  }
}

onMounted(refresh);

function startNew(): void {
  editing.value = { id: crypto.randomUUID(), name: '', contactEmail: null, notes: null };
}

async function save(): Promise<void> {
  if (!editing.value) return;
  if (!editing.value.name.trim()) {
    error.value = 'Give the supplier a name before saving.';
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    await suppliersApi.save({ ...editing.value, name: editing.value.name.trim() });
    editing.value = null;
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save that supplier.';
  } finally {
    busy.value = false;
  }
}

async function remove(supplier: Supplier): Promise<void> {
  // Suppliers are referenced by drafts, so removing one is worth confirming.
  const ok = await sdk().ui.confirm(
    'Remove ' + supplier.name + '? Existing drafts will keep their reference.',
    'Remove supplier',
  );
  if (!ok) return;
  try {
    await suppliersApi.remove(supplier.id);
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not remove that supplier.';
  }
}
</script>

<template>
  <section class="suppliers">
    <header>
      <h2>Suppliers</h2>
      <button type="button" @click="startNew">New supplier</button>
    </header>

    <p class="hint">
      Contacts are kept on the server, never in the browser — they travel with the account rather
      than the device.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <form v-if="editing" class="editor" @submit.prevent="save">
      <label><span>Name</span><input v-model="editing.name" type="text" required /></label>
      <label>
        <span>Contact email</span>
        <input v-model="editing.contactEmail" type="email" autocomplete="email" />
      </label>
      <label><span>Notes</span><textarea v-model="editing.notes" rows="2"></textarea></label>
      <div class="actions">
        <button type="button" @click="editing = null">Cancel</button>
        <button type="submit" :disabled="busy">{{ busy ? 'Saving…' : 'Save' }}</button>
      </div>
    </form>

    <p v-if="!suppliers.length" class="empty">No suppliers yet.</p>

    <ul v-else class="list">
      <li v-for="supplier in suppliers" :key="supplier.id">
        <div class="meta">
          <strong>{{ supplier.name }}</strong>
          <span>{{ supplier.contactEmail ?? 'No contact email' }}</span>
        </div>
        <div class="row-actions">
          <button type="button" @click="editing = { ...supplier }">Edit</button>
          <button type="button" @click="remove(supplier)">Remove</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.suppliers { display: flex; flex-direction: column; gap: .75rem; max-width: 38rem; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
h2 { margin: 0; font-size: 1.05rem; }
.hint, .empty { color: var(--bly-muted, #5a6472); margin: 0; font-size: .875rem; }
.error { color: var(--bly-danger, #c6512f); margin: 0; }
.editor { display: flex; flex-direction: column; gap: .6rem; border: 1px solid var(--bly-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--bly-surface, #fff); }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.actions { display: flex; gap: .5rem; justify-content: flex-end; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.list li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--bly-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; background: var(--bly-surface, #fff); }
.meta { display: flex; flex-direction: column; gap: .1rem; font-size: .9rem; }
.meta span { color: var(--bly-muted, #5a6472); font-size: .8rem; }
.row-actions { display: flex; gap: .4rem; }
</style>
