<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { CostBatch, CostSource, Product } from '@zollify/shared';
import { fmtPrice } from '@zollify/shared';
import { Icon, ModalShell, typeColor } from '@zollify/ui';
import { computeBatch, resolveCurrentCosts } from '../costs';
import { costsDb } from '../state';
import { sdk } from '../runtime';

/**
 * Cost batches - ZollTool's editor. Record a shipment: its total (production,
 * import, shipping, often billed separately) and how many of each item
 * arrived. The total is spread across the units and written onto the products
 * as per-unit cost. A later batch simply updates it; editing an old one only
 * changes a product's cost when that batch is still its latest source.
 */

interface CostRow {
  pid: string;
  vid: string;
  type: string;
  label: string;
  price: number;
  curCost?: number;
  qty: string;
  unitCost: string;
}

const batches = ref<CostBatch[]>([]);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const currency = computed(() => sdk().account()?.profile.defaultCurrency ?? 'CHF');
const products = computed(() => sdk().data.products.list());

const priceOf = (pid: string, vid: string): number => {
  const p = products.value.find((x) => x.id === pid);
  if (!p) return 0;
  const v = vid ? p.variants.find((x) => x.id === vid) : undefined;
  return v?.price ?? p.price ?? 0;
};

async function load(): Promise<void> {
  batches.value = (await costsDb().batches.toArray()).filter((b) => !b.deletedAt).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.updatedAt - a.updatedAt);
}
onMounted(load);

/** Writes each product's current per-unit cost from all batches; syncs with the product. */
async function applyCosts(all: CostBatch[]): Promise<void> {
  const byPid = new Map<string, Map<string, number>>();
  for (const c of resolveCurrentCosts(all, priceOf)) (byPid.get(c.pid) ?? byPid.set(c.pid, new Map()).get(c.pid)!).set(c.vid, c.cost);
  for (const [pid, vmap] of byPid) {
    const product = sdk().data.products.get(pid);
    if (!product) continue;
    const next: Product = { ...product };
    let changed = false;
    if (vmap.has('') && next.cost !== vmap.get('')) {
      next.cost = vmap.get('');
      changed = true;
    }
    next.variants = product.variants.map((v) => {
      const c = vmap.get(v.id);
      if (c == null || v.cost === c) return v;
      changed = true;
      return { ...v, cost: c };
    });
    if (changed) await sdk().data.products.upsert(next);
  }
}

// ── Editor ──────────────────────────────────────────────────────────────────
const editing = ref(false);
const editId = ref<string | null>(null);
const form = reactive({ date: '', note: '', weighting: 'value' as 'even' | 'value' });
const sources = ref<{ id: string; label: string; amount: string; kind: CostSource['kind']; ref?: string }[]>([]);
const rows = ref<CostRow[]>([]);

const total = computed(() => sources.value.reduce((s, x) => s + (parseFloat(x.amount) || 0), 0));
function addSource(): void {
  sources.value.push({ id: crypto.randomUUID(), label: '', amount: '', kind: 'manual' });
}

function buildRows(): CostRow[] {
  const out: CostRow[] = [];
  for (const p of products.value) {
    const type = p.type?.trim() || 'Other';
    if (p.variants.length) for (const v of p.variants) out.push({ pid: p.id, vid: v.id, type, label: `${p.title || '(untitled)'} · ${v.name || v.id}`, price: v.price ?? p.price, curCost: v.cost ?? p.cost, qty: '', unitCost: '' });
    else out.push({ pid: p.id, vid: '', type, label: p.title || '(untitled)', price: p.price, curCost: p.cost, qty: '', unitCost: '' });
  }
  return out;
}
function open(batch?: CostBatch): void {
  editId.value = batch?.id ?? null;
  const next = buildRows();
  if (batch) {
    for (const r of next) {
      const l = batch.lines.find((x) => x.pid === r.pid && x.vid === r.vid);
      if (l) {
        r.qty = String(l.qty);
        r.unitCost = l.unitCost != null ? String(l.unitCost) : '';
      }
    }
    Object.assign(form, { date: batch.date, note: batch.note ?? '', weighting: batch.weighting });
    sources.value = batch.sources?.length ? batch.sources.map((s) => ({ ...s, amount: String(s.amount) })) : [{ id: crypto.randomUUID(), label: 'Cost', amount: String(batch.total), kind: 'manual' }];
  } else {
    Object.assign(form, { date: new Date().toISOString().slice(0, 10), note: '', weighting: 'value' });
    sources.value = [{ id: crypto.randomUUID(), label: '', amount: '', kind: 'manual' }];
  }
  rows.value = next;
  error.value = null;
  editing.value = true;
}

const groups = computed(() => {
  const m = new Map<string, CostRow[]>();
  for (const r of rows.value) (m.get(r.type) ?? m.set(r.type, []).get(r.type)!).push(r);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([type, list]) => ({ type, rows: list }));
});
const draft = computed<CostBatch>(() => ({
  id: editId.value ?? 'draft',
  date: form.date,
  note: form.note,
  total: total.value,
  sources: sources.value.filter((s) => parseFloat(s.amount) > 0 || s.label.trim()).map((s) => ({ id: s.id, label: s.label.trim() || 'Cost', amount: parseFloat(s.amount) || 0, kind: s.kind, ref: s.ref })),
  weighting: form.weighting,
  lines: rows.value.filter((r) => parseInt(r.qty) > 0).map((r) => ({ pid: r.pid, vid: r.vid, qty: parseInt(r.qty) || 0, unitCost: r.unitCost.trim() ? parseFloat(r.unitCost) || 0 : undefined })),
  updatedAt: 0,
}));
const computation = computed(() => computeBatch(draft.value, priceOf));
const finalMap = computed(() => new Map(computation.value.lines.map((l) => [`${l.pid}:${l.vid}`, l.final])));

async function apply(): Promise<void> {
  if (!computation.value.lines.length || total.value <= 0) {
    error.value = 'Add quantities and at least one cost first.';
    return;
  }
  error.value = null;
  try {
    const batch: CostBatch = { ...draft.value, id: editId.value ?? crypto.randomUUID(), currency: currency.value, updatedAt: Date.now() };
    await costsDb().batches.put(JSON.parse(JSON.stringify(batch)));
    await load();
    await applyCosts(batches.value);
    editing.value = false;
    notice.value = editId.value ? 'Batch updated.' : `Costs updated - ${computation.value.lines.length} line${computation.value.lines.length === 1 ? '' : 's'}.`;
    setTimeout(() => (notice.value = null), 2500);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the batch.';
  }
}
async function remove(b: CostBatch): Promise<void> {
  if (!(await sdk().ui.confirm(`Remove the batch from ${b.date}? Product costs are recomputed from the batches that remain.`, 'Remove batch?'))) return;
  await costsDb().batches.delete(b.id);
  await load();
  await applyCosts(batches.value);
  if (editId.value === b.id) editing.value = false;
}

/** Margin view: what every item costs against what it sells for. */
const marginRows = computed(() =>
  products.value.flatMap((p) => {
    const type = p.type?.trim() || 'Other';
    const line = (label: string, price: number, cost?: number) => ({ key: `${p.id}:${label}`, type, label, price, cost, margin: cost != null && price > 0 ? Math.round(((price - cost) / price) * 100) : null });
    return p.variants.length ? p.variants.map((v) => line(`${p.title} · ${v.name}`, v.price ?? p.price, v.cost ?? p.cost)) : [line(p.title, p.price, p.cost)];
  }),
);
const withCost = computed(() => marginRows.value.filter((r) => r.cost != null).length);
</script>

<template>
  <section class="costs">
    <header>
      <div>
        <h1>Costs</h1>
        <p class="hint">Spread a shipment's total across the items that arrived; each product gets a per-unit cost. {{ withCost }} of {{ marginRows.length }} items have one.</p>
      </div>
      <button type="button" class="primary" @click="open()"><Icon name="plus" :size="16" /> New batch</button>
    </header>
    <p v-if="error && !editing" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="ok" role="status">{{ notice }}</p>

    <article class="card">
      <h2>Batches</h2>
      <p v-if="!batches.length" class="hint">No batches yet. Record the last order that arrived - production plus import plus shipping - and the per-unit costs follow.</p>
      <ul v-else class="batches">
        <li v-for="b in batches" :key="b.id">
          <button type="button" class="row" @click="open(b)">
            <strong>{{ b.date }}</strong>
            <span>{{ b.note || `${b.lines.length} line${b.lines.length === 1 ? '' : 's'}` }} · {{ b.weighting === 'value' ? 'by value' : 'evenly' }}</span>
            <em>{{ fmtPrice(b.total, b.currency || currency) }}</em>
          </button>
          <button type="button" class="quiet danger" @click="remove(b)">Remove</button>
        </li>
      </ul>
      <p class="hint">Batches stay on this device; the costs they set travel with the products to every device.</p>
    </article>

    <article class="card">
      <h2>Margins</h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Item</th><th>Sells</th><th>Costs</th><th>Margin</th></tr></thead>
          <tbody>
            <tr v-for="r in marginRows" :key="r.key">
              <td class="name"><span class="dot" :style="{ background: typeColor(r.type) }"></span>{{ r.label }}</td>
              <td>{{ fmtPrice(r.price, currency) }}</td>
              <td :class="{ muted: r.cost == null }">{{ r.cost != null ? fmtPrice(r.cost, currency) : '-' }}</td>
              <td :class="r.margin == null ? 'muted' : r.margin < 30 ? 'bad' : r.margin < 50 ? 'warn' : 'good'">{{ r.margin == null ? '-' : `${r.margin}%` }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>

    <ModalShell v-if="editing" :title="editId ? 'Edit cost batch' : 'Cost batch'" wide @close="editing = false">
      <div class="form">
        <p class="hint">Enter the shipment's costs and how many of each item arrived. The total is spread across the units. Enter a per-item cost on a row if you already know it - the rest is spread over the others.</p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div class="three">
          <label><span>Date</span><input v-model="form.date" type="date" /></label>
          <label>
            <span>Spread by</span>
            <select v-model="form.weighting"><option value="value">Item value</option><option value="even">Evenly per unit</option></select>
          </label>
          <label><span>Note</span><input v-model="form.note" type="text" placeholder="Spring order" /></label>
        </div>

        <fieldset>
          <legend>Cost sources ({{ currency }}) <em>{{ fmtPrice(total, currency) }}</em></legend>
          <div v-for="s in sources" :key="s.id" class="source">
            <input v-model="s.label" type="text" placeholder="Production, import, shipping…" aria-label="Cost label" />
            <input v-model="s.amount" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" aria-label="Amount" />
            <button type="button" class="quiet" aria-label="Remove cost" @click="sources = sources.filter((x) => x.id !== s.id)"><Icon name="x" :size="14" /></button>
          </div>
          <button type="button" class="quiet add" @click="addSource">+ Add cost</button>
        </fieldset>

        <section v-for="g in groups" :key="g.type" class="group">
          <h3 :style="{ color: typeColor(g.type) }">{{ g.type }}</h3>
          <ul>
            <li v-for="r in g.rows" :key="r.pid + ':' + r.vid">
              <span class="main"><span class="label">{{ r.label }}</span><small>sells {{ fmtPrice(r.price, currency) }}<template v-if="r.curCost != null"> · cost now {{ fmtPrice(r.curCost, currency) }}</template></small></span>
              <input v-model="r.qty" type="number" min="0" inputmode="numeric" placeholder="Qty" aria-label="Quantity" class="qty" />
              <input v-model="r.unitCost" type="number" min="0" step="0.01" inputmode="decimal" placeholder="each" aria-label="Known unit cost" class="unit" />
              <strong :class="finalMap.has(r.pid + ':' + r.vid) ? 'good' : 'muted'">{{ finalMap.has(r.pid + ':' + r.vid) ? fmtPrice(finalMap.get(r.pid + ':' + r.vid) ?? 0, currency) : '-' }}</strong>
            </li>
          </ul>
        </section>
      </div>
      <template #footer>
        <div class="footer">
          <span :class="['alloc', { warn: Math.abs(computation.allocated - total) >= 0.02 }]">Allocates {{ fmtPrice(computation.allocated, currency) }} of {{ fmtPrice(total, currency) }} · {{ computation.lines.length }} item{{ computation.lines.length === 1 ? '' : 's' }}</span>
          <button type="button" @click="editing = false">Cancel</button>
          <button type="button" class="primary" :disabled="!computation.lines.length" @click="apply">{{ editId ? 'Update batch' : 'Apply costs' }}</button>
        </div>
      </template>
    </ModalShell>
  </section>
</template>

<style scoped>
.costs { display: flex; flex-direction: column; gap: 1rem; max-width: 60rem; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: .95rem; }
h3 { margin: 0 0 .3rem; font-size: .85rem; }
header .primary { display: inline-flex; align-items: center; gap: .4rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .85rem; }
.muted { color: var(--zfy-muted, #5a6472); }
.good { color: var(--zfy-accent-ink, #0a5a4a); }
.warn { color: var(--zfy-warning-ink, #8a5a1e); }
.bad { color: var(--zfy-danger, #c6512f); }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .8rem 1rem; display: flex; flex-direction: column; gap: .6rem; }
.batches { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.batches li { display: flex; align-items: center; gap: .5rem; }
.row { flex: 1; display: flex; align-items: center; gap: .6rem; text-align: left; padding: .45rem .7rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; background: var(--zfy-bg, #f1f4f6); font-weight: 400; }
.row span { flex: 1; min-width: 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row em { font-style: normal; font-weight: 600; font-variant-numeric: tabular-nums; }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .85rem; font-variant-numeric: tabular-nums; }
th { text-align: right; font-weight: 500; font-size: .72rem; color: var(--zfy-muted, #5a6472); padding: .3rem .6rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
td { text-align: right; padding: .3rem .6rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
th:first-child, td.name { text-align: left; }
tr:last-child td { border-bottom: 0; }
.dot { display: inline-block; width: .5rem; height: .5rem; border-radius: 50%; margin-right: .4rem; }
.form { display: flex; flex-direction: column; gap: .7rem; }
.three { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .6rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .4rem; background: var(--zfy-bg, #f1f4f6); }
legend { font-size: .8rem; font-weight: 600; padding: 0 .3rem; }
legend em { font-style: normal; margin-left: .5rem; }
.source { display: grid; grid-template-columns: 1fr 7rem auto; gap: .4rem; }
.source .quiet { min-height: 1.8rem; padding: 0 .4rem; }
.add { align-self: flex-start; color: var(--zfy-accent-ink, #0a5a4a); font-size: .8rem; min-height: 1.6rem; padding: 0 .3rem; }
.group ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; overflow: hidden; }
.group li { display: flex; align-items: center; gap: .5rem; padding: .35rem .6rem; }
.group li + li { border-top: 1px solid var(--zfy-line, #d6dde4); }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.label { font-size: .875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main small { color: var(--zfy-muted, #5a6472); font-size: .72rem; }
.qty { width: 4.5rem; min-height: 1.9rem; padding: .1rem .4rem; text-align: right; }
.unit { width: 5.5rem; min-height: 1.9rem; padding: .1rem .4rem; text-align: right; }
.group strong { width: 6rem; text-align: right; font-variant-numeric: tabular-nums; }
.footer { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.alloc { flex: 1; font-size: .8rem; color: var(--zfy-muted, #5a6472); }
.alloc.warn { color: var(--zfy-warning-ink, #8a5a1e); }
</style>
