<script setup lang="ts">
import { computed, ref } from 'vue';
import { fmtPrice, localIsoDay } from '@zollify/shared';
import { Icon, ModalShell } from '@zollify/ui';
import { materialOnHand, materialTotals, outstandingOf, pricePerUnit, receivedOf, recipeCostChanges, type CostChange, type Material, type MaterialUse, type Purchase } from '../engine';
import { countMaterial, dropUse, remove, save, snap, useMaterial } from '../api';
import { sdk } from '../runtime';
import PrinterKeys from './PrinterKeys.vue';

/**
 * Materials - home-print consumables. Paper, ink, packaging: log what you
 * buy, and each material's unit cost is the weighted average of everything
 * bought. A dossier's recipe turns those into a cost per print.
 */
const emit = defineEmits<{ error: [message: string] }>();
const currency = computed(() => sdk().account()?.profile.defaultCurrency ?? 'CHF');
const list = computed(() => [...snap.value.materials].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)));
const editing = ref<Material | null>(null);
const buying = ref<Material | null>(null);
const purchase = ref({ qty: '', inPacks: false, cost: '', date: localIsoDay(), note: '', allArrived: true, arrived: '' });
function openNew(): void {
  editing.value = { id: crypto.randomUUID(), name: '', type: 'paper', unit: 'sheet', description: '', purchases: [] };
}
async function saveMaterial(): Promise<void> {
  if (!editing.value?.name.trim()) return emit('error', 'A material needs a name.');
  try {
    const { lowAt, packSize, packName, ...rest } = editing.value;
    const mark = Number(lowAt);
    const pack = Number(packSize);
    await save('materials', {
      ...rest,
      name: rest.name.trim(),
      unit: rest.unit.trim() || 'unit',
      ...(lowAt !== undefined && String(lowAt) !== '' && mark >= 0 ? { lowAt: mark } : {}),
      ...(pack > 1 ? { packSize: pack, packName: packName?.trim() || 'box' } : {}),
    });
    editing.value = null;
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not save the material.');
  }
}
// ── Product costs from recipes, at today's material prices ──────────────────
/** The cost on the catalogue product (or variant); undefined when it is gone. */
function productCost(pid: string, vid: string | null): number | null | undefined {
  const p = sdk().data.products.get(pid);
  if (!p) return undefined;
  if (vid) {
    const v = p.variants.find((x) => x.id === vid);
    return v ? (v.cost ?? null) : undefined;
  }
  return p.cost ?? null;
}
const costChanges = computed(() => recipeCostChanges(snap.value.dossiers, snap.value.materials, productCost));
const reviewing = ref<CostChange[] | null>(null);
async function applyCosts(): Promise<void> {
  const changes = reviewing.value ?? [];
  try {
    for (const c of changes) {
      const p = sdk().data.products.get(c.pid);
      if (!p) continue;
      await sdk().data.products.upsert(c.vid ? { ...p, variants: p.variants.map((v) => (v.id === c.vid ? { ...v, cost: c.now } : v)) } : { ...p, cost: c.now });
    }
    sdk().ui.toast(`Cost updated on ${changes.length} product${changes.length === 1 ? '' : 's'}.`, { kind: 'success' });
    reviewing.value = null;
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not update the product costs.');
  }
}

// ── Packs: a box of 25 sheets, typed as boxes and kept as sheets ────────────
const packs = (m: Material) => (m.packSize && m.packSize > 1 ? m.packSize : 0);
const packName = (m: Material) => m.packName || 'box';
/** "boxes", "reams", "packs". */
const packPlural = (m: Material) => (/(s|x|z|sh|ch)$/i.test(packName(m)) ? `${packName(m)}es` : `${packName(m)}s`);
/** "75 sheets (3 boxes)" when it comes in packs and fills whole ones. */
function amount(m: Material, n: number): string {
  const per = packs(m);
  if (!per || n <= 0 || n % per !== 0) return plural(n, m.unit);
  const k = n / per;
  return `${plural(n, m.unit)} (${k} ${k === 1 ? packName(m) : packPlural(m)})`;
}
const toUnits = (m: Material, value: number, inPacks: boolean) => (inPacks && packs(m) ? value * packs(m) : value);

function openBuy(m: Material): void {
  buying.value = m;
  purchase.value = { qty: '', inPacks: !!packs(m), cost: '', date: localIsoDay(), note: '', allArrived: true, arrived: '' };
}
async function logPurchase(): Promise<void> {
  const m = buying.value;
  const f = purchase.value;
  const qty = toUnits(m!, parseFloat(f.qty), f.inPacks);
  const cost = parseFloat(f.cost);
  if (!m || !(qty > 0) || !(cost >= 0)) return emit('error', 'Quantity and cost are required.');
  // Part of it arrived (or none yet): the rest is on order until it is received.
  const arrived = f.allArrived ? qty : toUnits(m, parseFloat(f.arrived) || 0, f.inPacks);
  if (arrived > qty) return emit('error', 'More arrived than was ordered - log the order bigger.');
  const next: Purchase = { id: crypto.randomUUID(), qty, cost, date: f.date, note: f.note };
  if (!f.allArrived) next.deliveries = arrived > 0 ? [{ id: crypto.randomUUID(), qty: arrived, date: f.date }] : [];
  try {
    await save('materials', { ...m, purchases: [...m.purchases, next] });
    buying.value = null;
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not log the purchase.');
  }
}

// ── Deliveries of an order that came in parts ───────────────────────────────
const receiving = ref<{ m: Material; p: Purchase; qty: string; inPacks: boolean; date: string } | null>(null);
function openReceive(m: Material, p: Purchase): void {
  const left = outstandingOf(p);
  const per = packs(m);
  const inPacks = !!per && left % per === 0;
  receiving.value = { m, p, qty: String(inPacks ? left / per : left), inPacks, date: localIsoDay() };
}
async function logDelivery(): Promise<void> {
  const r = receiving.value;
  if (!r) return;
  const qty = toUnits(r.m, parseFloat(r.qty), r.inPacks);
  if (!(qty > 0)) return emit('error', 'How many arrived?');
  if (qty > outstandingOf(r.p) + 1e-9) return emit('error', `Only ${amount(r.m, outstandingOf(r.p))} is still to come on this order.`);
  const purchases = r.m.purchases.map((p) => (p.id === r.p.id ? { ...p, deliveries: [...(p.deliveries ?? []), { id: crypto.randomUUID(), qty, date: r.date }] } : p));
  try {
    await save('materials', { ...r.m, purchases });
    receiving.value = null;
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not log the delivery.');
  }
}
/** The supplier will never send the rest: the order becomes what arrived, refunded at the price paid per unit. */
async function closeShort(m: Material, p: Purchase): Promise<void> {
  const got = receivedOf(p);
  const ok = await sdk().ui.confirm(
    `The order becomes the ${amount(m, got)} that arrived, and its cost ${fmtPrice(Math.round(((p.cost * got) / p.qty) * 100) / 100, currency.value)} - the same price per ${m.unit}, as if the rest was refunded. Edit the note if it was not.`,
    'The rest is not coming?',
    { confirm: 'Close the order' },
  );
  if (!ok) return;
  const purchases = m.purchases.map((x) => (x.id === p.id ? { ...x, qty: got, cost: Math.round(((x.cost * got) / x.qty) * 100) / 100, note: [x.note, `closed short: ${amount(m, x.qty - got)} never came`].filter(Boolean).join(' · ') } : x));
  try {
    await save('materials', { ...m, purchases });
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not close the order.');
  }
}
const dropPurchase = (m: Material, id: string) => save('materials', { ...m, purchases: m.purchases.filter((p) => p.id !== id) });
const usedBy = (m: Material) => snap.value.dossiers.filter((d) => d.recipe.some((r) => r.materialId === m.id)).length;
const sorted = (m: Material) => [...m.purchases].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

// ── On hand: bought less used, by hand, by the printing app, or by a recount ─
const usageOf = (m: Material) => snap.value.usage?.[m.id];
const onHand = (m: Material) => materialOnHand(m, usageOf(m));
const low = (m: Material) => typeof m.lowAt === 'number' && onHand(m) <= m.lowAt;
const SOURCE: Record<MaterialUse['source'], string> = { manual: 'Used', printer: 'Printed', count: 'Recount' };
const useText = (u: MaterialUse, m: Material) => (u.source === 'count' ? (u.qty > 0 ? `${plural(u.qty, m.unit)} fewer` : `${plural(-u.qty, m.unit)} more`) : plural(u.qty, m.unit));
const stamp = (t: number) => new Date(t).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const using = ref<{ m: Material; mode: 'use' | 'count'; qty: string; note: string } | null>(null);
function openUse(m: Material, mode: 'use' | 'count'): void {
  using.value = { m, mode, qty: mode === 'count' ? String(onHand(m)) : '', note: '' };
}
async function logUse(): Promise<void> {
  const u = using.value;
  if (!u) return;
  const qty = parseFloat(u.qty);
  if (u.mode === 'use' ? !(qty > 0) : !(qty >= 0)) return emit('error', u.mode === 'use' ? 'How many were used?' : 'How many are there?');
  try {
    if (u.mode === 'use') await useMaterial(u.m.id, qty, u.note.trim() || undefined);
    else await countMaterial(u.m.id, qty);
    using.value = null;
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not save that.');
  }
}
async function undoUse(u: MaterialUse): Promise<void> {
  try {
    await dropUse(u.id);
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not remove that.');
  }
}
</script>

<template>
  <div class="tab">
    <div class="tools">
      <p class="hint">Unit cost = total spent ÷ total units ordered, so it follows the price of every order. Give a dossier a recipe and its cost per print follows - and when prices move, update the products' costs from here.</p>
      <span class="spacer"></span>
      <button v-if="costChanges.length" type="button" @click="reviewing = costChanges">Update {{ costChanges.length }} product cost{{ costChanges.length === 1 ? '' : 's' }}</button>
      <button type="button" class="primary" @click="openNew"><Icon name="plus" :size="14" /> New material</button>
    </div>
    <p v-if="!list.length" class="empty">No materials yet. Start with the paper you print on.</p>
    <article v-for="m in list" :key="m.id" class="card">
      <div class="head">
        <span class="main"><strong>{{ m.name }}<em>{{ m.type }}</em></strong><small>{{ plural(materialTotals(m).qty, m.unit) }} ordered<template v-if="materialTotals(m).onOrder"> · <span class="onorder">{{ amount(m, materialTotals(m).onOrder) }} still to come</span></template> · {{ fmtPrice(materialTotals(m).spent, currency) }} spent · used by {{ usedBy(m) }} recipe{{ usedBy(m) === 1 ? '' : 's' }}</small></span>
        <span :class="['unit', 'hand', { low: low(m) }]"><strong>{{ onHand(m) }}</strong><small>{{ m.unit }}s on hand{{ low(m) ? ' · low' : '' }}</small></span>
        <span class="unit"><strong>{{ fmtPrice(materialTotals(m).unitCost, currency) }}</strong><small>per {{ m.unit }}</small></span>
        <button type="button" @click="openBuy(m)"><Icon name="plus" :size="14" /> Purchase</button>
        <button type="button" @click="openUse(m, 'use')">Use</button>
        <button type="button" class="quiet" @click="openUse(m, 'count')">Count</button>
        <button type="button" class="quiet" @click="editing = { ...m }">Edit</button>
        <button type="button" class="quiet danger" @click="remove('materials', m.id)">Remove</button>
      </div>
      <ul v-if="m.purchases.length" class="purchases">
        <li v-for="p in sorted(m)" :key="p.id" :class="{ waiting: outstandingOf(p) > 0, parts: !!p.deliveries }">
          <span>{{ p.date || '-' }}</span><span>{{ amount(m, p.qty) }}</span>
          <span class="price">{{ fmtPrice(p.cost, currency) }}<small>{{ fmtPrice(pricePerUnit(p), currency) }}/{{ m.unit }}<template v-if="packs(m)"> · {{ fmtPrice(pricePerUnit(p) * packs(m), currency) }}/{{ packName(m) }}</template></small></span>
          <span class="muted">
            <template v-if="p.deliveries">
              <span class="got">{{ amount(m, receivedOf(p)) }} arrived<template v-if="outstandingOf(p) > 0">, {{ amount(m, outstandingOf(p)) }} to come</template></span>
              <template v-for="d in p.deliveries" :key="d.id"> · {{ d.date }} +{{ d.qty }}</template>
            </template>
            <template v-if="p.note">{{ p.deliveries ? ' · ' : '' }}{{ p.note }}</template>
          </span>
          <span class="acts">
            <button v-if="outstandingOf(p) > 0" type="button" class="receive" @click="openReceive(m, p)">Received</button>
            <button v-if="outstandingOf(p) > 0" type="button" class="quiet" @click="closeShort(m, p)">Rest not coming</button>
            <button type="button" class="quiet" aria-label="Remove purchase" @click="dropPurchase(m, p.id)"><Icon name="x" :size="12" /></button>
          </span>
        </li>
      </ul>
      <ul v-if="usageOf(m)?.recent.length" class="purchases uses">
        <li v-for="u in usageOf(m)!.recent" :key="u.id">
          <span>{{ stamp(u.at) }}</span><span :class="['src', u.source]">{{ SOURCE[u.source] }}</span><span>{{ useText(u, m) }}</span><span class="muted">{{ u.note }}</span>
          <button type="button" class="quiet" aria-label="Remove this use" @click="undoUse(u)"><Icon name="x" :size="12" /></button>
        </li>
      </ul>
    </article>

    <PrinterKeys @error="emit('error', $event)" />

    <ModalShell v-if="editing" title="Material" @close="editing = null">
      <div class="form">
        <label><span>Name</span><input v-model="editing.name" type="text" placeholder="Hahnemühle A3" /></label>
        <div class="two">
          <label>
            <span>Type</span>
            <select v-model="editing.type"><option value="paper">Paper</option><option value="ink">Ink</option><option value="packaging">Packaging</option><option value="other">Other</option></select>
          </label>
          <label><span>Unit</span><input v-model="editing.unit" type="text" placeholder="sheet, ml, sleeve" /></label>
        </div>
        <label><span>Description</span><input v-model="editing.description" type="text" /></label>
        <div class="two">
          <label><span>Comes in packs of (optional)</span><input v-model.number="editing.packSize" type="number" min="2" step="1" inputmode="numeric" placeholder="25" /></label>
          <label><span>Pack is called</span><input v-model="editing.packName" type="text" maxlength="20" placeholder="box" /></label>
        </div>
        <label><span>Running low at ({{ editing.unit || 'unit' }}s on hand, optional)</span><input v-model.number="editing.lowAt" type="number" min="0" step="1" inputmode="numeric" placeholder="e.g. 20" /></label>
      </div>
      <template #footer><div class="footer"><span class="spacer"></span><button type="button" @click="editing = null">Cancel</button><button type="button" class="primary" @click="saveMaterial">Save</button></div></template>
    </ModalShell>

    <ModalShell v-if="buying" :title="`Purchase · ${buying.name}`" @close="buying = null">
      <div class="form">
        <div class="two">
          <label>
            <span>Ordered</span>
            <span class="qty">
              <input v-model="purchase.qty" type="number" min="0" step="0.01" inputmode="decimal" />
              <select v-if="packs(buying)" v-model="purchase.inPacks" aria-label="Counted in"><option :value="true">{{ packPlural(buying) }} of {{ buying.packSize }}</option><option :value="false">{{ buying.unit }}s</option></select>
              <small v-else>{{ buying.unit }}s</small>
            </span>
          </label>
          <label><span>Total cost ({{ currency }})</span><input v-model="purchase.cost" type="number" min="0" step="0.01" inputmode="decimal" /></label>
        </div>
        <label class="check"><input v-model="purchase.allArrived" type="checkbox" /> <span>All of it arrived</span></label>
        <label v-if="!purchase.allArrived">
          <span>Arrived so far ({{ purchase.inPacks && packs(buying) ? packPlural(buying) : `${buying.unit}s` }}) - log the rest under Received when it comes</span>
          <input v-model="purchase.arrived" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0" />
        </label>
        <div class="two">
          <label><span>Date</span><input v-model="purchase.date" type="date" /></label>
          <label><span>Note</span><input v-model="purchase.note" type="text" /></label>
        </div>
      </div>
      <template #footer><div class="footer"><span class="spacer"></span><button type="button" @click="buying = null">Cancel</button><button type="button" class="primary" @click="logPurchase">Log purchase</button></div></template>
    </ModalShell>

    <ModalShell v-if="reviewing" title="Product costs from recipes" @close="reviewing = null">
      <div class="form">
        <p class="hint">These products' recipes cost something else at today's material prices. Updating writes the new cost onto each product, where margins and the books read it.</p>
        <ul class="changes">
          <li v-for="c in reviewing" :key="c.dossierId"><span>{{ c.title }}</span><span class="muted">{{ c.was === null ? 'no cost yet' : fmtPrice(c.was, currency) }}</span><span>→</span><strong>{{ fmtPrice(c.now, currency) }}</strong></li>
        </ul>
      </div>
      <template #footer><div class="footer"><span class="spacer"></span><button type="button" @click="reviewing = null">Cancel</button><button type="button" class="primary" @click="applyCosts">Update costs</button></div></template>
    </ModalShell>

    <ModalShell v-if="receiving" :title="`Received · ${receiving.m.name}`" @close="receiving = null">
      <div class="form">
        <p class="hint">Still to come on this order: {{ amount(receiving.m, outstandingOf(receiving.p)) }}.</p>
        <div class="two">
          <label>
            <span>Arrived</span>
            <span class="qty">
              <input v-model="receiving.qty" type="number" min="0" step="0.01" inputmode="decimal" />
              <select v-if="packs(receiving.m)" v-model="receiving.inPacks" aria-label="Counted in"><option :value="true">{{ packPlural(receiving.m) }}</option><option :value="false">{{ receiving.m.unit }}s</option></select>
              <small v-else>{{ receiving.m.unit }}s</small>
            </span>
          </label>
          <label><span>Date</span><input v-model="receiving.date" type="date" /></label>
        </div>
      </div>
      <template #footer><div class="footer"><span class="spacer"></span><button type="button" @click="receiving = null">Cancel</button><button type="button" class="primary" @click="logDelivery">Log delivery</button></div></template>
    </ModalShell>

    <ModalShell v-if="using" :title="`${using.mode === 'use' ? 'Use' : 'Count'} · ${using.m.name}`" @close="using = null">
      <div class="form">
        <p class="hint">{{ using.mode === 'use' ? 'Paper used by hand - a print run, a misprint. The printing app logs its own prints.' : `What is really there. The books say ${onHand(using.m)}; the difference is logged as a recount.` }}</p>
        <div class="two">
          <label><span>{{ using.mode === 'use' ? 'Used' : 'On hand' }} ({{ using.m.unit }}s)</span><input v-model="using.qty" type="number" min="0" step="1" inputmode="decimal" /></label>
          <label v-if="using.mode === 'use'"><span>Note</span><input v-model="using.note" type="text" maxlength="200" /></label>
        </div>
      </div>
      <template #footer><div class="footer"><span class="spacer"></span><button type="button" @click="using = null">Cancel</button><button type="button" class="primary" @click="logUse">{{ using.mode === 'use' ? 'Log use' : 'Save count' }}</button></div></template>
    </ModalShell>
  </div>
</template>

<style scoped>
.tab { display: flex; flex-direction: column; gap: .8rem; }
.tools { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.tools .primary, .head button { display: inline-flex; align-items: center; gap: .35rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; max-width: 60ch; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .6rem .9rem; display: flex; flex-direction: column; gap: .4rem; }
.head { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.main em { font-style: normal; font-weight: 500; font-size: .66rem; margin-left: .35rem; padding: .05rem .35rem; border-radius: 4px; background: var(--zfy-bg, #f1f4f6); color: var(--zfy-muted, #5a6472); vertical-align: middle; }
.main small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
.unit { display: flex; flex-direction: column; align-items: flex-end; font-variant-numeric: tabular-nums; }
.unit small { color: var(--zfy-muted, #5a6472); font-size: .7rem; }
.head button { min-height: 2.2rem; padding: .2rem .6rem; font-size: .78rem; }
.purchases { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .15rem; font-size: .8rem; }
.purchases li { display: grid; grid-template-columns: 6rem 9rem 9rem 1fr auto; gap: .5rem; align-items: center; padding: .2rem .4rem; border-radius: 6px; background: var(--zfy-bg, #f1f4f6); font-variant-numeric: tabular-nums; }
.purchases li.waiting { box-shadow: inset 3px 0 0 var(--zfy-warning, #d9942b); }
/* An order's deliveries are worth reading in full, not cut off like a long note. */
.purchases li.parts .muted { white-space: normal; }
.got { color: var(--zfy-ink, #1a2230); }
.onorder { color: var(--zfy-warning-ink, #8a5a12); font-weight: 600; }
.acts { display: flex; align-items: center; gap: .2rem; }
.price { display: flex; flex-direction: column; }
.price small { color: var(--zfy-muted, #5a6472); font-size: .7rem; }
.changes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; font-size: .875rem; }
.changes li { display: grid; grid-template-columns: 1fr auto auto auto; gap: .5rem; align-items: center; font-variant-numeric: tabular-nums; }
.acts .receive { min-height: 2rem; padding: .1rem .5rem; font-size: .74rem; }
.acts .quiet { font-size: .74rem; }
.qty { display: flex; gap: .4rem; align-items: center; }
.qty input { flex: 1; min-width: 0; }
.qty small { color: var(--zfy-muted, #5a6472); }
.check { flex-direction: row; align-items: center; gap: .4rem; }
.purchases .quiet { min-height: 2.2rem; padding: 0 .3rem; }
.muted { color: var(--zfy-muted, #5a6472); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hand { min-width: 5rem; }
.hand.low strong, .hand.low small { color: var(--zfy-danger, #c6512f); }
.src { font-weight: 600; }
.src.printer { color: var(--zfy-accent-ink, #0a5a4a); }
.src.count { color: var(--zfy-muted, #5a6472); }
.form { display: flex; flex-direction: column; gap: .6rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.footer { display: flex; align-items: center; gap: .5rem; }
</style>
