<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { draftsApi, suppliersApi, type ReorderDraft, type Supplier } from '../api';
import { sdk } from '../runtime';

const suppliers = ref<Supplier[]>([]);
const drafts = ref<ReorderDraft[]>([]);
const qty = ref<Record<string, number>>({});
const supplierId = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

const products = computed(() => sdk().data.products.list());

const chosen = computed(() =>
  products.value
    .filter((p) => (qty.value[p.id] ?? 0) > 0)
    .map((p) => ({ productId: p.id, title: p.title, qty: qty.value[p.id] ?? 0 })),
);

async function refresh(): Promise<void> {
  try {
    const [s, d] = await Promise.all([suppliersApi.list(), draftsApi.list()]);
    suppliers.value = s.suppliers;
    drafts.value = d.drafts;
    if (!supplierId.value) supplierId.value = s.suppliers[0]?.id ?? '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load sourcing data.';
  }
}

onMounted(refresh);

function setQty(productId: string, value: number): void {
  qty.value = { ...qty.value, [productId]: Math.max(0, value) };
}

async function createDraft(): Promise<void> {
  if (!supplierId.value || !chosen.value.length) return;
  busy.value = true;
  error.value = null;
  try {
    await draftsApi.create(supplierId.value, chosen.value);
    qty.value = {};
    await refresh();
    sdk().ui.toast('Reorder draft created.', { kind: 'success' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not create that draft.';
  } finally {
    busy.value = false;
  }
}

async function markSent(id: string): Promise<void> {
  try {
    await draftsApi.markSent(id);
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not update that draft.';
  }
}

function supplierName(id: string): string {
  return suppliers.value.find((s) => s.id === id)?.name ?? 'Unknown supplier';
}
</script>

<template>
  <section class="sourcing">
    <h1>Sourcing</h1>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <p v-if="!suppliers.length" class="empty">
      Add a supplier in Settings first — a reorder draft is always addressed to one.
    </p>

    <template v-else>
      <div class="builder">
        <label>
          <span>Supplier</span>
          <select v-model="supplierId">
            <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <button type="button" :disabled="busy || !chosen.length" @click="createDraft">
          {{ busy ? 'Creating…' : 'Create draft (' + chosen.length + ')' }}
        </button>
      </div>

      <table>
        <thead>
          <tr><th>Product</th><th class="num">Reorder qty</th></tr>
        </thead>
        <tbody>
          <tr v-for="product in products" :key="product.id">
            <td>{{ product.title }}</td>
            <td class="num">
              <input
                type="number"
                min="0"
                :value="qty[product.id] ?? 0"
                :aria-label="'Reorder quantity for ' + product.title"
                @input="setQty(product.id, Number(($event.target as HTMLInputElement).value))"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <template v-if="drafts.length">
      <h2>Drafts</h2>
      <ul class="drafts">
        <li v-for="draft in drafts" :key="draft.id">
          <span>
            {{ supplierName(draft.supplierId) }} · {{ draft.lines.length }} line(s) ·
            <strong>{{ draft.status }}</strong>
          </span>
          <button v-if="draft.status === 'draft'" type="button" @click="markSent(draft.id)">
            Mark sent
          </button>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.sourcing { display: flex; flex-direction: column; gap: 1rem; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: .5rem 0 0; font-size: 1.05rem; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.builder { display: flex; align-items: flex-end; gap: .75rem; }
.builder label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
table { width: 100%; border-collapse: collapse; background: var(--zfy-surface, #fff); border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); font-size: .9rem; }
tbody tr:last-child td { border-bottom: none; }
.num { text-align: right; }
.num input { width: 6rem; text-align: right; }
.drafts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.drafts li { display: flex; justify-content: space-between; align-items: center; gap: 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; background: var(--zfy-surface, #fff); font-size: .9rem; }
</style>
