<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon, ModalShell } from '@zollify/ui';
import type { Issue } from '../engine';
import { remove, save, snap, supplierName } from '../api';

/**
 * Issue log — production problems per supplier and product. Open issues
 * flagged "remind" are written into the next reorder's spec so the supplier
 * is told not to repeat them.
 */
const emit = defineEmits<{ error: [message: string] }>();
const showResolved = ref(false);
const list = computed(() => [...snap.value.issues].filter((i) => showResolved.value || i.status === 'open').sort((a, b) => b.createdAt - a.createdAt));
const editing = ref<Issue | null>(null);
function openNew(): void {
  editing.value = { id: crypto.randomUUID(), supplierId: snap.value.suppliers[0]?.id ?? '', dossierId: null, reorderId: null, title: '', detail: '', severity: 'medium', status: 'open', remindOnReorder: true, createdAt: Date.now(), resolvedAt: null };
}
async function saveIssue(): Promise<void> {
  if (!editing.value?.title.trim() || !editing.value.supplierId) return emit('error', 'An issue needs a supplier and a title.');
  try {
    await save('issues', { ...editing.value, title: editing.value.title.trim() });
    editing.value = null;
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not save the issue.');
  }
}
const toggleResolved = (i: Issue) => save('issues', { ...i, status: i.status === 'resolved' ? 'open' : 'resolved', resolvedAt: i.status === 'resolved' ? null : Date.now() });
const dossierTitle = (id: string | null) => (id ? (snap.value.dossiers.find((d) => d.id === id)?.title ?? 'item') : '');
</script>

<template>
  <div class="tab">
    <div class="tools">
      <label class="inline"><input v-model="showResolved" type="checkbox" /> <span>Show resolved</span></label>
      <span class="spacer"></span>
      <button type="button" class="primary" :disabled="!snap.suppliers.length" @click="openNew"><Icon name="plus" :size="14" /> Log issue</button>
    </div>
    <p v-if="!list.length" class="empty">No issues logged. Note a problem after a run and the next spec to that supplier reminds them.</p>
    <ul v-else class="issues">
      <li v-for="i in list" :key="i.id" :class="[i.severity, { resolved: i.status === 'resolved' }]">
        <span class="main">
          <span class="title">{{ i.title }}<em>{{ i.severity }}</em><em v-if="i.remindOnReorder && i.status === 'open'">reminds</em></span>
          <small>{{ supplierName.get(i.supplierId) ?? 'Unknown supplier' }}<template v-if="i.dossierId"> · {{ dossierTitle(i.dossierId) }}</template> · {{ new Date(i.createdAt).toLocaleDateString() }}</small>
          <p v-if="i.detail">{{ i.detail }}</p>
        </span>
        <button type="button" class="quiet" @click="toggleResolved(i)">{{ i.status === 'resolved' ? 'Reopen' : 'Resolve' }}</button>
        <button type="button" class="quiet" @click="editing = { ...i }">Edit</button>
        <button type="button" class="quiet danger" @click="remove('issues', i.id)">Delete</button>
      </li>
    </ul>

    <ModalShell v-if="editing" title="Production issue" @close="editing = null">
      <div class="form">
        <div class="two">
          <label>
            <span>Supplier</span>
            <select v-model="editing.supplierId"><option v-for="s in snap.suppliers" :key="s.id" :value="s.id">{{ s.name }}</option></select>
          </label>
          <label>
            <span>Product (optional)</span>
            <select v-model="editing.dossierId"><option :value="null">— whole supplier —</option><option v-for="d in snap.dossiers.filter((x) => x.supplierId === editing!.supplierId)" :key="d.id" :value="d.id">{{ d.title }}</option></select>
          </label>
        </div>
        <label><span>What went wrong</span><input v-model="editing.title" type="text" placeholder="Plating flaked on the gold pins" /></label>
        <label><span>Detail</span><textarea v-model="editing.detail" rows="3"></textarea></label>
        <div class="two">
          <label>
            <span>Severity</span>
            <select v-model="editing.severity"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select>
          </label>
          <label class="inline"><input v-model="editing.remindOnReorder" type="checkbox" /> <span>Remind in the next reorder spec</span></label>
        </div>
      </div>
      <template #footer><div class="footer"><span class="spacer"></span><button type="button" @click="editing = null">Cancel</button><button type="button" class="primary" @click="saveIssue">Save</button></div></template>
    </ModalShell>
  </div>
</template>

<style scoped>
.tab { display: flex; flex-direction: column; gap: .8rem; }
.tools { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.tools .primary { display: inline-flex; align-items: center; gap: .35rem; }
label.inline { display: flex; flex-direction: row; align-items: center; gap: .4rem; font-size: .85rem; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.issues { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.issues li { display: flex; align-items: flex-start; gap: .3rem; padding: .6rem .8rem; border: 1px solid var(--zfy-line, #d6dde4); border-left-width: 3px; border-radius: 10px; background: var(--zfy-surface, #fff); }
.issues li.high { border-left-color: var(--zfy-danger, #c6512f); }
.issues li.medium { border-left-color: var(--zfy-warning, #c08a2e); }
.issues li.low { border-left-color: var(--zfy-line, #d6dde4); }
.issues li.resolved { opacity: .55; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .1rem; }
.title { font-weight: 600; font-size: .9rem; }
.title em { font-style: normal; font-weight: 500; font-size: .66rem; margin-left: .35rem; padding: .05rem .35rem; border-radius: 4px; background: var(--zfy-bg, #f1f4f6); color: var(--zfy-muted, #5a6472); vertical-align: middle; }
.main small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
.main p { margin: .2rem 0 0; font-size: .82rem; white-space: pre-wrap; }
.issues .quiet { min-height: 1.8rem; padding: .1rem .5rem; font-size: .78rem; }
.form { display: flex; flex-direction: column; gap: .6rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; align-items: end; }
.footer { display: flex; align-items: center; gap: .5rem; }
</style>
