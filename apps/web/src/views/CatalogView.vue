<script setup lang="ts">
import { computed, onUnmounted, reactive, ref } from 'vue';
import type { MergeSource, Product, ProductMerge, Variant } from '@zollify/shared';
import { fmtPrice } from '@zollify/shared';
import { CountryPicker, Icon, ModalShell, typeColor } from '@zollify/ui';
import {
  activeEventId,
  allProducts,
  availabilityFor,
  currentAccount,
  deleteProduct,
  freeFor,
  mergeProducts,
  onHandFor,
  saveProductImage,
  setOnHand,
  shellConfirm,
  soldTotal,
  upsertProduct,
} from '@zollify/platform';
import ProductThumb from '../components/ProductThumb.vue';

/**
 * The catalogue — ZollTool's, grouped by type, edited in a sheet.
 *
 * Stock here is what the booth owns; Inventory is where events claim a share
 * of it. Editing a product and counting it are one form because that is how
 * a box gets unpacked: title, price, how many.
 */

const account = currentAccount;
const currency = computed(() => account.value?.profile.defaultCurrency ?? 'CHF');
const canEdit = computed(() => account.value?.role === 'owner' || account.value?.role === 'admin');
const search = ref('');
const error = ref<string | null>(null);

// ── Low stock: what needs restocking at the active event ───────────────────
const lowThreshold = ref('3');
const availability = computed(() => (activeEventId.value ? availabilityFor(activeEventId.value) : []));
function lowRows(p: Product): { variant: string; left: number }[] {
  const thr = Math.max(0, parseInt(lowThreshold.value) || 0);
  return availability.value.filter((a) => a.productId === p.id && a.available <= thr).map((a) => ({ variant: a.variantId ? (p.variants.find((v) => v.id === a.variantId)?.name ?? a.variantId) : '', left: a.available }));
}

// ── SKU generator ──────────────────────────────────────────────────────────
// PN-2604-SB-PIC-02: booth initials, year+month introduced, type initials,
// first three letters of the variant (or title), then the edition — one more
// than any SKU already using that stem.
const initials = (text: string, single = 2): string => {
  const words = text.trim().split(/[\s-]+/).filter(Boolean);
  const raw = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, single);
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
};
const boothCode = computed(() => initials(account.value?.profile.artist.companyName || account.value?.profile.artist.fullName || account.value?.accountName || 'ZF'));
function generateSku(variantName?: string): string {
  const now = new Date();
  const yy = String(form.year && form.year.length === 4 ? form.year.slice(2) : now.getFullYear() % 100).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const type = initials(form.type || 'XX');
  const name = initials(variantName || form.title || 'XXX', 3).slice(0, 3);
  const stem = `${boothCode.value}-${yy}${mm}-${type}-${name}-`;
  const taken = allProducts.value.flatMap((p) => [p.sku, ...p.variants.map((v) => v.sku)]).concat(form.sku, ...form.variants.map((v) => v.sku));
  const edition = taken.reduce((max, sku) => (sku?.startsWith(stem) ? Math.max(max, parseInt(sku.slice(stem.length), 10) || 0) : max), 0) + 1;
  return `${stem}${String(edition).padStart(2, '0')}`;
}

// ── Filter ─────────────────────────────────────────────────────────────────
type Filter = 'all' | 'low' | 'customs' | 'notForSale' | 'unlisted';
const filter = ref<Filter>('all');
const lowOnly = computed(() => filter.value === 'low');

/**
 * What the customs paperwork would trip over: the goods lists leave out any
 * product without a tariff no. or VAT rate, and weigh nothing without a weight.
 * Unlisted products are never declared, so they cannot have issues.
 */
function customsIssues(p: Product): string[] {
  if (p.unlisted) return [];
  const out: string[] = [];
  if (!p.tariffNo?.trim() && p.vatRate == null) out.push('no HS code');
  const weighed = p.variants.length ? p.variants.filter((v) => !v.unlisted).every((v) => (v.weightG ?? p.weightG) != null) : p.weightG != null;
  if (!weighed) out.push('no weight');
  if (!p.originCountry) out.push('no origin');
  return out;
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  let list = allProducts.value;
  if (q) list = list.filter((p) => [p.title, p.sku, p.type, ...p.variants.flatMap((v) => [v.name, v.sku])].filter(Boolean).join(' ').toLowerCase().includes(q));
  if (filter.value === 'low' && activeEventId.value) list = list.filter((p) => lowRows(p).length > 0);
  if (filter.value === 'customs') list = list.filter((p) => customsIssues(p).length > 0);
  if (filter.value === 'notForSale') list = list.filter((p) => !p.forSale);
  if (filter.value === 'unlisted') list = list.filter((p) => p.unlisted);
  return list;
});

/** The low-stock list as a restock CSV. */
function exportRestockCsv(): void {
  const rows = [['Product', 'Variant', 'Type', 'SKU', 'Left']];
  for (const p of filtered.value) for (const r of lowRows(p)) rows.push([p.title, r.variant, p.type ?? '', p.sku ?? '', String(r.left)]);
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `restock_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Merge: fold plain products into one product with a variant each ─────────
// Only variant-less products qualify: each becomes one variant of the merged
// product, and its sales history re-attaches to that variant.
const merging = ref(false);
const mergeSel = ref<Set<string>>(new Set());
const mergePrimary = ref('');
const mergeTitle = ref('');
const mergeNames = ref<Record<string, string>>({});
const mergeCandidates = computed(() => allProducts.value.filter((p) => p.variants.length === 0));
const mergeSelected = computed(() => mergeCandidates.value.filter((p) => mergeSel.value.has(p.id)));
function openMerge(): void {
  mergeSel.value = new Set();
  mergePrimary.value = '';
  mergeTitle.value = '';
  mergeNames.value = {};
  merging.value = true;
}
function toggleMerge(pid: string): void {
  const s = new Set(mergeSel.value);
  if (s.has(pid)) s.delete(pid);
  else s.add(pid);
  mergeSel.value = s;
  const sel = mergeSelected.value;
  if (!mergePrimary.value || !s.has(mergePrimary.value)) mergePrimary.value = sel[0]?.id ?? '';
  const primary = sel.find((p) => p.id === mergePrimary.value);
  if (!mergeTitle.value.trim() && primary) mergeTitle.value = primary.title;
  for (const p of sel) if (!(p.id in mergeNames.value)) mergeNames.value[p.id] = p.title || '(untitled)';
}
async function runMerge(): Promise<void> {
  const sel = mergeSelected.value;
  if (sel.length < 2) return;
  const primary = sel.find((p) => p.id === mergePrimary.value) ?? sel[0]!;
  const title = mergeTitle.value.trim() || primary.title;
  const ok = await shellConfirm(`Fold ${sel.length} products into "${title}", one variant each? Their sales history moves with them. This cannot be undone.`, 'Merge products?');
  if (!ok) return;
  const variants: Variant[] = [];
  const sources: MergeSource[] = [];
  for (const p of sel) {
    const vid = crypto.randomUUID();
    const label = (mergeNames.value[p.id] || p.title || '(untitled)').trim();
    variants.push({ id: vid, name: label, sku: p.sku, price: p.price, cost: p.cost, weightG: p.weightG, imageId: p.imageId });
    sources.push({ fromKey: p.id, toPid: primary.id, toVid: vid, title, variantLabel: label });
  }
  const merged: Product = { ...primary, title, variants, updatedAt: Date.now() };
  const merge: ProductMerge = { id: crypto.randomUUID(), intoId: primary.id, sources, updatedAt: Date.now() };
  try {
    await mergeProducts(merged, merge, sel.filter((p) => p.id !== primary.id).map((p) => p.id));
    merging.value = false;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not merge those products.';
  }
}

// ── Reorder: the global sortOrder drives the till grid ──────────────────────
const reordering = ref(false);
async function move(pid: string, dir: -1 | 1): Promise<void> {
  const list = [...allProducts.value];
  const i = list.findIndex((p) => p.id === pid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const [moved] = list.splice(i, 1);
  list.splice(j, 0, moved!);
  // Renumber; only products whose position changed are written.
  for (let k = 0; k < list.length; k++) if (list[k]!.sortOrder !== k) await upsertProduct({ ...list[k]!, sortOrder: k });
}

/** Always grouped by type, matching the till. */
const groups = computed(() => {
  const map = new Map<string, Product[]>();
  for (const p of filtered.value) {
    const type = p.type?.trim() || 'Other';
    (map.get(type) ?? map.set(type, []).get(type)!).push(p);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([type, products]) => ({ type, products }));
});
const types = computed(() => [...new Set(['Art Print', 'Purse', ...allProducts.value.map((p) => p.type).filter((t): t is string => !!t)])].sort());

const onHandOf = (p: Product): number => (p.variants.length ? p.variants.reduce((s, v) => s + onHandFor(p.id, v.id), 0) : onHandFor(p.id, ''));
const freeOf = (p: Product): number => (p.variants.length ? p.variants.reduce((s, v) => s + freeFor(p.id, v.id), 0) : freeFor(p.id, ''));
const soldOf = (p: Product): number => (p.variants.length ? p.variants.reduce((s, v) => s + soldTotal(p.id, v.id), 0) : soldTotal(p.id, ''));

// Customs wants title + year for art prints and the material for purses.
const isArtwork = (type: string): boolean => /print|art/i.test(type);
const isPurse = (type: string): boolean => /purse|wallet|bag/i.test(type);

// ── Editor ──────────────────────────────────────────────────────────────────
interface VariantForm extends Variant {
  onHand: number;
  newImage?: File;
  previewUrl?: string;
  removeImage?: boolean;
}
const editing = ref(false);
const editId = ref<string | null>(null);
const imageFile = ref<File | null>(null);
const imagePreview = ref<string | null>(null);
const removeImage = ref(false);
const form = reactive({
  title: '',
  sku: '',
  type: '',
  price: '',
  priceNote: '',
  weightG: '',
  tariffNo: '',
  originCountry: '',
  year: '',
  material: '',
  forSale: true,
  unlisted: false,
  onHand: 0,
  variants: [] as VariantForm[],
});
const existing = computed(() => (editId.value ? allProducts.value.find((p) => p.id === editId.value) : undefined));
const hasPhoto = computed(() => Boolean(imagePreview.value || (existing.value?.imageId && !removeImage.value)));

function resetForm(p?: Product): void {
  if (imagePreview.value) URL.revokeObjectURL(imagePreview.value);
  imageFile.value = null;
  imagePreview.value = null;
  removeImage.value = false;
  Object.assign(form, {
    title: p?.title ?? '',
    sku: p?.sku ?? '',
    type: p?.type ?? '',
    price: p ? String(p.price ?? '') : '',
    priceNote: p?.priceNote ?? '',
    weightG: p?.weightG != null ? String(p.weightG) : '',
    tariffNo: p?.tariffNo ?? '',
    originCountry: p?.originCountry ?? '',
    year: p?.year != null ? String(p.year) : '',
    material: p?.material ?? '',
    forSale: p?.forSale ?? true,
    unlisted: p?.unlisted ?? false,
    onHand: p ? onHandFor(p.id, '') : 0,
    variants: (p?.variants ?? []).map((v) => ({ ...v, onHand: onHandFor(p!.id, v.id) })),
  });
}
function openNew(): void {
  editId.value = null;
  resetForm();
  error.value = null;
  editing.value = true;
}
function openEdit(p: Product): void {
  editId.value = p.id;
  resetForm(p);
  error.value = null;
  editing.value = true;
}
onUnmounted(() => resetForm());

function pickImage(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (imagePreview.value) URL.revokeObjectURL(imagePreview.value);
  imageFile.value = file;
  removeImage.value = false;
  imagePreview.value = URL.createObjectURL(file);
}
function dropImage(): void {
  if (imagePreview.value) URL.revokeObjectURL(imagePreview.value);
  imageFile.value = null;
  imagePreview.value = null;
  removeImage.value = true;
}
function addVariant(): void {
  form.variants.push({ id: crypto.randomUUID(), name: '', onHand: 0 });
}
function pickVariantImage(v: VariantForm, e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (v.previewUrl) URL.revokeObjectURL(v.previewUrl);
  v.newImage = file;
  v.previewUrl = URL.createObjectURL(file);
  v.removeImage = false;
}
function dropVariantImage(v: VariantForm): void {
  if (v.previewUrl) URL.revokeObjectURL(v.previewUrl);
  v.newImage = undefined;
  v.previewUrl = undefined;
  v.removeImage = true;
}

const num = (s: string | number | undefined): number | undefined => {
  const n = typeof s === 'number' ? s : parseFloat(String(s ?? ''));
  return Number.isFinite(n) ? n : undefined;
};

async function save(): Promise<void> {
  if (!form.title.trim()) {
    error.value = 'Give the product a title before saving.';
    return;
  }
  error.value = null;
  const prior = existing.value;
  const productId = editId.value ?? crypto.randomUUID();
  try {
    let imageId = removeImage.value ? undefined : prior?.imageId;
    if (imageFile.value) imageId = await saveProductImage(productId, imageFile.value);

    const variants: Variant[] = [];
    for (const { onHand: _o, newImage, previewUrl: _p, removeImage: rm, ...v } of form.variants) {
      variants.push({
        ...v,
        name: v.name.trim(),
        sku: v.sku?.trim() || undefined,
        price: num(v.price),
        imageId: rm ? undefined : newImage ? await saveProductImage(productId, newImage) : v.imageId,
      });
    }
    const product: Product = {
      ...prior,
      id: productId,
      title: form.title.trim(),
      sku: form.sku.trim() || undefined,
      type: form.type.trim() || undefined,
      forSale: form.forSale,
      unlisted: form.unlisted,
      price: num(form.price) ?? 0,
      priceNote: form.priceNote.trim() || undefined,
      weightG: num(form.weightG),
      tariffNo: form.tariffNo.trim() || undefined,
      originCountry: form.originCountry.trim() || undefined,
      year: form.year ? parseInt(form.year, 10) || undefined : undefined,
      material: form.material.trim() || undefined,
      variants,
      imageId,
      sortOrder: prior?.sortOrder ?? allProducts.value.length,
      updatedAt: Date.now(),
    };
    await upsertProduct(product);

    // Stock is written only where it changed, so a plain title edit stays one op.
    if (variants.length) {
      for (const v of form.variants) if (v.onHand !== onHandFor(productId, v.id)) await setOnHand(productId, v.id, v.onHand);
    } else if (form.onHand !== onHandFor(productId, '')) {
      await setOnHand(productId, '', form.onHand);
    }
    editing.value = false;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save that product.';
  }
}

async function remove(product: Product): Promise<void> {
  const ok = await shellConfirm(`Remove "${product.title}" from the catalogue? Past sales of it stay in History.`, 'Remove this product');
  if (!ok) return;
  try {
    await deleteProduct(product.id);
    if (editId.value === product.id) editing.value = false;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not remove that product.';
  }
}
</script>

<template>
  <section class="page catalog">
    <header>
      <h1>Products</h1>
      <div class="tools">
        <input v-model="search" type="search" placeholder="Search products…" aria-label="Search products" />
        <select v-model="filter" aria-label="Show">
          <option value="all">All products</option>
          <option value="low" :disabled="!activeEventId">Low stock at the event</option>
          <option value="customs">Customs issues</option>
          <option value="notForSale">Not for sale</option>
          <option value="unlisted">Unlisted</option>
        </select>
        <button v-if="canEdit" type="button" class="primary" @click="openNew"><Icon name="plus" :size="16" /> New product</button>
      </div>
    </header>

    <p v-if="error && !editing" class="error" role="alert">{{ error }}</p>

    <div class="toolbar">
      <label v-if="lowOnly && activeEventId" class="inline thr">≤ <input v-model="lowThreshold" type="number" min="0" inputmode="numeric" aria-label="Threshold" /> left</label>
      <button v-if="lowOnly && activeEventId" type="button" class="quiet" :disabled="!filtered.length" @click="exportRestockCsv"><Icon name="download" :size="14" /> Restock CSV</button>
      <span class="spacer"></span>
      <button v-if="canEdit && mergeCandidates.length > 1" type="button" class="quiet" @click="openMerge"><Icon name="layers" :size="14" /> Merge</button>
      <button v-if="canEdit && allProducts.length > 1" type="button" class="quiet" @click="reordering = true"><Icon name="list-ordered" :size="14" /> Reorder</button>
    </div>
    <p v-if="!activeEventId" class="hint">No active event — open one under Events to see what is running low there.</p>
    <p v-if="filter === 'customs'" class="hint">These would be left off or mis-weighed on customs documents. Set the tariff no., weight and origin under each product's Customs details.</p>

    <p v-if="!filtered.length" class="empty">{{ search || filter !== 'all' ? 'Nothing matches.' : 'No products yet.' }}</p>

    <section v-for="group in groups" :key="group.type" class="group">
      <h2><span class="swatch" :style="{ background: typeColor(group.type) }"></span><span :style="{ color: typeColor(group.type) }">{{ group.type }}</span><small>{{ group.products.length }}</small></h2>
      <ul>
        <li v-for="p in group.products" :key="p.id">
          <button type="button" class="row" @click="canEdit ? openEdit(p) : undefined">
            <ProductThumb :image-id="p.imageId" :alt="p.title" :size="40" />
            <span class="main">
              <span class="title">{{ p.title || '(untitled)' }} <em v-if="!p.forSale">not for sale</em><em v-if="p.unlisted">unlisted</em><em v-if="filter === 'customs'" class="issue">{{ customsIssues(p).join(' · ') }}</em></span>
              <span class="sub">{{ p.sku }}<template v-if="p.sku && p.variants.length"> · </template><template v-if="p.variants.length">{{ p.variants.length }} variant{{ p.variants.length === 1 ? '' : 's' }}</template></span>
            </span>
            <span class="side">
              <strong>{{ fmtPrice(p.price, currency) }}</strong>
              <span class="sub" :class="{ bad: freeOf(p) < 0 }">{{ onHandOf(p) }} on hand · {{ soldOf(p) }} sold</span>
            </span>
          </button>
        </li>
      </ul>
    </section>

    <ModalShell v-if="merging" title="Merge products" @close="merging = false">
      <div class="form">
        <p class="hint">Combine plain products into one product with a variant each — keychain designs into "Keychain", say. Sales history re-attaches to the variants; nothing is lost.</p>
        <fieldset class="variants">
          <legend>Products to fold together</legend>
          <div class="picks">
            <label v-for="p in mergeCandidates" :key="p.id" class="inline"><input type="checkbox" :checked="mergeSel.has(p.id)" @change="toggleMerge(p.id)" /> <span>{{ p.title || '(untitled)' }}</span><small v-if="p.type" :style="{ color: typeColor(p.type) }">{{ p.type }}</small></label>
          </div>
        </fieldset>
        <template v-if="mergeSelected.length >= 2">
          <div class="two">
            <label>
              <span>Keep as container</span>
              <select v-model="mergePrimary"><option v-for="p in mergeSelected" :key="p.id" :value="p.id">{{ p.title || '(untitled)' }}</option></select>
              <small>Its photo, SKU and type carry over; the others are removed.</small>
            </label>
            <label><span>Merged title</span><input v-model="mergeTitle" type="text" /></label>
          </div>
          <fieldset class="variants">
            <legend>Variant names</legend>
            <div v-for="p in mergeSelected" :key="p.id" class="mrow">
              <span class="main"><span class="title">{{ p.title || '(untitled)' }}</span><small>{{ soldTotal(p.id, '') }} sold</small></span>
              <input v-model="mergeNames[p.id]" type="text" aria-label="Variant name" />
            </div>
          </fieldset>
        </template>
      </div>
      <template #footer>
        <div class="actions"><span class="spacer"></span><button type="button" @click="merging = false">Cancel</button><button type="button" class="primary" :disabled="mergeSelected.length < 2" @click="runMerge">Merge {{ mergeSelected.length || '' }}</button></div>
      </template>
    </ModalShell>

    <ModalShell v-if="reordering" title="Reorder products" @close="reordering = false">
      <p class="hint">This order is used by the till and the catalogue. Changes sync to every device.</p>
      <ul class="reorder">
        <li v-for="(p, i) in allProducts" :key="p.id">
          <ProductThumb :image-id="p.imageId" :alt="p.title" :size="32" />
          <span class="main"><span class="title">{{ p.title || '(untitled)' }}</span><small v-if="p.type" :style="{ color: typeColor(p.type) }">{{ p.type }}</small></span>
          <button type="button" class="quiet" :disabled="i === 0" aria-label="Move up" @click="move(p.id, -1)"><Icon name="arrow-up" :size="14" /></button>
          <button type="button" class="quiet" :disabled="i === allProducts.length - 1" aria-label="Move down" @click="move(p.id, 1)"><Icon name="arrow-down" :size="14" /></button>
        </li>
      </ul>
    </ModalShell>

    <ModalShell v-if="editing" :title="editId ? 'Edit product' : 'New product'" wide @close="editing = false">
      <div class="form">
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div class="photo">
          <div class="frame">
            <img v-if="imagePreview" :src="imagePreview" alt="" />
            <ProductThumb v-else-if="hasPhoto" :image-id="existing?.imageId" :alt="form.title || 'Product'" :size="80" />
            <Icon v-else name="package" :size="28" />
          </div>
          <div class="photo-actions">
            <!-- capture opens the camera directly on a phone; desktops ignore it -->
            <label class="btn"><Icon name="scan" :size="14" /> Take photo<input type="file" accept="image/*" capture="environment" hidden @change="pickImage" /></label>
            <label class="btn"><Icon name="upload" :size="14" /> {{ hasPhoto ? 'Replace photo' : 'Add photo' }}<input type="file" accept="image/*" hidden @change="pickImage" /></label>
            <button v-if="hasPhoto" type="button" class="quiet danger" @click="dropImage">Remove</button>
          </div>
        </div>

        <label><span>Title</span><input v-model="form.title" type="text" required /></label>
        <div class="two">
          <label><span>SKU</span><span class="withbtn"><input v-model="form.sku" type="text" /><button type="button" class="quiet gen" title="Generate a SKU" @click="form.sku = generateSku()"><Icon name="sparkles" :size="14" /></button></span></label>
          <label>
            <span>Type</span>
            <input v-model="form.type" type="text" list="zfy-type-suggestions" placeholder="Art Print" />
            <datalist id="zfy-type-suggestions"><option v-for="t in types" :key="t" :value="t" /></datalist>
          </label>
        </div>
        <div class="three">
          <label><span>Price ({{ currency }})</span><input v-model="form.price" type="number" step="0.05" min="0" inputmode="decimal" /></label>
          <label><span>Weight (g)</span><input v-model="form.weightG" type="number" min="0" inputmode="numeric" /></label>
          <label v-if="!form.variants.length"><span>On hand</span><input v-model.number="form.onHand" type="number" min="0" inputmode="numeric" /></label>
        </div>
        <label><span>Price note</span><input v-model="form.priceNote" type="text" placeholder="Shown on the price sheet, e.g. “signed”" /></label>

        <details class="customs" :open="Boolean(form.tariffNo || form.originCountry || form.year || form.material)">
          <summary>Customs details</summary>
          <p class="hint">Only needed for paperwork when crossing a border with stock.</p>
          <div class="two">
            <label><span>Tariff no. (HS code)</span><input v-model="form.tariffNo" type="text" placeholder="4911.9100" inputmode="decimal" /></label>
            <label><span>{{ isArtwork(form.type) ? 'Artist country' : 'Origin country' }}</span><CountryPicker v-model="form.originCountry" store="code" placeholder="CH" /></label>
          </div>
          <label v-if="isArtwork(form.type)">
            <span>Year produced</span>
            <input v-model="form.year" type="number" inputmode="numeric" placeholder="2024" />
            <small>Listed on customs documents as “{{ form.title || 'Title' }}{{ form.year ? ` (${form.year})` : '' }}”.</small>
          </label>
          <label v-if="isPurse(form.type)">
            <span>Material</span>
            <input v-model="form.material" type="text" placeholder="Genuine leather" />
            <small>Listed on customs documents as “{{ form.title || 'Title' }}{{ form.material ? ` - ${form.material}` : '' }}”.</small>
          </label>
        </details>

        <div class="toggles">
          <label class="inline"><input v-model="form.forSale" type="checkbox" /> <span>For sale</span></label>
          <label class="inline"><input v-model="form.unlisted" type="checkbox" /> <span>Unlisted (left off customs documents)</span></label>
        </div>

        <fieldset class="variants">
          <legend>Variants <button type="button" class="quiet add" @click="addVariant">+ Add variant</button></legend>
          <p v-if="!form.variants.length" class="hint">No variants — the product sells as-is.</p>
          <div v-for="(v, i) in form.variants" :key="v.id" class="variant">
            <label class="vphoto">
              <img v-if="v.previewUrl" :src="v.previewUrl" alt="" />
              <ProductThumb v-else-if="v.imageId && !v.removeImage" :image-id="v.imageId" :alt="v.name || 'Variant'" :size="40" />
              <span v-else class="ph"><Icon name="upload" :size="14" /></span>
              <input type="file" accept="image/*" hidden @change="pickVariantImage(v, $event)" />
              <button v-if="v.previewUrl || (v.imageId && !v.removeImage)" type="button" class="rm" aria-label="Remove photo" @click.prevent.stop="dropVariantImage(v)"><Icon name="x" :size="10" /></button>
            </label>
            <input v-model="v.name" type="text" placeholder="Name (A3)" aria-label="Variant name" />
            <span class="withbtn"><input v-model="v.sku" type="text" placeholder="SKU" aria-label="Variant SKU" /><button type="button" class="quiet gen" title="Generate a SKU" @click="v.sku = generateSku(v.name)"><Icon name="sparkles" :size="14" /></button></span>
            <input v-model="v.price" type="number" step="0.05" min="0" placeholder="Price" aria-label="Variant price" inputmode="decimal" />
            <input v-model.number="v.onHand" type="number" min="0" placeholder="On hand" aria-label="On hand" inputmode="numeric" />
            <button type="button" class="quiet" :aria-label="`Remove variant ${v.name || i + 1}`" @click="form.variants.splice(i, 1)"><Icon name="x" :size="14" /></button>
          </div>
          <p v-if="form.variants.length" class="hint">Leave a variant price blank to use the product price.</p>
        </fieldset>
      </div>
      <template #footer>
        <div class="actions">
          <button v-if="existing" type="button" class="danger" @click="remove(existing)">Remove</button>
          <span class="spacer"></span>
          <button type="button" @click="editing = false">Cancel</button>
          <button type="button" class="primary" @click="save">Save</button>
        </div>
      </template>
    </ModalShell>
  </section>
</template>

<style scoped>
.title em { font-style: normal; font-weight: 500; font-size: .68rem; color: var(--zfy-muted, #5a6472); background: var(--zfy-bg, #f1f4f6); border-radius: 4px; padding: .05rem .35rem; margin-left: .3rem; vertical-align: middle; }
.title em.issue { color: var(--zfy-danger, #c6512f); background: var(--zfy-signal-soft, #f6e5df); }
.toolbar { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.toolbar .spacer { flex: 1; }
.toolbar button { display: inline-flex; align-items: center; gap: .3rem; font-size: .8rem; min-height: 2rem; }
.thr input { width: 3.5rem; min-height: 1.8rem; padding: .1rem .4rem; }
.picks { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: .25rem; max-height: 14rem; overflow-y: auto; }
.picks small { margin-left: .3rem; font-size: .7rem; }
.mrow { display: grid; grid-template-columns: 1fr 12rem; gap: .5rem; align-items: center; }
.mrow .main { display: flex; flex-direction: column; min-width: 0; }
.mrow small { color: var(--zfy-muted, #5a6472); font-size: .72rem; }
.reorder { list-style: none; margin: .6rem 0 0; padding: 0; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; overflow: hidden; }
.reorder li { display: flex; align-items: center; gap: .6rem; padding: .4rem .6rem; }
.reorder li + li { border-top: 1px solid var(--zfy-line, #d6dde4); }
.reorder .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.reorder small { font-size: .7rem; }
.reorder button { min-height: 1.8rem; padding: .1rem .4rem; }
.group { display: flex; flex-direction: column; gap: .4rem; }
.group h2 { margin: 0; display: flex; align-items: center; gap: .5rem; font-size: .9rem; }
.group h2 small { color: var(--zfy-muted, #5a6472); font-weight: 400; }
.swatch { width: .35rem; height: 1rem; border-radius: 999px; }
.group ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); overflow: hidden; }
.group li + li { border-top: 1px solid var(--zfy-line, #d6dde4); }
.row { width: 100%; display: flex; align-items: center; gap: .75rem; padding: .6rem .9rem; text-align: left; border: 0; border-radius: 0; background: none; min-height: 3.5rem; }
.row:hover { background: var(--zfy-bg, #f1f4f6); }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .1rem; }
.title { font-weight: 600; font-size: .92rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { font-size: .76rem; color: var(--zfy-muted, #5a6472); }
.side { display: flex; flex-direction: column; align-items: flex-end; gap: .1rem; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.bad { color: var(--zfy-danger, #c6512f); }

.form { display: flex; flex-direction: column; gap: .75rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label small { color: var(--zfy-muted, #5a6472); font-size: .76rem; }
label.inline { flex-direction: row; align-items: center; gap: .4rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
.three { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: .75rem; }
.photo { display: flex; align-items: center; gap: .8rem; }
.frame { width: 5rem; height: 5rem; border-radius: 12px; background: var(--zfy-bg, #f1f4f6); display: grid; place-items: center; overflow: hidden; color: var(--zfy-muted, #5a6472); flex-shrink: 0; }
.frame img { width: 100%; height: 100%; object-fit: cover; }
.photo-actions { display: flex; flex-direction: column; gap: .35rem; align-items: flex-start; }
.btn { display: inline-flex; flex-direction: row; align-items: center; gap: .35rem; cursor: pointer; min-height: 2.2rem; padding: .3rem .8rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; background: var(--zfy-surface, #fff); font-size: .82rem; font-weight: 500; }
.customs { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .6rem; }
.customs summary { cursor: pointer; font-size: .875rem; font-weight: 600; }
.toggles { display: flex; gap: 1rem; flex-wrap: wrap; }
.variants { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .5rem; background: var(--zfy-bg, #f1f4f6); }
.variants legend { font-size: .85rem; font-weight: 600; padding: 0 .3rem; display: flex; align-items: center; gap: .6rem; }
.add { color: var(--zfy-accent-ink, #0a5a4a); min-height: 1.6rem; padding: 0 .4rem; font-size: .78rem; }
.variant { display: grid; grid-template-columns: 2.5rem 1fr 8rem 5.5rem 5rem auto; gap: .4rem; align-items: center; }
.withbtn { display: flex; align-items: center; gap: .2rem; }
.withbtn input { flex: 1; min-width: 0; }
.gen { min-height: 2rem; padding: .2rem .4rem; color: var(--zfy-muted, #5a6472); }
.vphoto { position: relative; width: 2.5rem; height: 2.5rem; cursor: pointer; }
.vphoto img, .vphoto .ph { width: 2.5rem; height: 2.5rem; border-radius: 8px; object-fit: cover; }
.vphoto .ph { display: grid; place-items: center; background: var(--zfy-surface, #fff); border: 1px dashed var(--zfy-line, #d6dde4); color: var(--zfy-muted, #5a6472); }
.rm { position: absolute; top: -.35rem; right: -.35rem; width: 1.1rem; height: 1.1rem; min-height: 0; padding: 0; border-radius: 999px; display: grid; place-items: center; background: var(--zfy-danger, #c6512f); color: #fff; border: 0; }
.actions { display: flex; gap: .5rem; align-items: center; }
.spacer { flex: 1; }
@media (max-width: 640px) {
  .variant { grid-template-columns: 2.5rem 1fr auto; }
  .variant input:nth-of-type(n + 2) { grid-column: 2 / span 1; }
}
</style>
