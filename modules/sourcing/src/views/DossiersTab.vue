<script setup lang="ts">
import { computed, ref } from 'vue';
import { fmtPrice } from '@zollify/shared';
import { Icon, ModalShell } from '@zollify/ui';
import { printCost, type Dossier, type SourcingFile } from '../engine';
import { deleteFile, fileBytes, remove, save, setApproval, snap, supplierName, uploadFile } from '../api';
import { sdk } from '../runtime';

/**
 * Product dossiers — per product: production specs, last unit price, a
 * home-print recipe, and versioned design files with proofs.
 */
const emit = defineEmits<{ error: [message: string] }>();
const search = ref('');
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  const list = q ? snap.value.dossiers.filter((d) => `${d.title} ${supplierName.value.get(d.supplierId ?? '') ?? ''}`.toLowerCase().includes(q)) : snap.value.dossiers;
  return [...list].sort((a, b) => a.title.localeCompare(b.title));
});
const groups = computed(() => {
  const map = new Map<string, Dossier[]>();
  for (const d of filtered.value) {
    const k = d.supplierId ?? '';
    (map.get(k) ?? map.set(k, []).get(k)!).push(d);
  }
  return [...map.entries()].map(([id, list]) => ({ id, name: id ? (supplierName.value.get(id) ?? 'Unknown supplier') : 'No supplier yet', list })).sort((a, b) => a.name.localeCompare(b.name));
});
const currency = computed(() => sdk().account()?.profile.defaultCurrency ?? 'CHF');
const filesFor = (id: string): SourcingFile[] => snap.value.files.filter((f) => f.dossierId === id).sort((a, b) => a.filename.localeCompare(b.filename) || b.version - a.version);

// ── Link the catalogue ──────────────────────────────────────────────────────
/** Every sellable item that has no dossier yet. */
const unlinked = computed(() => {
  const linked = new Set(snap.value.dossiers.filter((d) => d.pid).map((d) => `${d.pid}:${d.vid ?? ''}`));
  const out: { pid: string; vid: string; title: string }[] = [];
  for (const p of sdk().data.products.list()) {
    if (p.variants.length) for (const v of p.variants) if (!linked.has(`${p.id}:${v.id}`)) out.push({ pid: p.id, vid: v.id, title: `${p.title} · ${v.name}` });
    else if (!linked.has(`${p.id}:`)) out.push({ pid: p.id, vid: '', title: p.title });
  }
  return out;
});
const linking = ref(false);
const linkSupplier = ref('');
const linkPicked = ref<Set<string>>(new Set());
function openLink(): void {
  linkPicked.value = new Set(unlinked.value.map((u) => `${u.pid}:${u.vid}`));
  linkSupplier.value = '';
  linking.value = true;
}
async function runLink(): Promise<void> {
  try {
    for (const u of unlinked.value) {
      if (!linkPicked.value.has(`${u.pid}:${u.vid}`)) continue;
      await save('dossiers', { id: crypto.randomUUID(), pid: u.pid, vid: u.vid || null, title: u.title, supplierId: linkSupplier.value || null, specs: {}, lastUnitPrice: null, currency: currency.value, targetCoverMonths: null, recipe: [] });
    }
    linking.value = false;
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not link those products.');
  }
}

// ── Editor ──────────────────────────────────────────────────────────────────
const editing = ref<Dossier | null>(null);
const price = ref('');
const cover = ref('');
function openNew(): void {
  editing.value = { id: crypto.randomUUID(), pid: null, vid: null, title: '', supplierId: null, specs: {}, lastUnitPrice: null, currency: currency.value, targetCoverMonths: null, recipe: [] };
  price.value = '';
  cover.value = '';
}
function openEdit(d: Dossier): void {
  editing.value = JSON.parse(JSON.stringify(d)) as Dossier;
  price.value = d.lastUnitPrice != null ? String(d.lastUnitPrice) : '';
  cover.value = d.targetCoverMonths != null ? String(d.targetCoverMonths) : '';
}
const recipeCost = computed(() => (editing.value ? printCost(editing.value.recipe, snap.value.materials) : null));
async function saveDossier(): Promise<void> {
  if (!editing.value?.title.trim()) return emit('error', 'A dossier needs a title.');
  try {
    await save('dossiers', {
      ...editing.value,
      title: editing.value.title.trim(),
      lastUnitPrice: price.value.trim() ? parseFloat(price.value) || 0 : null,
      targetCoverMonths: cover.value.trim() ? parseFloat(cover.value) || null : null,
      recipe: editing.value.recipe.filter((r) => r.materialId && r.qty > 0),
    });
    editing.value = null;
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not save the dossier.');
  }
}
async function removeDossier(d: Dossier): Promise<void> {
  if (!(await sdk().ui.confirm(`Remove the dossier for ${d.title} and its files?`, 'Remove dossier?'))) return;
  await remove('dossiers', d.id);
  editing.value = null;
}
/** Writes the recipe's cost onto the catalogue product, like any other cost. */
async function pushPrintCost(): Promise<void> {
  const d = editing.value;
  if (!d?.pid || !recipeCost.value) return;
  const product = sdk().data.products.get(d.pid);
  if (!product) return emit('error', 'That product is no longer in the catalogue.');
  const cost = recipeCost.value.total;
  const next = d.vid ? { ...product, variants: product.variants.map((v) => (v.id === d.vid ? { ...v, cost } : v)) } : { ...product, cost };
  await sdk().data.products.upsert(next);
  price.value = String(cost);
  sdk().ui.toast(`Cost ${fmtPrice(cost, currency.value)} written to ${product.title}.`, { kind: 'success' });
}

// ── Files ───────────────────────────────────────────────────────────────────
async function pick(e: Event, kind: 'design' | 'proof'): Promise<void> {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  if (!editing.value) return;
  for (const f of files) {
    try {
      await uploadFile(editing.value.id, f, kind);
    } catch (err) {
      emit('error', err instanceof Error ? err.message : `Could not upload ${f.name}.`);
    }
  }
}
async function download(f: SourcingFile): Promise<void> {
  const { bytes, mime } = await fileBytes(f.id);
  await sdk().ui.saveFile(f.filename, new Blob([bytes.buffer as ArrayBuffer], { type: mime }), mime);
}
const kb = (n: number): string => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
</script>

<template>
  <div class="tab">
    <div class="tools">
      <input v-model="search" type="search" placeholder="Search products…" aria-label="Search" />
      <span class="spacer"></span>
      <button v-if="unlinked.length" type="button" @click="openLink"><Icon name="layers" :size="14" /> Link catalogue ({{ unlinked.length }})</button>
      <button type="button" class="primary" @click="openNew"><Icon name="plus" :size="14" /> New dossier</button>
    </div>
    <p v-if="!snap.dossiers.length" class="empty">No dossiers yet. Link the catalogue to start one per product, then fill in what the supplier needs to make it.</p>

    <section v-for="g in groups" :key="g.id" class="group">
      <h3>{{ g.name }} <small>{{ g.list.length }}</small></h3>
      <ul>
        <li v-for="d in g.list" :key="d.id">
          <button type="button" class="row" @click="openEdit(d)">
            <span class="main">
              <span class="title">{{ d.title }}<em v-if="!d.pid">not linked</em></span>
              <small>
                <template v-if="d.specs.size">{{ d.specs.size }} · </template><template v-if="d.specs.moq">MOQ {{ d.specs.moq }} · </template>
                {{ filesFor(d.id).length }} file{{ filesFor(d.id).length === 1 ? '' : 's' }}
                <template v-if="d.recipe.length"> · recipe {{ fmtPrice(printCost(d.recipe, snap.materials).total, currency) }}</template>
              </small>
            </span>
            <strong v-if="d.lastUnitPrice != null">{{ fmtPrice(d.lastUnitPrice, d.currency || currency) }}</strong>
          </button>
        </li>
      </ul>
    </section>

    <ModalShell v-if="linking" title="Link the catalogue" @close="linking = false">
      <div class="form">
        <p class="hint">One dossier per sellable item, so reorders and restock maths know which product is which. Already-linked items are skipped.</p>
        <label>
          <span>Supplier for all of them (optional)</span>
          <select v-model="linkSupplier"><option value="">— pick later —</option><option v-for="s in snap.suppliers" :key="s.id" :value="s.id">{{ s.name }}</option></select>
        </label>
        <div class="picks">
          <label v-for="u in unlinked" :key="u.pid + ':' + u.vid" class="inline">
            <input type="checkbox" :checked="linkPicked.has(`${u.pid}:${u.vid}`)" @change="linkPicked.has(`${u.pid}:${u.vid}`) ? linkPicked.delete(`${u.pid}:${u.vid}`) : linkPicked.add(`${u.pid}:${u.vid}`); linkPicked = new Set(linkPicked)" />
            <span>{{ u.title }}</span>
          </label>
        </div>
      </div>
      <template #footer><div class="footer"><button type="button" @click="linking = false">Cancel</button><button type="button" class="primary" :disabled="!linkPicked.size" @click="runLink">Link {{ linkPicked.size }}</button></div></template>
    </ModalShell>

    <ModalShell v-if="editing" :title="editing.title || 'New dossier'" wide @close="editing = null">
      <div class="form">
        <div class="two">
          <label><span>Title</span><input v-model="editing.title" type="text" required /></label>
          <label>
            <span>Supplier</span>
            <select v-model="editing.supplierId"><option :value="null">— none —</option><option v-for="s in snap.suppliers" :key="s.id" :value="s.id">{{ s.name }}</option></select>
          </label>
        </div>
        <label>
          <span>Catalogue product</span>
          <select v-model="editing.pid" @change="editing.vid = null">
            <option :value="null">— not linked —</option>
            <option v-for="p in sdk().data.products.list()" :key="p.id" :value="p.id">{{ p.title }}</option>
          </select>
        </label>
        <label v-if="editing.pid && sdk().data.products.get(editing.pid)?.variants.length">
          <span>Variant</span>
          <select v-model="editing.vid"><option v-for="v in sdk().data.products.get(editing.pid)!.variants" :key="v.id" :value="v.id">{{ v.name }}</option></select>
        </label>

        <fieldset>
          <legend>Production specs</legend>
          <div class="three">
            <label><span>Colours</span><input v-model="editing.specs.colors" type="text" /></label>
            <label><span>Plating / finish</span><input v-model="editing.specs.plating" type="text" /></label>
            <label><span>Size</span><input v-model="editing.specs.size" type="text" placeholder="30 mm" /></label>
            <label><span>Packaging</span><input v-model="editing.specs.packaging" type="text" /></label>
            <label><span>MOQ</span><input v-model="editing.specs.moq" type="text" inputmode="numeric" /></label>
            <label><span>Target cover (months)</span><input v-model="cover" type="number" min="0" step="0.5" placeholder="3" /></label>
          </div>
          <label><span>Notes for the supplier</span><textarea v-model="editing.specs.notes" rows="2"></textarea></label>
          <div class="two">
            <label><span>Last unit price</span><input v-model="price" type="number" min="0" step="0.01" inputmode="decimal" /></label>
            <label><span>Currency</span><input v-model="editing.currency" type="text" maxlength="3" /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Home-print recipe <em v-if="recipeCost && editing.recipe.length">{{ fmtPrice(recipeCost.total, currency) }} per print</em></legend>
          <p class="hint">For prints you make yourself: how much of each material one print uses, valued at what you paid for the materials.</p>
          <div v-for="(r, i) in editing.recipe" :key="i" class="rline">
            <select v-model="r.materialId"><option value="">— material —</option><option v-for="m in snap.materials" :key="m.id" :value="m.id">{{ m.name }} ({{ m.unit }})</option></select>
            <input v-model.number="r.qty" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Qty" aria-label="Quantity" />
            <button type="button" class="quiet" aria-label="Remove" @click="editing.recipe.splice(i, 1)"><Icon name="x" :size="14" /></button>
          </div>
          <div class="rowbtns">
            <button type="button" class="quiet add" @click="editing.recipe.push({ materialId: '', qty: 1 })">+ Add material</button>
            <button v-if="editing.pid && editing.recipe.length" type="button" class="quiet add" @click="pushPrintCost">Write cost to product</button>
          </div>
        </fieldset>

        <fieldset>
          <legend>Design files &amp; proofs</legend>
          <ul class="files">
            <li v-for="f in filesFor(editing.id)" :key="f.id">
              <span class="main"><span>{{ f.filename }} <em>v{{ f.version }}</em><em v-if="f.kind === 'proof'" :class="f.approval ?? ''">proof · {{ f.approval }}</em></span><small>{{ kb(f.size) }} · {{ new Date(f.createdAt).toLocaleDateString() }}</small></span>
              <template v-if="f.kind === 'proof'">
                <button type="button" class="quiet" @click="setApproval(f.id, 'approved')">Approve</button>
                <button type="button" class="quiet" @click="setApproval(f.id, 'rejected')">Reject</button>
              </template>
              <button type="button" class="quiet" @click="download(f)"><Icon name="download" :size="14" /></button>
              <button type="button" class="quiet danger" aria-label="Delete file" @click="deleteFile(f.id)"><Icon name="x" :size="14" /></button>
            </li>
          </ul>
          <div class="rowbtns">
            <label class="btn"><Icon name="upload" :size="14" /> Add design files<input type="file" multiple hidden @change="pick($event, 'design')" /></label>
            <label class="btn"><Icon name="upload" :size="14" /> Add proof<input type="file" hidden @change="pick($event, 'proof')" /></label>
          </div>
          <p class="hint">Re-uploading the same filename keeps a version trail. Files are attached to the reorder's zip.</p>
        </fieldset>
      </div>
      <template #footer>
        <div class="footer">
          <button v-if="snap.dossiers.some((x) => x.id === editing!.id)" type="button" class="danger" @click="removeDossier(editing!)">Remove</button>
          <span class="spacer"></span>
          <button type="button" @click="editing = null">Cancel</button>
          <button type="button" class="primary" @click="saveDossier">Save</button>
        </div>
      </template>
    </ModalShell>
  </div>
</template>

<style scoped>
.tab { display: flex; flex-direction: column; gap: .8rem; }
.tools { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.tools input { min-width: 12rem; }
.spacer { flex: 1; }
.tools button { display: inline-flex; align-items: center; gap: .35rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.group h3 { margin: 0 0 .3rem; font-size: .85rem; }
.group h3 small { color: var(--zfy-muted, #5a6472); font-weight: 400; }
.group ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); overflow: hidden; }
.group li + li { border-top: 1px solid var(--zfy-line, #d6dde4); }
.row { width: 100%; display: flex; align-items: center; gap: .6rem; padding: .5rem .8rem; text-align: left; border: 0; border-radius: 0; background: none; font-weight: 400; }
.row:hover { background: var(--zfy-bg, #f1f4f6); }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.title { font-weight: 600; font-size: .9rem; }
.title em, .files em { font-style: normal; font-weight: 500; font-size: .66rem; margin-left: .35rem; padding: .05rem .35rem; border-radius: 4px; background: var(--zfy-bg, #f1f4f6); color: var(--zfy-muted, #5a6472); vertical-align: middle; }
.files em.approved { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.files em.rejected { background: var(--zfy-signal-soft, #f6e5df); color: var(--zfy-danger, #c6512f); }
.main small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
.form { display: flex; flex-direction: column; gap: .6rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label.inline { flex-direction: row; align-items: center; gap: .4rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.three { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .6rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .5rem; }
legend { font-size: .8rem; font-weight: 600; padding: 0 .3rem; }
legend em { font-style: normal; font-weight: 400; color: var(--zfy-accent-ink, #0a5a4a); margin-left: .4rem; }
.picks { display: grid; grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr)); gap: .25rem; max-height: 40vh; overflow-y: auto; }
.rline { display: grid; grid-template-columns: 1fr 6rem auto; gap: .4rem; }
.rline .quiet { min-height: 1.9rem; padding: 0 .4rem; }
.rowbtns { display: flex; gap: .5rem; flex-wrap: wrap; }
.add { color: var(--zfy-accent-ink, #0a5a4a); font-size: .8rem; min-height: 1.6rem; padding: 0 .3rem; }
.btn { display: inline-flex; flex-direction: row; align-items: center; gap: .35rem; cursor: pointer; min-height: 2.1rem; padding: .25rem .7rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; background: var(--zfy-surface, #fff); font-size: .8rem; font-weight: 500; }
.files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; }
.files li { display: flex; align-items: center; gap: .3rem; padding: .3rem .5rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); font-size: .82rem; }
.files .quiet { min-height: 1.7rem; padding: 0 .4rem; font-size: .75rem; }
.footer { display: flex; align-items: center; gap: .5rem; }
</style>
