<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Icon, ModalShell } from '@zollify/ui';
import { SHIP_MODES, leadTimeDays, type Rep, type ShipMode, type Supplier } from '../engine';
import { loaded, refresh, remove, save, snap } from '../api';
import { sdk } from '../runtime';

/**
 * Suppliers and their reps - the companies that make the products, each
 * with a sales rep (email, Alibaba chat link, preferred channel) and the
 * shipping modes to ask a quote for. Ported from ZollSource.
 */
const error = ref<string | null>(null);
onMounted(() => {
  if (!loaded.value) refresh().catch((e) => (error.value = e instanceof Error ? e.message : 'Could not load suppliers.'));
});

const editing = ref<Supplier | null>(null);
const editingRep = ref<Rep | null>(null);
const repsFor = (id: string) => snap.value.reps.filter((r) => r.supplierId === id);
const lead = computed(() => new Map(snap.value.suppliers.map((s) => [s.id, leadTimeDays(s.id, snap.value.reorders)])));

function openNew(): void {
  editing.value = { id: crypto.randomUUID(), name: '', alibabaStoreUrl: '', notes: '', shipModes: [] };
}
function toggleMode(m: ShipMode): void {
  if (!editing.value) return;
  const set = new Set(editing.value.shipModes ?? []);
  if (set.has(m)) set.delete(m);
  else set.add(m);
  editing.value.shipModes = [...set];
}
async function saveSupplier(): Promise<void> {
  if (!editing.value?.name.trim()) {
    error.value = 'A supplier needs a name.';
    return;
  }
  error.value = null;
  try {
    await save('suppliers', { ...editing.value, name: editing.value.name.trim() });
    editing.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the supplier.';
  }
}
async function removeSupplier(s: Supplier): Promise<void> {
  const used = snap.value.dossiers.some((d) => d.supplierId === s.id) || snap.value.reorders.some((r) => r.supplierId === s.id);
  if (used) {
    error.value = `${s.name} still has products or reorders - move those first.`;
    return;
  }
  if (!(await sdk().ui.confirm(`Remove ${s.name} and its reps?`, 'Remove supplier?'))) return;
  await remove('suppliers', s.id);
}
function newRep(supplierId: string): void {
  editingRep.value = { id: crypto.randomUUID(), supplierId, name: '', email: '', chatUrl: '', channel: 'email' };
}
async function saveRep(): Promise<void> {
  if (!editingRep.value?.name.trim()) return;
  error.value = null;
  try {
    await save('reps', { ...editingRep.value, name: editingRep.value.name.trim() });
    editingRep.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the rep.';
  }
}
</script>

<template>
  <section class="suppliers">
    <header>
      <div>
        <h2>Suppliers</h2>
        <p class="hint">Who makes what, and who to write to. Reorders are addressed to a supplier's rep.</p>
      </div>
      <button type="button" class="primary" @click="openNew"><Icon name="plus" :size="16" /> New supplier</button>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="loaded && !snap.suppliers.length" class="empty">No suppliers yet.</p>

    <article v-for="s in snap.suppliers" :key="s.id" class="card">
      <div class="head">
        <div class="main">
          <strong>{{ s.name }}</strong>
          <small>
            <template v-if="s.shipModes?.length">{{ s.shipModes.map((m) => SHIP_MODES.find((x) => x.id === m)?.name ?? m).join(' · ') }} · </template>
            <template v-if="lead.get(s.id) != null">~{{ lead.get(s.id) }} days order → received · </template>
            {{ snap.dossiers.filter((d) => d.supplierId === s.id).length }} products
          </small>
        </div>
        <a v-if="s.alibabaStoreUrl" :href="s.alibabaStoreUrl" target="_blank" rel="noopener" class="quiet link"><Icon name="external-link" :size="14" /> Store</a>
        <button type="button" class="quiet" @click="editing = { ...s, shipModes: [...(s.shipModes ?? [])] }">Edit</button>
        <button type="button" class="quiet danger" @click="removeSupplier(s)">Remove</button>
      </div>
      <p v-if="s.notes" class="notes">{{ s.notes }}</p>
      <ul class="reps">
        <li v-for="r in repsFor(s.id)" :key="r.id">
          <span class="main"><span>{{ r.name }}</span><small>{{ r.channel === 'chat' ? 'Alibaba chat' : 'Email' }}<template v-if="r.email"> · {{ r.email }}</template></small></span>
          <a v-if="r.email" :href="`mailto:${r.email}`" class="quiet link">Email</a>
          <a v-if="r.chatUrl" :href="r.chatUrl" target="_blank" rel="noopener" class="quiet link">Chat</a>
          <button type="button" class="quiet" @click="editingRep = { ...r }">Edit</button>
          <button type="button" class="quiet danger" @click="remove('reps', r.id)">Remove</button>
        </li>
      </ul>
      <button type="button" class="quiet add" @click="newRep(s.id)">+ Add rep</button>
    </article>

    <ModalShell v-if="editing" :title="snap.suppliers.some((x) => x.id === editing!.id) ? 'Edit supplier' : 'New supplier'" @close="editing = null">
      <div class="form">
        <label><span>Name</span><input v-model="editing.name" type="text" required /></label>
        <label><span>Alibaba store URL</span><input v-model="editing.alibabaStoreUrl" type="url" placeholder="https://…alibaba.com/" /></label>
        <fieldset>
          <legend>Shipping modes to quote</legend>
          <label v-for="m in SHIP_MODES" :key="m.id" class="inline"><input type="checkbox" :checked="editing.shipModes?.includes(m.id)" @change="toggleMode(m.id)" /> <span>{{ m.name }}</span></label>
        </fieldset>
        <label><span>Notes</span><textarea v-model="editing.notes" rows="3"></textarea></label>
      </div>
      <template #footer><div class="footer"><button type="button" @click="editing = null">Cancel</button><button type="button" class="primary" @click="saveSupplier">Save</button></div></template>
    </ModalShell>

    <ModalShell v-if="editingRep" title="Sales rep" @close="editingRep = null">
      <div class="form">
        <label><span>Name</span><input v-model="editingRep.name" type="text" required /></label>
        <label><span>Email</span><input v-model="editingRep.email" type="email" /></label>
        <label><span>Alibaba chat URL</span><input v-model="editingRep.chatUrl" type="url" /></label>
        <label>
          <span>Preferred channel</span>
          <select v-model="editingRep.channel"><option value="email">Email</option><option value="chat">Alibaba chat</option></select>
        </label>
      </div>
      <template #footer><div class="footer"><button type="button" @click="editingRep = null">Cancel</button><button type="button" class="primary" @click="saveRep">Save</button></div></template>
    </ModalShell>
  </section>
</template>

<style scoped>
.suppliers { display: flex; flex-direction: column; gap: .8rem; max-width: 46rem; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h2 { margin: 0; font-size: 1.05rem; }
header .primary { display: inline-flex; align-items: center; gap: .4rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .85rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .7rem .9rem; display: flex; flex-direction: column; gap: .4rem; }
.head { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.main small { color: var(--zfy-muted, #5a6472); font-size: .76rem; }
.notes { margin: 0; font-size: .82rem; color: var(--zfy-muted, #5a6472); white-space: pre-wrap; }
.reps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .2rem; }
.reps li { display: flex; align-items: center; gap: .3rem; padding: .3rem .5rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); font-size: .85rem; }
.quiet, .link { min-height: 2.2rem; padding: .1rem .5rem; font-size: .78rem; display: inline-flex; align-items: center; gap: .25rem; text-decoration: none; color: var(--zfy-ink, #1a2230); border-radius: 6px; }
.link:hover { background: var(--zfy-surface, #fff); }
.add { align-self: flex-start; color: var(--zfy-accent-ink, #0a5a4a); }
.form { display: flex; flex-direction: column; gap: .6rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label.inline { flex-direction: row; align-items: center; gap: .4rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; padding: .5rem .8rem; display: flex; gap: 1rem; flex-wrap: wrap; }
legend { font-size: .78rem; color: var(--zfy-muted, #5a6472); padding: 0 .3rem; }
.footer { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
