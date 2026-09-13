<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { DiscountRule, DiscountTier } from '@zollify/shared';
import {
  allDiscounts,
  allProducts,
  deleteDiscount,
  discountsLoaded,
  loadDiscounts,
  pendingConfirm,
  upsertDiscount,
} from '@zollify/platform';

/**
 * Discount rules.
 *
 * Rules live in core rather than POS because they reference products and must
 * survive POS being switched off. POS reads them through the SDK at checkout.
 */

type Draft = DiscountRule & { enabled?: boolean };

const editing = ref<Draft | null>(null);
const error = ref<string | null>(null);

onMounted(() => {
  if (!discountsLoaded.value) void loadDiscounts().catch(() => {});
});

const products = computed(() => allProducts.value);

/** Tiers of the rule being edited. Kept here so the template stays cast-free. */
const tiers = computed<DiscountTier[]>(() => (editing.value as Draft & { tiers?: DiscountTier[] })?.tiers ?? []);

function isEnabled(rule: DiscountRule): boolean {
  return (rule as Draft).enabled !== false;
}

function asDraft(rule: DiscountRule): Draft {
  return { ...(rule as Draft) };
}

function blank(): Draft {
  return {
    id: crypto.randomUUID(),
    name: '',
    type: 'nth_pct',
    productIds: [],
    variantKeys: [],
    enabled: true,
  } as unknown as Draft;
}

function toggleProduct(id: string): void {
  if (!editing.value) return;
  const ids = new Set(editing.value.productIds ?? []);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  editing.value.productIds = [...ids];
}

function addTier(): void {
  if (!editing.value) return;
  const next = [...tiers.value];
  next.push({ qty: next.length + 2, total: 0 });
  (editing.value as Draft & { tiers?: DiscountTier[] }).tiers = next;
}

function removeTier(index: number): void {
  if (!editing.value) return;
  const next = [...tiers.value];
  next.splice(index, 1);
  (editing.value as Draft & { tiers?: DiscountTier[] }).tiers = next;
}

async function save(): Promise<void> {
  if (!editing.value) return;
  if (!editing.value.name.trim()) {
    error.value = 'Give the rule a name so it can be recognised on a receipt.';
    return;
  }
  if (!editing.value.productIds?.length) {
    error.value = 'Pick at least one product, or the rule can never apply.';
    return;
  }
  error.value = null;
  try {
    await upsertDiscount({ ...editing.value, name: editing.value.name.trim() });
    editing.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save that rule.';
  }
}

async function remove(rule: DiscountRule): Promise<void> {
  const ok = await new Promise<boolean>((resolve) => {
    pendingConfirm.current = {
      title: 'Remove this rule',
      message: `Remove "${rule.name}"? Past sales keep the discount they were given.`,
      resolve(answer) {
        pendingConfirm.current = null;
        resolve(answer);
      },
    };
  });
  if (!ok) return;
  try {
    await deleteDiscount(rule.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not remove that rule.';
  }
}

function describe(rule: DiscountRule): string {
  const count = rule.productIds?.length ?? 0;
  const scope = `${count} product${count === 1 ? '' : 's'}`;
  switch (rule.type) {
    case 'bxgy':
      return `Buy X get Y · ${scope}`;
    case 'nth_pct':
      return `Percentage off · ${scope}`;
    case 'tiered':
      return `Tiered bundle · ${scope}`;
    case 'combo':
      return `Combo bundle · ${scope}`;
    default:
      return scope;
  }
}
</script>

<template>
  <section class="discounts">
    <header>
      <h2>Discounts</h2>
      <button type="button" @click="editing = blank()">New rule</button>
    </header>
    <p class="hint">
      Rules apply automatically at checkout. A seller can still add a one-off discount on top for a
      single sale.
    </p>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <form v-if="editing" class="editor" @submit.prevent="save">
      <div class="row">
        <label>
          <span>Name</span>
          <input v-model="editing.name" type="text" placeholder="3 prints for 100" required />
        </label>
        <label>
          <span>Kind</span>
          <select v-model="editing.type">
            <option value="nth_pct">Percentage off</option>
            <option value="bxgy">Buy X get Y</option>
            <option value="tiered">Tiered bundle price</option>
            <option value="combo">Combo bundle</option>
          </select>
        </label>
      </div>

      <fieldset>
        <legend>Applies to</legend>
        <p v-if="!products.length" class="hint">No products yet.</p>
        <div class="picks">
          <label v-for="product in products" :key="product.id" class="inline">
            <input
              type="checkbox"
              :checked="editing.productIds?.includes(product.id)"
              @change="toggleProduct(product.id)"
            />
            <span>{{ product.title }}</span>
          </label>
        </div>
      </fieldset>

      <fieldset v-if="editing.type === 'tiered'">
        <legend>Tiers</legend>
        <p class="hint">Buy this many, pay this total.</p>
        <div v-for="(tier, i) in tiers" :key="i" class="tier">
          <input v-model.number="tier.qty" type="number" min="2" aria-label="Quantity" />
          <span>for</span>
          <input v-model.number="tier.total" type="number" min="0" step="0.01" aria-label="Total" />
          <button type="button" @click="removeTier(i)">Remove</button>
        </div>
        <button type="button" @click="addTier">Add tier</button>
      </fieldset>

      <label class="inline">
        <input v-model="editing.enabled" type="checkbox" />
        <span>Active at checkout</span>
      </label>

      <div class="actions">
        <button type="button" @click="editing = null">Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>

    <p v-if="!allDiscounts.length" class="hint">No discount rules yet.</p>

    <ul v-else class="list">
      <li v-for="rule in allDiscounts" :key="rule.id">
        <div class="meta">
          <strong>{{ rule.name }}</strong>
          <span>
            {{ describe(rule) }}
            <template v-if="!isEnabled(rule)"> · inactive</template>
          </span>
        </div>
        <div class="row-actions">
          <button type="button" @click="editing = asDraft(rule)">Edit</button>
          <button type="button" @click="remove(rule)">Remove</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.discounts { display: flex; flex-direction: column; gap: .75rem; max-width: 40rem; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
h2 { margin: 0; font-size: 1.05rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .875rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.editor { display: flex; flex-direction: column; gap: .7rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); }
.row { display: grid; grid-template-columns: 1fr 12rem; gap: .75rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label.inline { flex-direction: row; align-items: center; gap: .4rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .4rem; }
legend { font-size: .8rem; padding: 0 .3rem; color: var(--zfy-muted, #5a6472); }
.picks { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .25rem; max-height: 12rem; overflow-y: auto; }
.tier { display: flex; align-items: center; gap: .4rem; font-size: .875rem; }
.tier input { width: 6rem; }
.actions { display: flex; gap: .5rem; justify-content: flex-end; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.list li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; background: var(--zfy-surface, #fff); }
.meta { display: flex; flex-direction: column; gap: .1rem; font-size: .9rem; }
.meta span { color: var(--zfy-muted, #5a6472); font-size: .78rem; }
.row-actions { display: flex; gap: .4rem; }
</style>
