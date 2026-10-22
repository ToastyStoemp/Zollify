<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { ORDER_STATUS_LABEL, OrderInputSchema, fmtPrice, isEditable, nextOrderStatuses, orderTotals, orderableQty, tiersForPrice, unitPriceFor, type OrderLine, type OrderStatus, type Product, type TradeCustomer, type TradeDetails, type WholesaleOrder } from '@zollify/shared';
import { api, errorText } from '../api';
import { recordShipment, syncClaims } from '../stock';
import { sdk } from '../runtime';

/**
 * Orders: a draft with lines priced from the tiers and the customer's
 * discount, confirmed (units set aside), packed, shipped (recorded as a sale
 * at the Wholesale store), invoiced, paid - or cancelled on the way.
 */
const props = defineProps<{ orders: WholesaleOrder[]; customers: TradeCustomer[]; details: Record<string, TradeDetails> }>();
const emit = defineEmits<{ changed: [] }>();

const filter = ref<'open' | OrderStatus | 'all'>('open');
const FILTERS: { id: typeof filter.value; label: string }[] = [{ id: 'open', label: 'Open' }, ...(Object.keys(ORDER_STATUS_LABEL) as OrderStatus[]).map((s) => ({ id: s, label: ORDER_STATUS_LABEL[s] })), { id: 'all', label: 'All' }];
const isOpen = (o: WholesaleOrder): boolean => o.status !== 'paid' && o.status !== 'cancelled';
const shown = computed(() => props.orders.filter((o) => filter.value === 'all' || (filter.value === 'open' ? isOpen(o) : o.status === filter.value)));
const customerOf = (id: string): TradeCustomer | undefined => props.customers.find((c) => c.id === id);
const error = ref<string | null>(null);
const busy = ref(false);
const when = (ms: number): string => new Date(ms).toLocaleDateString();

// ── Editing ────────────────────────────────────────────────────────────────
const editing = ref<WholesaleOrder | 'new' | null>(null);
const form = reactive({ customerId: '', currency: 'EUR', note: '', requestedDate: '', lines: [] as OrderLine[] });
const query = ref('');
const customer = computed(() => customerOf(form.customerId));
const products = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [];
  return sdk().data.products.forSale().filter((p) => props.details[p.id]?.enabled !== false && (p.title.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q))).slice(0, 12);
});
function start(o: WholesaleOrder | 'new'): void {
  editing.value = o;
  error.value = null;
  query.value = '';
  if (o === 'new') {
    const first = props.customers.find((c) => !c.archived);
    Object.assign(form, { customerId: first?.id ?? '', currency: first?.currency ?? sdk().account()?.profile.defaultCurrency ?? 'EUR', note: '', requestedDate: '', lines: [] });
  } else Object.assign(form, { customerId: o.customerId, currency: o.currency, note: o.note, requestedDate: o.requestedDate, lines: o.lines.map((l) => ({ ...l })) });
}
function onCustomer(): void {
  const c = customer.value;
  if (c) form.currency = c.currency;
  reprice();
}
/** Every line at the tier its quantity reaches, less the customer's discount. A variant at a price of its own gets the tiers' discount off that price. */
function reprice(): void {
  for (const l of form.lines) {
    const p = sdk().data.products.get(l.productId);
    const v = l.variantId ? p?.variants.find((x) => x.id === l.variantId) : undefined;
    const list = v?.price ?? p?.price ?? l.unitPrice;
    const tiers = tiersForPrice(props.details[l.productId]?.tiers ?? [], p?.price ?? 0, list);
    l.unitPrice = unitPriceFor(tiers, l.qty, list, customer.value?.discountPct ?? 0);
  }
}
function add(p: Product, variantId: string | null): void {
  const d = props.details[p.id] ?? { moq: 1, packSize: 1, tiers: [] };
  const existing = form.lines.find((l) => l.productId === p.id && l.variantId === variantId);
  const v = variantId ? p.variants.find((x) => x.id === variantId) : undefined;
  if (existing) existing.qty = orderableQty(existing.qty + d.packSize, d);
  else form.lines.push({ productId: p.id, variantId, title: p.title, variantLabel: v?.name ?? '', sku: v?.sku ?? p.sku ?? '', qty: orderableQty(d.moq, d), unitPrice: 0 });
  reprice();
  query.value = '';
}
function setQty(l: OrderLine, qty: number): void {
  const d = props.details[l.productId] ?? { moq: 1, packSize: 1 };
  l.qty = orderableQty(qty, d);
  reprice();
}
const formTotals = computed(() => orderTotals(form.lines));
const available = (l: OrderLine): number => sdk().data.inventory.inStock(l.productId, l.variantId);

async function save(andConfirm = false): Promise<void> {
  const parsed = OrderInputSchema.safeParse(form);
  if (!parsed.success) {
    error.value = parsed.error.issues[0]?.message ?? 'Check the order.';
    return;
  }
  busy.value = true;
  try {
    const saved = editing.value === 'new' ? (await api.addOrder(parsed.data)).order : (await api.saveOrder((editing.value as WholesaleOrder).id, parsed.data)).order;
    if (andConfirm && saved.status === 'draft') await move({ ...saved }, 'confirmed', true);
    editing.value = null;
    emit('changed');
  } catch (err) {
    error.value = errorText(err, 'Could not save the order.');
  } finally {
    busy.value = false;
  }
}

// ── Moving on ──────────────────────────────────────────────────────────────
async function move(o: WholesaleOrder, to: OrderStatus, quiet = false): Promise<void> {
  error.value = null;
  if (!quiet) {
    const ask: Partial<Record<OrderStatus, string>> = {
      confirmed: `Confirm order #${o.number}? Its ${orderTotals(o.lines).units} units are set aside on the Wholesale store until it ships.`,
      shipped: `Ship order #${o.number}? It is recorded as a sale of ${fmtPrice(orderTotals(o.lines).total, o.currency)} at the Wholesale store, and the stock leaves.`,
      cancelled: `Cancel order #${o.number}? Anything set aside goes back to the pool.`,
    };
    if (ask[to] && !(await sdk().ui.confirm(ask[to]!, ORDER_STATUS_LABEL[to], { confirm: ORDER_STATUS_LABEL[to] }))) return;
  }
  busy.value = true;
  try {
    let saleId: string | undefined;
    if (to === 'shipped' && !o.saleId) saleId = recordShipment(o);
    const { order } = await api.setStatus(o.id, to, saleId);
    const next = props.orders.map((x) => (x.id === order.id ? order : x));
    if (!props.orders.some((x) => x.id === order.id)) next.push(order);
    await syncClaims(next).catch(() => {});
    if (!quiet) emit('changed');
  } catch (err) {
    error.value = errorText(err, 'Could not move the order on.');
  } finally {
    busy.value = false;
  }
}
async function remove(o: WholesaleOrder): Promise<void> {
  if (!(await sdk().ui.confirm(`Delete order #${o.number}?`, 'Delete order', { confirm: 'Delete' }))) return;
  try {
    await api.removeOrder(o.id);
    emit('changed');
  } catch (err) {
    error.value = errorText(err, 'Could not delete.');
  }
}
/** A packing slip the browser prints. */
async function slip(o: WholesaleOrder): Promise<void> {
  const c = customerOf(o.customerId);
  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
  const rows = o.lines.map((l) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.variantLabel ? `${l.title} · ${l.variantLabel}` : l.title)}</td><td class="n">${l.qty}</td><td class="n">${esc(fmtPrice(l.unitPrice, o.currency))}</td><td class="n">${esc(fmtPrice(Math.round(l.unitPrice * 100 * l.qty) / 100, o.currency))}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Order ${o.number}</title><style>body{font-family:system-ui,sans-serif;color:#111;margin:14mm}h1{font-size:16pt;margin:0 0 2mm}p{margin:0 0 1mm;font-size:10pt}table{width:100%;border-collapse:collapse;margin-top:6mm;font-size:10pt}th,td{text-align:left;padding:2mm 1mm;border-bottom:1px solid #ccc}.n{text-align:right}.tot{font-weight:700}</style></head><body>
  <h1>Order #${o.number} · ${esc(sdk().account()?.accountName ?? '')}</h1>
  <p>${esc(c?.company ?? '')}${c?.contact ? ` · ${esc(c.contact)}` : ''}</p><p>${esc(c?.address ?? '').replace(/\n/g, '<br>')}</p>
  <p>Ordered ${esc(when(o.createdAt))}${o.shippedAt ? ` · shipped ${esc(when(o.shippedAt))}` : ` · ships ${esc(o.expectedShipDate)}`}${c?.terms ? ` · ${esc(c.terms)}` : ''}</p>${o.note ? `<p>${esc(o.note)}</p>` : ''}
  <table><thead><tr><th>SKU</th><th>Item</th><th class="n">Qty</th><th class="n">Each</th><th class="n">Total</th></tr></thead><tbody>${rows}</tbody>
  <tfoot><tr class="tot"><td colspan="2">Total</td><td class="n">${orderTotals(o.lines).units}</td><td></td><td class="n">${esc(fmtPrice(orderTotals(o.lines).total, o.currency))}</td></tr></tfoot></table>
  <script>window.addEventListener('load',function(){setTimeout(function(){window.print()},150)})<\/script></body></html>`;
  if (!(await sdk().ui.openDocument(`order-${o.number}.html`, html, 'text/html'))) sdk().ui.toast('The print window was blocked - allow pop-ups for this site.', { kind: 'warning' });
}
</script>

<template>
  <div class="orders">
    <div class="bar">
      <button type="button" class="primary" :disabled="!customers.some((c) => !c.archived)" @click="start('new')">New order</button>
      <div class="chips" role="group" aria-label="Filter"><button v-for="f in FILTERS" :key="f.id" type="button" class="chip" :class="{ on: filter === f.id }" @click="filter = f.id">{{ f.label }}</button></div>
    </div>
    <p v-if="!customers.some((c) => !c.archived)" class="hint">Add a customer first, under Customers.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <form v-if="editing" class="card" @submit.prevent="save()">
      <div class="formhead"><h2>{{ editing === 'new' ? 'New order' : `Order #${editing.number}` }}</h2><button type="button" class="quiet" @click="editing = null">Close</button></div>
      <div class="grid">
        <label>Customer <select v-model="form.customerId" @change="onCustomer"><option v-for="c in customers.filter((x) => !x.archived || x.id === form.customerId)" :key="c.id" :value="c.id">{{ c.company }}</option></select></label>
        <label>Currency <input v-model="form.currency" type="text" maxlength="3" /></label>
        <label>Wanted by <input v-model="form.requestedDate" type="date" /></label>
        <label class="wide">Reference or note <input v-model="form.note" type="text" maxlength="2000" placeholder="Their PO number, what to pack it in" /></label>
      </div>
      <p v-if="customer?.discountPct" class="hint">{{ customer.company }} gets {{ customer.discountPct }}% off the tier price.</p>
      <div class="find">
        <input v-model="query" type="search" placeholder="Add an item by name or SKU" aria-label="Add an item" />
        <ul v-if="products.length" class="found">
          <li v-for="p in products" :key="p.id">
            <template v-if="p.variants.length"><span class="pt">{{ p.title }}</span><button v-for="v in p.variants" :key="v.id" type="button" class="quiet" @click="add(p, v.id)">{{ v.name }}</button></template>
            <button v-else type="button" class="quiet" @click="add(p, null)">{{ p.title }}</button>
          </li>
        </ul>
      </div>
      <p v-if="!form.lines.length" class="hint">No lines yet.</p>
      <div v-else class="table-scroll">
        <table>
          <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">In stock</th><th class="num">Each</th><th class="num">Total</th><th></th></tr></thead>
          <tbody>
            <tr v-for="(l, i) in form.lines" :key="i">
              <td>{{ l.title }}<span v-if="l.variantLabel" class="hint"> · {{ l.variantLabel }}</span></td>
              <td class="num"><input :value="l.qty" type="number" min="1" class="qty" @change="setQty(l, Number(($event.target as HTMLInputElement).value))" /></td>
              <td class="num" :class="{ bad: available(l) < l.qty }">{{ available(l) }}</td>
              <td class="num"><input v-model.number="l.unitPrice" type="number" min="0" step="0.01" class="price" /></td>
              <td class="num">{{ fmtPrice(Math.round(l.unitPrice * 100 * l.qty) / 100, form.currency) }}</td>
              <td><button type="button" class="quiet" @click="form.lines.splice(i, 1)">Remove</button></td>
            </tr>
          </tbody>
          <tfoot><tr><td><strong>Total</strong></td><td class="num">{{ formTotals.units }}</td><td></td><td></td><td class="num"><strong>{{ fmtPrice(formTotals.total, form.currency) }}</strong></td><td></td></tr></tfoot>
        </table>
      </div>
      <div class="actions">
        <button type="submit" class="primary" :disabled="busy">Save draft</button>
        <button v-if="editing === 'new' || editing.status === 'draft'" type="button" :disabled="busy || !form.lines.length" @click="save(true)">Save and confirm</button>
      </div>
    </form>

    <p v-if="!shown.length" class="hint">No orders here.</p>
    <ul v-else class="list">
      <li v-for="o in shown" :key="o.id" class="order">
        <div class="head">
          <span class="main"><strong>#{{ o.number }} · {{ customerOf(o.customerId)?.company ?? 'customer' }}</strong><span class="hint">{{ when(o.createdAt) }}{{ o.note ? ` · ${o.note}` : '' }}{{ o.status === 'confirmed' || o.status === 'packed' ? ` · ships ${o.expectedShipDate}` : '' }}{{ o.requestedDate ? ` · wanted by ${o.requestedDate}` : '' }}</span></span>
          <span class="side"><strong>{{ fmtPrice(orderTotals(o.lines).total, o.currency) }}</strong><span class="badge" :class="o.status">{{ ORDER_STATUS_LABEL[o.status] }}</span></span>
        </div>
        <p class="lines">{{ o.lines.map((l) => `${l.qty} × ${l.title}${l.variantLabel ? ` (${l.variantLabel})` : ''}`).join(', ') || 'no lines' }}</p>
        <div class="actions">
          <button v-if="isEditable(o.status)" type="button" @click="start(o)">Edit</button>
          <button v-for="s in nextOrderStatuses(o.status)" :key="s" type="button" :class="{ primary: s !== 'cancelled', danger: s === 'cancelled' }" :disabled="busy" @click="move(o, s)">{{ ORDER_STATUS_LABEL[s] }}</button>
          <button type="button" class="quiet" @click="slip(o)">Print slip</button>
          <button v-if="o.status === 'draft' || o.status === 'cancelled'" type="button" class="quiet danger" @click="remove(o)">Delete</button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.orders { display: flex; flex-direction: column; gap: .7rem; }
.bar { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; }
.chips { display: flex; gap: .3rem; flex-wrap: wrap; }
.chip { font-size: .78rem; padding: .2rem .6rem; border-radius: 999px; min-height: 0; }
.chip.on { background: var(--zfy-accent, #0e7c66); color: #fff; }
.hint { color: var(--zfy-muted, #5a6472); font-size: .84rem; margin: 0; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .6rem; }
.formhead { display: flex; justify-content: space-between; align-items: center; gap: .6rem; }
h2 { margin: 0; font-size: 1.05rem; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .875rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .6rem; }
.grid .wide { grid-column: 1 / -1; }
.find { position: relative; }
.find input { width: 100%; }
.found { position: absolute; z-index: 5; left: 0; right: 0; list-style: none; margin: .2rem 0 0; padding: .3rem; background: var(--zfy-surface, #fff); border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; display: flex; flex-direction: column; gap: .2rem; max-height: 16rem; overflow: auto; }
.found li { display: flex; gap: .3rem; flex-wrap: wrap; align-items: center; }
.pt { font-size: .875rem; padding: .2rem .4rem; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); font-size: .9rem; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); }
.num { text-align: right; }
.qty { width: 5rem; } .price { width: 6.5rem; }
.bad { color: var(--zfy-danger, #c6512f); font-weight: 600; }
.actions { display: flex; gap: .4rem; flex-wrap: wrap; }
.danger { color: var(--zfy-danger, #c6512f); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.order { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: .7rem .9rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .4rem; }
.head { display: flex; justify-content: space-between; gap: .6rem; }
.main, .side { display: flex; flex-direction: column; gap: .1rem; min-width: 0; }
.side { align-items: flex-end; text-align: right; flex: none; }
.lines { margin: 0; font-size: .9rem; }
.badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; border-radius: 999px; padding: .1rem .55rem; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); white-space: nowrap; }
.badge.draft { background: #e5e7eb; color: #374151; }
.badge.cancelled { background: #fee2e2; color: #991b1b; }
.badge.paid { background: #dbeafe; color: #1e40af; }
</style>
