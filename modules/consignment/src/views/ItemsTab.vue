<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Product } from '@zollify/shared';
import { fmtPrice } from '@zollify/shared';
import { Icon, ModalShell } from '@zollify/ui';
import PricingDialog from './PricingDialog.vue';
import IncomingPackages from './IncomingPackages.vue';
import { artistCatalog, assign, consignors, errorText, importFromArtist, products, productsOf, stores, unassign, type CatalogProduct } from '../api';
import { sdk } from '../runtime';

/**
 * One artist's items. They are ordinary catalogue products tagged with the
 * artist, so the till, price cards and stock all treat them as usual; this is
 * where they get tagged, imported from the artist's own catalogue, counted in
 * and spread over the stores that carry the artist.
 */
const consignorId = defineModel<string>('consignor', { default: '' });
const emit = defineEmits<{ error: [message: string | null] }>();

const choices = computed(() => consignors.value.filter((c) => !c.archived || c.id === consignorId.value).sort((a, b) => a.name.localeCompare(b.name)));
watch(
  choices,
  (list) => {
    if (!list.some((c) => c.id === consignorId.value)) consignorId.value = list[0]?.id ?? '';
  },
  { immediate: true },
);
const consignor = computed(() => consignors.value.find((c) => c.id === consignorId.value));
const currency = computed(() => sdk().account()?.profile.defaultCurrency ?? 'CHF');
/** The stores this artist is in - where their stock can be placed. */
const artistStores = computed(() => stores.value.filter((s) => consignor.value?.storeIds.includes(s.id)));

interface Row {
  product: Product;
  variantId: string;
  label: string;
  price: number;
}
const rows = computed<Row[]>(() =>
  productsOf(consignorId.value)
    .sort((a, b) => a.title.localeCompare(b.title))
    .flatMap((p) =>
      p.variants.length
        ? p.variants.map((v) => ({ product: p, variantId: v.id, label: `${p.title} · ${v.name}`, price: v.price ?? p.price }))
        : [{ product: p, variantId: '', label: p.title, price: p.price }],
    ),
);

// ── Stock ───────────────────────────────────────────────────────────────────
const inv = () => sdk().data.inventory;
/** Here now: the last count less what sold since (typing a number is a fresh count). */
const onHand = (r: Row): number => inv().inStock(r.product.id, r.variantId || null);
/** This store's claim on an item, or null when the store sells it from the shared pool. */
const claims = computed(() => {
  const map = new Map<string, number | null>();
  for (const s of artistStores.value) {
    for (const a of inv().availability(s.id)) map.set(`${s.id}:${a.productId}:${a.variantId}`, a.claimed);
  }
  return map;
});
const claimOf = (storeId: string, r: Row): number | null => claims.value.get(`${storeId}:${r.product.id}:${r.variantId}`) ?? null;

async function guard(work: () => Promise<unknown>, fallback: string): Promise<void> {
  emit('error', null);
  try {
    await work();
  } catch (err) {
    emit('error', errorText(err, fallback));
  }
}
const readQty = (e: Event): number | null => {
  const raw = (e.target as HTMLInputElement).value.trim();
  if (raw === '') return null;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
function setOnHand(r: Row, e: Event): void {
  const qty = readQty(e);
  if (qty == null) return;
  void guard(() => inv().setOnHand(r.product.id, r.variantId || null, qty), 'Could not update the count.');
}
function setClaim(storeId: string, r: Row, e: Event): void {
  const qty = readQty(e);
  void guard(
    () => (qty == null ? inv().clearClaim(storeId, r.product.id, r.variantId || null) : inv().claim(storeId, r.product.id, r.variantId || null, qty)),
    'Could not update the store stock.',
  );
}
async function remove(p: Product): Promise<void> {
  const ok = await sdk().ui.confirm(`${p.title} becomes your own stock. Sales already made stay with ${consignor.value?.name}.`, 'Remove from artist?');
  if (ok) await guard(() => unassign(p.id), 'Could not update the item.');
}

// ── New and existing products ───────────────────────────────────────────────
/**
 * Items are ordinary products, so a new one is made on the Products page;
 * `?new=1&consignor=` opens its editor with this artist already picked, so
 * nobody has to come back here to tag it.
 */
function newItem(): void {
  location.hash = `#/catalog?new=1&consignor=${encodeURIComponent(consignorId.value)}`;
}
const picking = ref(false);
const search = ref('');
const picked = ref<string[]>([]);
const unassigned = computed(() => {
  const q = search.value.trim().toLowerCase();
  return products.value
    .filter((p) => !p.consignorId)
    .filter((p) => !q || p.title.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q))
    .sort((a, b) => a.title.localeCompare(b.title));
});
function openPicker(): void {
  search.value = '';
  picked.value = [];
  picking.value = true;
}
async function assignPicked(): Promise<void> {
  await guard(() => assign(picked.value, consignorId.value), 'Could not tag the items.');
  picking.value = false;
}

// ── Import from the linked artist's catalogue ─────────────────────────────
const pricingOpen = ref(false);
/**
 * Shared items with no price in the store's currency yet: the server keeps
 * them off the till (for sale = off) rather than sell at a number in the
 * wrong currency. Without saying so here they look stocked and simply never
 * appear at the till.
 */
const offTill = computed(() => productsOf(consignorId.value).filter((p) => p.consignorProductId && !p.forSale));
const importing = ref(false);
const catalog = ref<CatalogProduct[]>([]);
const toImport = ref<string[]>([]);
const loadingCatalog = ref(false);
const imported = computed(() => new Set(productsOf(consignorId.value).map((p) => p.consignorProductId).filter(Boolean)));
async function openImport(): Promise<void> {
  importing.value = true;
  loadingCatalog.value = true;
  catalog.value = [];
  await guard(async () => {
    catalog.value = await artistCatalog(consignorId.value);
    toImport.value = catalog.value.filter((p) => !imported.value.has(p.id)).map((p) => p.id);
  }, 'Could not load their catalogue.');
  loadingCatalog.value = false;
}
async function runImport(): Promise<void> {
  const items = catalog.value.filter((p) => toImport.value.includes(p.id));
  await guard(async () => {
    const n = await importFromArtist(consignorId.value, items);
    sdk().ui.toast(`Imported ${n} item${n === 1 ? '' : 's'} from ${consignor.value?.name}.`, { kind: 'success' });
  }, 'Could not import the items.');
  importing.value = false;
}
</script>

<template>
  <div class="tab">
    <IncomingPackages @error="emit('error', $event)" />
    <p v-if="!choices.length" class="empty">Add an artist first (Stores → Artists), then add their items here.</p>
    <template v-else>
      <div class="bar">
        <label class="pick">
          <span>Artist</span>
          <select v-model="consignorId">
            <option v-for="c in choices" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
        <span class="grow" />
        <button v-if="consignor?.linked" type="button" @click="pricingOpen = true"><Icon name="coins" :size="14" /> Prices</button>
        <button type="button" class="primary" @click="newItem"><Icon name="plus" :size="14" /> New item</button>
        <button type="button" @click="openPicker"><Icon name="tag" :size="14" /> Add existing products</button>
        <button type="button" class="quiet" :disabled="!consignor?.linked" :title="consignor?.linked ? 'A one-off copy you manage yourself - shared items stay in step with the artist instead' : `Only for an artist with their own Zollify account - invite ${consignor?.name ?? 'them'} under Artists first`" @click="openImport">
          <Icon name="download" :size="14" /> Import a copy
        </button>
      </div>
      <p v-if="consignor?.linked" class="hint">{{ consignor.name }} shares items from their own Zollify catalogue - they appear here with photos and follow their edits. Scanning one of their labels at the till shares it too.</p>

      <p class="hint">
        On hand is what you hold of the artist's work across all stores.
        <template v-if="artistStores.length > 1">Put a number under a store to reserve stock there; leave it blank and the store sells from what is unreserved.</template>
      </p>

      <div v-if="offTill.length" class="offtill" role="status">
        <p><strong>{{ offTill.length }} shared item{{ offTill.length === 1 ? ' is' : 's are' }} not on the till yet.</strong> {{ consignor?.name }}'s prices are in another currency than your store's ({{ currency }}), and there is no exchange rate for them. Set a rate, or a price per item, and they go on sale at every till with the next sync.</p>
        <button type="button" class="primary" @click="pricingOpen = true"><Icon name="coins" :size="14" /> Set prices</button>
      </div>

      <div v-if="!rows.length" class="empty">
        <p><strong>No items for {{ consignor?.name }} yet.</strong></p>
        <p>Their items are ordinary products, tagged with their name - the till, labels and stock treat them like your own.</p>
        <div class="empty-actions">
          <button type="button" class="primary" @click="newItem"><Icon name="plus" :size="14" /> New item for {{ consignor?.name }}</button>
          <button type="button" :disabled="!unassigned.length" :title="unassigned.length ? '' : 'Every product in your catalogue is already tagged'" @click="openPicker"><Icon name="tag" :size="14" /> Add existing products</button>
        </div>
      </div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th class="num">Price</th>
              <th class="num">On hand</th>
              <th v-for="s in artistStores.length > 1 ? artistStores : []" :key="s.id" class="num">{{ s.name }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="`${r.product.id}:${r.variantId}`">
              <td>{{ r.label }}<span v-if="r.product.sku" class="hint"> · {{ r.product.sku }}</span><span v-if="r.product.consignorProductId && !r.product.forSale" class="badge">not on the till</span></td>
              <td class="num">{{ r.product.consignorProductId && !r.product.forSale ? '-' : fmtPrice(r.price, currency) }}</td>
              <td class="num"><input type="number" min="0" step="1" inputmode="numeric" :value="onHand(r)" :aria-label="`On hand, ${r.label}`" @change="setOnHand(r, $event)" /></td>
              <td v-for="s in artistStores.length > 1 ? artistStores : []" :key="s.id" class="num">
                <input type="number" min="0" step="1" inputmode="numeric" placeholder="-" :value="claimOf(s.id, r) ?? ''" :aria-label="`${s.name}, ${r.label}`" @change="setClaim(s.id, r, $event)" />
              </td>
              <td class="num"><button v-if="!r.variantId || r.product.variants[0]?.id === r.variantId" type="button" class="quiet" @click="remove(r.product)">Remove</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <ModalShell v-if="picking" :title="`Add existing products for ${consignor?.name}`" @close="picking = false">
      <div class="form">
        <p class="hint">Products you already have that are {{ consignor?.name }}'s work. Products tagged with another artist are not listed.</p>
        <input v-model="search" type="search" placeholder="Search your catalogue" />
        <p v-if="!unassigned.length" class="hint">{{ search ? 'No untagged product matches.' : 'Every product is already tagged.' }} Use New item to add one for {{ consignor?.name }}.</p>
        <ul class="list">
          <li v-for="p in unassigned" :key="p.id">
            <label class="check"><input v-model="picked" type="checkbox" :value="p.id" /> {{ p.title }}<span v-if="p.sku" class="hint"> · {{ p.sku }}</span></label>
          </li>
        </ul>
      </div>
      <template #footer>
        <div class="footer">
          <button type="button" @click="picking = false">Cancel</button>
          <button type="button" class="primary" :disabled="!picked.length" @click="assignPicked">Add {{ picked.length || '' }}</button>
        </div>
      </template>
    </ModalShell>

    <ModalShell v-if="pricingOpen && consignor" :title="`Prices for ${consignor.name}'s items`" @close="pricingOpen = false">
      <PricingDialog :consignor-id="consignor.id" :name="consignor.name" @close="pricingOpen = false" @saved="sdk().ui.toast('Prices saved - every till picks them up with its next sync.', { kind: 'success' })" />
    </ModalShell>

    <ModalShell v-if="importing" :title="`Import from ${consignor?.name}`" @close="importing = false">
      <div class="form">
        <p v-if="loadingCatalog" class="hint">Loading their catalogue…</p>
        <template v-else>
          <p class="hint">Copies title, SKU, price, variants and customs details into your catalogue, tagged with {{ consignor?.name }}. Photos stay on their devices - add your own.</p>
          <p v-if="!catalog.length" class="hint">They have nothing for sale in their catalogue.</p>
          <ul class="list">
            <li v-for="p in catalog" :key="p.id">
              <label class="check">
                <input v-model="toImport" type="checkbox" :value="p.id" />
                {{ p.title }}<span class="hint"> · {{ fmtPrice(p.price, currency) }}<template v-if="p.variants.length"> · {{ p.variants.length }} variants</template></span>
                <span v-if="imported.has(p.id)" class="pill">imported</span>
              </label>
            </li>
          </ul>
        </template>
      </div>
      <template #footer>
        <div class="footer">
          <button type="button" @click="importing = false">Cancel</button>
          <button type="button" class="primary" :disabled="!toImport.length" @click="runImport">Import {{ toImport.length || '' }}</button>
        </div>
      </template>
    </ModalShell>
  </div>
</template>

<style scoped>
.tab { display: flex; flex-direction: column; gap: .8rem; }
.bar { display: flex; align-items: flex-end; gap: .6rem; flex-wrap: wrap; }
.bar button { min-height: 2.4rem; display: inline-flex; align-items: center; gap: .35rem; font-size: .82rem; }
.pick { display: flex; flex-direction: column; gap: .25rem; font-size: .82rem; min-width: 14rem; }
.grow { flex: 1; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .82rem; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.empty p { margin: 0 0 .4rem; font-size: .88rem; }
.empty strong { color: var(--zfy-ink, #1a2230); }
.empty-actions { display: flex; justify-content: center; gap: .5rem; flex-wrap: wrap; margin-top: .6rem; }
.empty-actions button { min-height: 2.4rem; display: inline-flex; align-items: center; gap: .35rem; font-size: .82rem; }
.table-wrap { overflow-x: auto; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
table { width: 100%; border-collapse: collapse; font-size: .85rem; }
th, td { padding: .45rem .7rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); text-align: left; }
th { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); font-weight: 600; }
tbody tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td input[type='number'] { width: 5rem; text-align: right; }
.form { display: flex; flex-direction: column; gap: .6rem; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; max-height: 50vh; overflow-y: auto; }
label.check { display: flex; align-items: center; gap: .4rem; font-size: .875rem; flex-wrap: wrap; }
.pill { font-size: .62rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; border-radius: 999px; padding: .1rem .45rem; background: var(--zfy-bg, #f1f4f6); color: var(--zfy-muted, #5a6472); }
.footer { display: flex; justify-content: flex-end; gap: .5rem; }
.offtill { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; padding: .7rem .9rem; border-radius: 10px; border: 1px solid var(--zfy-warning, #c08a2e); background: color-mix(in srgb, var(--zfy-warning, #c08a2e) 10%, transparent); }
.offtill p { flex: 1; min-width: 14rem; margin: 0; font-size: .85rem; }
.badge { margin-left: .4rem; font-size: .66rem; font-weight: 600; padding: .05rem .4rem; border-radius: 999px; color: var(--zfy-warning, #8a5f12); background: color-mix(in srgb, var(--zfy-warning, #c08a2e) 16%, transparent); white-space: nowrap; }
</style>
