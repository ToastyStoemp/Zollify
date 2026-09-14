<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { DiscountRule } from '@zollify/shared';
import { fmtPrice } from '@zollify/shared';
import { Icon, ModalShell, typeColor } from '@zollify/ui';
import {
  allDiscounts,
  allProducts,
  currentAccount,
  deleteDiscount,
  discountsLoaded,
  loadDiscounts,
  shellConfirm,
  upsertDiscount,
} from '@zollify/platform';

/**
 * Discount rules — ZollTool's editor, screen for screen.
 *
 * Rules live in core rather than POS because they reference products and must
 * survive POS being switched off. A rule targets whole product types, single
 * products, or single variants; the POS reads them at every keystroke.
 */

const account = currentAccount;
const currency = computed(() => account.value?.profile.defaultCurrency ?? 'CHF');
const error = ref<string | null>(null);

onMounted(() => {
  if (!discountsLoaded.value) void loadDiscounts().catch(() => {});
});

const editing = ref(false);
const editId = ref<string | null>(null);
const form = reactive({
  name: '',
  type: 'bxgy' as DiscountRule['type'],
  productIds: [] as string[],
  /** "pid:vid" keys — only relevant when the product itself isn't selected. */
  variantIds: [] as string[],
  productTypes: [] as string[],
  buyQty: '2',
  freeQty: '1',
  nth: '3',
  percent: '50',
  tiers: [] as { qty: string; total: string }[],
  tierContinue: false,
  hideQuickAdd: false,
  comboDiscountAmount: '',
});

const types = computed(() => [...new Set(allProducts.value.map((p) => p.type).filter((t): t is string => !!t))].sort());
const productSearch = ref('');
const productList = computed(() => {
  const needle = productSearch.value.trim().toLowerCase();
  if (!needle) return allProducts.value;
  return allProducts.value.filter((p) =>
    [p.title, p.sku, p.type, ...p.variants.flatMap((v) => [v.name, v.sku])].filter(Boolean).join(' ').toLowerCase().includes(needle),
  );
});
const targetCount = computed(() => form.productTypes.length + form.productIds.length + form.variantIds.length);

const typeOf = (pid: string): string | undefined => allProducts.value.find((p) => p.id === pid)?.type;
/** Everything the form covers, resolved down to product ids + types. */
function covers(pid: string): boolean {
  const t = typeOf(pid);
  return form.productIds.includes(pid) || (!!t && form.productTypes.includes(t));
}
const productOf = (key: string): string => key.split(':')[0] ?? key;

/** Other rules that already target something selected here — they stack. */
const overlapping = computed(() =>
  allDiscounts.value.filter(
    (d) =>
      d.id !== editId.value &&
      (d.productIds.some((id) => covers(id)) ||
        d.variantIds.some((id) => form.variantIds.includes(id)) ||
        d.productIds.some((id) => form.variantIds.some((v) => productOf(v) === id)) ||
        d.variantIds.some((id) => covers(productOf(id))) ||
        (d.productTypes ?? []).some(
          (t) => form.productTypes.includes(t) || form.productIds.some((pid) => typeOf(pid) === t) || form.variantIds.some((v) => typeOf(productOf(v)) === t),
        )),
  ),
);

function openNew(): void {
  editId.value = null;
  productSearch.value = '';
  Object.assign(form, {
    name: '',
    type: 'bxgy',
    productIds: [],
    variantIds: [],
    productTypes: [],
    buyQty: '2',
    freeQty: '1',
    nth: '3',
    percent: '50',
    tiers: [{ qty: '3', total: '' }],
    tierContinue: false,
    hideQuickAdd: false,
    comboDiscountAmount: '',
  });
  editing.value = true;
}

function openEdit(d: DiscountRule): void {
  editId.value = d.id;
  productSearch.value = '';
  Object.assign(form, {
    name: d.name,
    type: d.type,
    productIds: [...d.productIds],
    variantIds: [...(d.variantIds ?? [])],
    productTypes: [...(d.productTypes ?? [])],
    buyQty: String(d.buyQty ?? 2),
    freeQty: String(d.freeQty ?? 1),
    nth: String(d.nth ?? 3),
    percent: String(d.percent ?? 50),
    tiers: (d.tiers ?? []).map((t) => ({ qty: String(t.qty), total: String(t.total) })),
    tierContinue: !!d.tierContinue,
    hideQuickAdd: !!d.hideQuickAdd,
    comboDiscountAmount: d.comboDiscountAmount ? String(d.comboDiscountAmount) : '',
  });
  editing.value = true;
}

async function save(): Promise<void> {
  if (!form.name.trim()) return fail('Give the rule a name so it can be recognised on a receipt.');
  if (!targetCount.value) return fail('Pick at least one product type, product or variant.');
  if (form.type === 'combo' && targetCount.value < 2) return fail('A bundle needs at least two members.');
  if (form.type === 'combo' && !(parseFloat(form.comboDiscountAmount) > 0)) return fail('Enter a bundle discount amount.');
  const existing = editId.value ? allDiscounts.value.find((d) => d.id === editId.value) : undefined;
  const rule: DiscountRule = {
    ...existing,
    id: editId.value ?? crypto.randomUUID(),
    name: form.name.trim(),
    type: form.type,
    // Targets a selected type already covers are redundant — drop them.
    productIds: form.productIds.filter((id) => {
      const t = typeOf(id);
      return !t || !form.productTypes.includes(t);
    }),
    variantIds: form.variantIds.filter((v) => !covers(productOf(v))),
    productTypes: [...form.productTypes],
    buyQty: parseInt(form.buyQty) || 2,
    freeQty: parseInt(form.freeQty) || 1,
    nth: parseInt(form.nth) || 3,
    percent: parseFloat(form.percent) || 50,
    tiers: form.tiers.map((t) => ({ qty: parseInt(t.qty) || 0, total: parseFloat(t.total) || 0 })).filter((t) => t.qty > 1 && t.total > 0),
    tierContinue: form.tierContinue,
    hideQuickAdd: form.hideQuickAdd || undefined,
    comboDiscountAmount: parseFloat(form.comboDiscountAmount) || 0,
    updatedAt: Date.now(),
  };
  error.value = null;
  try {
    await upsertDiscount(rule);
    editing.value = false;
  } catch (err) {
    fail(err instanceof Error ? err.message : 'Could not save that rule.');
  }
}
function fail(message: string): void {
  error.value = message;
}

async function remove(rule: DiscountRule): Promise<void> {
  const ok = await shellConfirm(`Remove "${rule.name}"? Past sales keep the discount they were given.`, 'Remove this rule');
  if (!ok) return;
  try {
    await deleteDiscount(rule.id);
    if (editId.value === rule.id) editing.value = false;
  } catch (err) {
    fail(err instanceof Error ? err.message : 'Could not remove that rule.');
  }
}

function summary(d: DiscountRule): string {
  if (d.type === 'bxgy') return `Buy ${d.buyQty}, get ${d.freeQty} free`;
  if (d.type === 'nth_pct') return `Every ${d.nth} items, cheapest is ${d.percent}% off`;
  if (d.type === 'combo') return `Bundle: −${fmtPrice(d.comboDiscountAmount ?? 0, currency.value)} when all present`;
  return (d.tiers ?? []).map((t) => `${t.qty} for ${t.total}`).join(' · ') || 'Tiered';
}
function targets(d: DiscountRule): string {
  const parts: string[] = [];
  if (d.productTypes?.length) parts.push(`type ${d.productTypes.join(', ')}`);
  const count = d.productIds.length + (d.variantIds?.length ?? 0);
  if (count) parts.push(`${count} product${count === 1 ? '' : 's'}`);
  return parts.join(' + ') || 'no targets';
}
</script>

<template>
  <section class="discounts">
    <header>
      <div>
        <h1>Discounts</h1>
        <p class="hint">Rules apply themselves at the till. A seller can still add a one-off discount on top of them.</p>
      </div>
      <button type="button" class="primary" @click="openNew"><Icon name="plus" :size="16" /> New rule</button>
    </header>

    <p v-if="error && !editing" class="error" role="alert">{{ error }}</p>

    <p v-if="!allDiscounts.length" class="empty">No discount rules yet. Bundle deals like "buy 2 get 1 free" or "3 for 25" go here.</p>
    <ul v-else class="list">
      <li v-for="d in allDiscounts" :key="d.id">
        <button type="button" class="row" @click="openEdit(d)">
          <strong>{{ d.name }}</strong>
          <span>{{ summary(d) }} · {{ targets(d) }}</span>
        </button>
        <button type="button" class="quiet danger" @click="remove(d)">Remove</button>
      </li>
    </ul>

    <ModalShell v-if="editing" :title="editId ? 'Edit discount' : 'New discount'" @close="editing = false">
      <div class="form">
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <label><span>Name</span><input v-model="form.name" type="text" placeholder="3 prints for 100" /></label>
        <label>
          <span>Kind</span>
          <select v-model="form.type">
            <option value="bxgy">Buy X get Y free</option>
            <option value="nth_pct">Every Nth item % off</option>
            <option value="tiered">Tiered (e.g. 3 for 25)</option>
            <option value="combo">Bundle (all items must be present)</option>
          </select>
        </label>

        <div v-if="form.type === 'bxgy'" class="two">
          <label><span>Buy</span><input v-model="form.buyQty" type="number" min="1" inputmode="numeric" /></label>
          <label><span>Get free</span><input v-model="form.freeQty" type="number" min="1" inputmode="numeric" /></label>
        </div>
        <div v-else-if="form.type === 'nth_pct'" class="two">
          <label><span>Every Nth item</span><input v-model="form.nth" type="number" min="2" inputmode="numeric" /></label>
          <label><span>% off</span><input v-model="form.percent" type="number" min="1" max="100" inputmode="decimal" /></label>
        </div>
        <div v-else-if="form.type === 'tiered'" class="tiers">
          <div v-for="(t, i) in form.tiers" :key="i" class="tier">
            <input v-model="t.qty" type="number" min="2" placeholder="Qty" aria-label="Quantity" inputmode="numeric" />
            <span>for</span>
            <input v-model="t.total" type="number" step="0.05" placeholder="Total" aria-label="Total" inputmode="decimal" />
            <button type="button" class="quiet" aria-label="Remove tier" @click="form.tiers.splice(i, 1)"><Icon name="x" :size="14" /></button>
          </div>
          <button type="button" class="quiet add" @click="form.tiers.push({ qty: '', total: '' })">+ Add tier</button>
          <label class="inline"><input v-model="form.tierContinue" type="checkbox" /> <span>Continue tier price for remainder items</span></label>
          <label class="inline"><input v-model="form.hideQuickAdd" type="checkbox" /> <span>Hide the +N quick-add chips on the till</span></label>
        </div>
        <div v-else-if="form.type === 'combo'" class="tiers">
          <p class="hint">Triggers once for every complete set of the members found in the cart — 2 purses + 3 wallets makes 2 bundles, one wallet left over. Pick at least two members below.</p>
          <label><span>Bundle discount ({{ currency }}, off the total per bundle)</span><input v-model="form.comboDiscountAmount" type="number" min="0" step="0.05" inputmode="decimal" /></label>
        </div>

        <fieldset class="targets">
          <legend>{{ form.type === 'combo' ? 'Bundle members (all required)' : 'Applies to' }} <em v-if="targetCount">{{ targetCount }} selected</em></legend>
          <div v-if="types.length" class="types">
            <label v-for="t in types" :key="t" class="inline">
              <input v-model="form.productTypes" type="checkbox" :value="t" />
              <span :style="{ color: typeColor(t) }" class="type">{{ t }}</span>
              <small>all {{ allProducts.filter((p) => p.type === t).length }} products of this type</small>
            </label>
          </div>
          <input v-model="productSearch" type="search" placeholder="Search products…" aria-label="Search products" />
          <div class="picks">
            <p v-if="!productList.length" class="hint">No products match.</p>
            <template v-for="p in productList" :key="p.id">
              <label v-show="!(p.type && form.productTypes.includes(p.type))" class="inline pick">
                <input v-model="form.productIds" type="checkbox" :value="p.id" />
                <span class="name">{{ p.title || '(untitled)' }}</span>
                <small v-if="p.type" :style="{ color: typeColor(p.type) }">{{ p.type }}</small>
              </label>
              <label v-for="v in p.variants" v-show="!covers(p.id)" :key="v.id" class="inline pick variant">
                <input v-model="form.variantIds" type="checkbox" :value="`${p.id}:${v.id}`" />
                <span class="name">{{ v.name || v.id }}</span>
              </label>
            </template>
          </div>
          <p v-if="overlapping.length" class="warn"><Icon name="alert-triangle" :size="14" /> Also targeted by {{ overlapping.map((d) => `"${d.name}"`).join(', ') }} — discounts on the same items stack.</p>
        </fieldset>
      </div>
      <template #footer>
        <div class="actions">
          <button v-if="editId" type="button" class="danger" @click="remove(allDiscounts.find((d) => d.id === editId)!)">Remove</button>
          <span class="spacer"></span>
          <button type="button" @click="editing = false">Cancel</button>
          <button type="button" class="primary" @click="save">Save</button>
        </div>
      </template>
    </ModalShell>
  </section>
</template>

<style scoped>
.discounts { display: flex; flex-direction: column; gap: 1rem; max-width: 52rem; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
header .primary { display: inline-flex; align-items: center; gap: .4rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .85rem; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); overflow: hidden; }
.list li { display: flex; align-items: center; gap: .5rem; padding-right: .5rem; }
.list li + li { border-top: 1px solid var(--zfy-line, #d6dde4); }
.row { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: .1rem; padding: .7rem 1rem; text-align: left; border: 0; border-radius: 0; background: none; }
.row:hover { background: var(--zfy-bg, #f1f4f6); }
.row strong { font-size: .95rem; }
.row span { font-size: .8rem; color: var(--zfy-muted, #5a6472); }
.form { display: flex; flex-direction: column; gap: .7rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label.inline { flex-direction: row; align-items: center; gap: .45rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.tiers { display: flex; flex-direction: column; gap: .45rem; }
.tier { display: flex; align-items: center; gap: .4rem; font-size: .875rem; }
.tier input { width: 6rem; }
.add { align-self: flex-start; color: var(--zfy-accent-ink, #0a5a4a); }
.targets { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .5rem; background: var(--zfy-bg, #f1f4f6); }
legend { font-size: .85rem; font-weight: 600; padding: 0 .3rem; }
legend em { font-style: normal; font-weight: 400; color: var(--zfy-accent-ink, #0a5a4a); font-size: .78rem; margin-left: .4rem; }
.types { display: flex; flex-direction: column; gap: .2rem; padding-bottom: .5rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
.type { font-weight: 600; }
.types small, .pick small { color: var(--zfy-muted, #5a6472); font-size: .75rem; }
.picks { max-height: 40vh; overflow-y: auto; display: flex; flex-direction: column; gap: .1rem; }
.pick { padding: .15rem .25rem; border-radius: 6px; }
.pick:hover { background: var(--zfy-surface, #fff); }
.pick .name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick.variant { margin-left: 1.5rem; font-size: .8rem; color: var(--zfy-muted, #5a6472); }
.warn { display: flex; gap: .4rem; align-items: flex-start; margin: 0; font-size: .8rem; color: var(--zfy-warning-ink, #8a5a1e); }
.actions { display: flex; gap: .5rem; align-items: center; }
.spacer { flex: 1; }
</style>
