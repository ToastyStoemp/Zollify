<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Product, Variant } from '@zollify/shared';
import {
  allProducts,
  currentAccount,
  deleteProduct,
  saveProductImage,
  shellConfirm,
  upsertProduct,
} from '@zollify/platform';
import ProductThumb from '../components/ProductThumb.vue';

const account = currentAccount;
const query = ref('');
const editing = ref<Product | null>(null);
const error = ref<string | null>(null);

const canEdit = computed(
  () => account.value?.role === 'owner' || account.value?.role === 'admin',
);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return allProducts.value;
  return allProducts.value.filter(
    (p) => p.title.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q),
  );
});

// No cast: letting the type check this is what caught `sortOrder` missing.
function blank(): Product {
  return {
    id: crypto.randomUUID(),
    title: '',
    forSale: true,
    unlisted: false,
    price: 0,
    variants: [],
    // New products sort to the end of a manually-ordered catalogue.
    sortOrder: allProducts.value.length,
    updatedAt: Date.now(),
  };
}

/**
 * Variants of the product being edited.
 *
 * A variant without its own price inherits the product's — that is how "same
 * print, three sizes, one price" stays a single number to maintain.
 */
const variants = computed<Variant[]>(() => editing.value?.variants ?? []);

function addVariant(): void {
  if (!editing.value) return;
  editing.value.variants = [
    ...variants.value,
    { id: crypto.randomUUID(), name: '' },
  ];
}

function removeVariant(index: number): void {
  if (!editing.value) return;
  const next = [...variants.value];
  next.splice(index, 1);
  editing.value.variants = next;
}

/**
 * Saves the picked image and points the product at it.
 *
 * The blob is stored locally and only a thumbnail syncs, so a catalogue full
 * of photos never competes with sale ops for a convention's connection.
 */
async function chooseImage(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file || !editing.value) return;
  error.value = null;
  try {
    editing.value.imageId = await saveProductImage(editing.value.id, file);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not read that image.';
  }
}

function variantSummary(product: Product): string {
  const count = product.variants?.length ?? 0;
  if (!count) return '';
  return ` · ${count} variant${count === 1 ? '' : 's'}`;
}

function startNew(): void {
  editing.value = blank();
}

async function save(): Promise<void> {
  if (!editing.value) return;
  if (!editing.value.title.trim()) {
    error.value = 'Give the product a title before saving.';
    return;
  }
  error.value = null;
  try {
    await upsertProduct({ ...editing.value, title: editing.value.title.trim() });
    editing.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save that product.';
  }
}

async function remove(product: Product): Promise<void> {
  const ok = await shellConfirm(
    `Remove "${product.title}" from the catalogue? Past sales of it stay in History.`,
    'Remove this product',
  );
  if (!ok) return;
  error.value = null;
  try {
    await deleteProduct(product.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not remove that product.';
  }
}
</script>

<template>
  <section class="catalog">
    <header>
      <h1>Catalog</h1>
      <div class="tools">
        <input v-model="query" type="search" placeholder="Search title or SKU" aria-label="Search catalog" />
        <button v-if="canEdit" type="button" class="primary" @click="startNew">New product</button>
      </div>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <form v-if="editing" class="editor" @submit.prevent="save">
      <h2>{{ editing.title || 'New product' }}</h2>
      <div class="grid">
        <label><span>Title</span><input v-model="editing.title" type="text" required /></label>
        <label><span>SKU</span><input v-model="editing.sku" type="text" /></label>
        <label><span>Price</span><input v-model.number="editing.price" type="number" step="0.01" min="0" inputmode="decimal" /></label>
      </div>

      <details class="customs" :open="Boolean(editing.tariffNo || editing.weightG || editing.originCountry)">
        <summary>Customs details</summary>
        <p class="hint">Only needed for paperwork when crossing a border with stock.</p>
        <div class="grid">
          <label><span>Weight (g)</span><input v-model.number="editing.weightG" type="number" min="0" inputmode="numeric" /></label>
          <label><span>Tariff no.</span><input v-model="editing.tariffNo" type="text" inputmode="numeric" /></label>
          <label><span>Origin country</span><input v-model="editing.originCountry" type="text" maxlength="2" placeholder="CH" /></label>
        </div>
      </details>
      <label class="image">
        <span>Photo</span>
        <div class="image-row">
          <ProductThumb :image-id="editing.imageId" :alt="editing.title || 'Product'" :size="56" />
          <input type="file" accept="image/*" @change="chooseImage" />
        </div>
      </label>

      <fieldset class="variants">
        <legend>Variants</legend>
        <p class="hint">
          Sizes, colours, editions. Leave the price blank to use the product price.
        </p>
        <div v-for="(variant, i) in variants" :key="variant.id" class="variant">
          <input v-model="variant.name" type="text" placeholder="A3" aria-label="Variant name" />
          <input v-model="variant.sku" type="text" placeholder="SKU" aria-label="Variant SKU" />
          <input
            v-model.number="variant.price"
            type="number"
            step="0.01"
            min="0"
            placeholder="Price"
            aria-label="Variant price"
          />
          <button type="button" class="quiet" :aria-label="`Remove variant ${variant.name || i + 1}`" @click="removeVariant(i)">Remove</button>
        </div>
        <button type="button" @click="addVariant">Add variant</button>
      </fieldset>

      <div class="toggles">
        <label class="inline"><input v-model="editing.forSale" type="checkbox" /> <span>For sale</span></label>
        <label class="inline"><input v-model="editing.unlisted" type="checkbox" /> <span>Unlisted</span></label>
      </div>
      <div class="actions">
        <button type="button" @click="editing = null">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>

    <p v-if="!filtered.length" class="empty">
      {{ query ? 'Nothing matches that search.' : 'No products yet.' }}
    </p>

    <div v-else class="table-scroll">
    <table>
      <thead>
        <tr><th>Title</th><th>SKU</th><th class="num">Price</th><th>Status</th><th v-if="canEdit"></th></tr>
      </thead>
      <tbody>
        <tr v-for="product in filtered" :key="product.id">
          <td class="title-cell">
            <ProductThumb :image-id="product.imageId" :alt="product.title" :size="32" />
            <span>{{ product.title }}<span class="variants-note">{{ variantSummary(product) }}</span></span>
          </td>
          <td class="mono">{{ product.sku ?? '—' }}</td>
          <td class="num">{{ product.price.toFixed(2) }}</td>
          <td>{{ product.forSale ? 'For sale' : 'Not for sale' }}{{ product.unlisted ? ' · unlisted' : '' }}</td>
          <td v-if="canEdit" class="row-actions">
            <button type="button" @click="editing = { ...product }">Edit</button>
            <button type="button" class="danger" @click="remove(product)">Remove</button>
          </td>
        </tr>
      </tbody>
    </table>
    </div>
  </section>
</template>

<style scoped>
.catalog { display: flex; flex-direction: column; gap: 1rem; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0 0 .5rem; font-size: 1.05rem; }
.tools { display: flex; gap: .5rem; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.editor { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .75rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .75rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label.inline { flex-direction: row; align-items: center; gap: .4rem; }
.toggles { display: flex; gap: 1rem; }
.customs { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .5rem; }
.customs summary { cursor: pointer; font-size: .875rem; font-weight: 600; }
.variants { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .4rem; align-items: flex-start; }
.variants legend { font-size: .8rem; padding: 0 .3rem; color: var(--zfy-muted, #5a6472); }
.variant { display: grid; grid-template-columns: 1fr 1fr 7rem auto; gap: .4rem; width: 100%; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .8rem; }
.variants-note { color: var(--zfy-muted, #5a6472); font-size: .78rem; }
.image-row { display: flex; align-items: center; gap: .6rem; }
.title-cell { display: flex; align-items: center; gap: .6rem; }
.actions { display: flex; gap: .5rem; justify-content: flex-end; }
table { width: 100%; border-collapse: collapse; background: var(--zfy-surface, #fff); border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: .6rem .75rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); font-size: .9rem; white-space: nowrap; }
tbody tr:last-child td { border-bottom: none; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.mono { font-family: ui-monospace, monospace; font-size: .82rem; }
.row-actions { display: flex; gap: .4rem; justify-content: flex-end; }
</style>
