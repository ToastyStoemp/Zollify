<script setup lang="ts">
import { computed, ref } from 'vue';
import { fmtPrice } from '@zollify/shared';
import { Icon, ModalShell } from '@zollify/ui';
import { CARRIERS, STATUSES, STATUS_LABELS, buildSpec, nextRef, resolveReorderCosts, trackingUrl, type Reorder, type ReorderStatus } from '../engine';
import { fileBytes, remove, save, snap, supplierName } from '../api';
import { sdk } from '../runtime';

/**
 * Reorders - one per supplier, moved along a status board from draft to
 * received. Each yields a rep-ready spec message, a zip of the design files,
 * and once received, landed per-unit costs written onto the products.
 */
const emit = defineEmits<{ error: [message: string] }>();
const currency = computed(() => sdk().account()?.profile.defaultCurrency ?? 'CHF');
const showDone = ref(false);
const list = computed(() => [...snap.value.reorders].filter((r) => showDone.value || r.status !== 'received').sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)));
const rep = (supplierId: string) => snap.value.reps.find((r) => r.supplierId === supplierId);
const money = (n: number | null | undefined, cur?: string) => (n == null ? '-' : fmtPrice(n, cur || currency.value));
const lineTotal = (r: Reorder) => r.lines.reduce((s, l) => s + (Number(l.confirmedUnitPrice ?? l.quotedUnitPrice ?? snap.value.dossiers.find((d) => d.id === l.dossierId)?.lastUnitPrice ?? 0) || 0) * l.qty, 0);

// ── Editor ──────────────────────────────────────────────────────────────────
const editing = ref<Reorder | null>(null);
const extra = ref('');
function openNew(): void {
  const supplierId = snap.value.suppliers[0]?.id ?? '';
  editing.value = { id: crypto.randomUUID(), ref: nextRef(snap.value.reorders), supplierId, status: 'draft', note: '', currency: currency.value, landedExtra: null, lines: [], events: [{ status: 'draft', at: Date.now(), note: 'Created' }], createdAt: Date.now() };
  extra.value = '';
}
function openEdit(r: Reorder): void {
  editing.value = JSON.parse(JSON.stringify(r)) as Reorder;
  extra.value = r.landedExtra != null ? String(r.landedExtra) : '';
}
const dossiersFor = computed(() => (editing.value ? snap.value.dossiers.filter((d) => d.supplierId === editing.value!.supplierId || !d.supplierId).sort((a, b) => a.title.localeCompare(b.title)) : []));
function addLine(dossierId: string): void {
  const d = snap.value.dossiers.find((x) => x.id === dossierId);
  if (!editing.value || !d || editing.value.lines.some((l) => l.dossierId === dossierId)) return;
  editing.value.lines.push({ dossierId: d.id, title: d.title, qty: parseInt(d.specs.moq ?? '') || 1, quotedUnitPrice: null, confirmedUnitPrice: null });
}
async function saveReorder(): Promise<void> {
  if (!editing.value?.supplierId) return emit('error', 'Pick a supplier.');
  try {
    await save('reorders', { ...editing.value, landedExtra: extra.value.trim() ? parseFloat(extra.value) || 0 : null, lines: editing.value.lines.filter((l) => l.qty > 0) });
    editing.value = null;
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Could not save the reorder.');
  }
}
async function removeReorder(r: Reorder): Promise<void> {
  if (!(await sdk().ui.confirm(`Delete reorder ${r.ref}?`, 'Delete reorder?'))) return;
  await remove('reorders', r.id);
  editing.value = null;
}

// ── Status board ────────────────────────────────────────────────────────────
async function setStatus(r: Reorder, status: ReorderStatus): Promise<void> {
  await save('reorders', { ...r, status, events: [...r.events, { status, at: Date.now() }] });
}
const next = (r: Reorder): ReorderStatus | null => STATUSES[STATUSES.indexOf(r.status) + 1] ?? null;

// ── Handoff ─────────────────────────────────────────────────────────────────
const specFor = (r: Reorder) => buildSpec(r, snap.value);
async function copySpec(r: Reorder): Promise<void> {
  try {
    await navigator.clipboard.writeText(specFor(r));
    sdk().ui.toast('Spec copied - paste it into the chat.', { kind: 'success' });
  } catch {
    emit('error', 'Clipboard blocked - open the reorder and copy the spec from there.');
  }
}
function mailto(r: Reorder): string {
  const to = rep(r.supplierId)?.email ?? '';
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(`Reorder ${r.ref}`)}&body=${encodeURIComponent(specFor(r))}`;
}
async function downloadZip(r: Reorder): Promise<void> {
  const { zipSync } = await import('fflate');
  const entries: Record<string, Uint8Array> = {};
  for (const l of r.lines) {
    const d = snap.value.dossiers.find((x) => x.id === l.dossierId);
    const folder = (d?.title || l.title || 'item').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    for (const f of snap.value.files.filter((x) => x.dossierId === l.dossierId && x.kind === 'design')) entries[`${folder}/${f.filename}`] = (await fileBytes(f.id)).bytes;
  }
  if (!Object.keys(entries).length) return emit('error', 'No design files on this reorder.');
  const zip = zipSync(entries, { level: 6 });
  await sdk().ui.saveFile(`reorder-${r.ref}.zip`, new Blob([zip.buffer as ArrayBuffer], { type: 'application/zip' }), 'application/zip');
}

// ── Shipment ────────────────────────────────────────────────────────────────
const shipping = ref<Reorder | null>(null);
const ship = ref({ carrier: 'other', tracking: '', shippedAt: '', eta: '' });
function openShip(r: Reorder): void {
  shipping.value = r;
  ship.value = { carrier: r.shipment?.carrier ?? 'other', tracking: r.shipment?.tracking ?? '', shippedAt: r.shipment?.shippedAt ?? '', eta: r.shipment?.eta ?? '' };
}
async function saveShip(): Promise<void> {
  const r = shipping.value;
  if (!r) return;
  const advance = ship.value.tracking && STATUSES.indexOf(r.status) < STATUSES.indexOf('shipped');
  await save('reorders', { ...r, shipment: { ...ship.value }, status: advance ? 'shipped' : r.status, events: advance ? [...r.events, { status: 'shipped', at: Date.now(), note: 'Tracking added' }] : r.events });
  shipping.value = null;
}

// ── Landed costs → products ─────────────────────────────────────────────────
const costing = ref<Reorder | null>(null);
const costs = computed(() => (costing.value ? resolveReorderCosts(costing.value, snap.value.dossiers) : null));
async function pushCosts(): Promise<void> {
  if (!costing.value || !costs.value) return;
  let pushed = 0;
  for (const c of costs.value.resolved) {
    const product = sdk().data.products.get(c.pid!);
    if (!product) continue;
    const nextP = c.vid ? { ...product, variants: product.variants.map((v) => (v.id === c.vid ? { ...v, cost: c.finalUnit } : v)) } : { ...product, cost: c.finalUnit };
    await sdk().data.products.upsert(nextP);
    const d = snap.value.dossiers.find((x) => x.id === c.dossierId);
    if (d) await save('dossiers', { ...d, lastUnitPrice: c.finalUnit });
    pushed++;
  }
  sdk().ui.toast(`Landed cost written to ${pushed} product${pushed === 1 ? '' : 's'}.`, { kind: 'success' });
  costing.value = null;
}
</script>

<template>
  <div class="tab">
    <div class="tools">
      <label class="inline"><input v-model="showDone" type="checkbox" /> <span>Show received</span></label>
      <span class="spacer"></span>
      <button type="button" class="primary" :disabled="!snap.suppliers.length" @click="openNew"><Icon name="plus" :size="14" /> New reorder</button>
    </div>
    <p v-if="!snap.suppliers.length" class="hint">Add a supplier under Settings → Suppliers first.</p>
    <p v-else-if="!list.length" class="empty">No open reorders. Restock suggests what to order; a reorder turns it into a spec and a zip for the rep.</p>

    <article v-for="r in list" :key="r.id" class="card">
      <div class="head">
        <span class="main"><strong>{{ r.ref }} · {{ supplierName.get(r.supplierId) ?? 'Unknown supplier' }}</strong><small>{{ r.lines.length }} line{{ r.lines.length === 1 ? '' : 's' }} · {{ r.lines.reduce((s, l) => s + l.qty, 0) }} units · {{ money(lineTotal(r), r.currency) }}<template v-if="r.landedExtra"> + {{ money(r.landedExtra, r.currency) }} landed</template></small></span>
        <span :class="['pill', r.status]">{{ STATUS_LABELS[r.status] }}</span>
      </div>
      <ol class="board">
        <li v-for="s in STATUSES" :key="s" :class="{ done: STATUSES.indexOf(s) <= STATUSES.indexOf(r.status), current: s === r.status }"><i></i><span>{{ STATUS_LABELS[s] }}</span></li>
      </ol>
      <p v-if="r.shipment?.tracking" class="ship">
        <Icon name="truck" :size="14" /> {{ CARRIERS.find((c) => c.id === r.shipment!.carrier)?.name ?? r.shipment.carrier }} · <a :href="trackingUrl(r.shipment.carrier, r.shipment.tracking)" target="_blank" rel="noopener">{{ r.shipment.tracking }}</a><template v-if="r.shipment.eta"> · ETA {{ r.shipment.eta }}</template>
      </p>
      <div class="actions">
        <button v-if="next(r)" type="button" class="primary" @click="setStatus(r, next(r)!)"><Icon name="chevron-right" :size="14" /> {{ STATUS_LABELS[next(r)!] }}</button>
        <button type="button" @click="copySpec(r)"><Icon name="copy" :size="14" /> Copy spec</button>
        <a v-if="rep(r.supplierId)?.email" :href="mailto(r)" class="btn"><Icon name="send" :size="14" /> Email {{ rep(r.supplierId)!.name }}</a>
        <a v-if="rep(r.supplierId)?.chatUrl" :href="rep(r.supplierId)!.chatUrl" target="_blank" rel="noopener" class="btn"><Icon name="external-link" :size="14" /> Chat</a>
        <button type="button" @click="downloadZip(r)"><Icon name="download" :size="14" /> Design zip</button>
        <button type="button" @click="openShip(r)"><Icon name="truck" :size="14" /> Shipment</button>
        <button v-if="r.status === 'received'" type="button" @click="costing = r"><Icon name="coins" :size="14" /> Costs → products</button>
        <button type="button" class="quiet" @click="openEdit(r)">Edit</button>
      </div>
    </article>

    <ModalShell v-if="editing" :title="`Reorder ${editing.ref}`" wide @close="editing = null">
      <div class="form">
        <div class="two">
          <label>
            <span>Supplier</span>
            <select v-model="editing.supplierId" :disabled="editing.lines.length > 0"><option v-for="s in snap.suppliers" :key="s.id" :value="s.id">{{ s.name }}</option></select>
          </label>
          <label><span>Currency</span><input v-model="editing.currency" type="text" maxlength="3" /></label>
        </div>
        <fieldset>
          <legend>Lines</legend>
          <div class="lines">
            <div class="lhead"><span>Item</span><span>Qty</span><span>Quoted</span><span>Confirmed</span><span></span></div>
            <div v-for="(l, i) in editing.lines" :key="l.dossierId" class="line">
              <span class="name">{{ l.title }}</span>
              <input v-model.number="l.qty" type="number" min="0" inputmode="numeric" aria-label="Quantity" />
              <input v-model.number="l.quotedUnitPrice" type="number" min="0" step="0.01" inputmode="decimal" placeholder="-" aria-label="Quoted unit price" />
              <input v-model.number="l.confirmedUnitPrice" type="number" min="0" step="0.01" inputmode="decimal" placeholder="-" aria-label="Confirmed unit price" />
              <button type="button" class="quiet" aria-label="Remove line" @click="editing.lines.splice(i, 1)"><Icon name="x" :size="14" /></button>
            </div>
          </div>
          <select class="adder" @change="addLine(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''">
            <option value="">+ Add product…</option>
            <option v-for="d in dossiersFor" :key="d.id" :value="d.id" :disabled="editing.lines.some((l) => l.dossierId === d.id)">{{ d.title }}</option>
          </select>
        </fieldset>
        <div class="two">
          <label><span>Landed extra (shipping + import + fees)</span><input v-model="extra" type="number" min="0" step="0.01" inputmode="decimal" /></label>
          <label><span>Note to the rep</span><input v-model="editing.note" type="text" /></label>
        </div>
        <details>
          <summary>Spec preview</summary>
          <pre class="spec">{{ buildSpec(editing, snap) }}</pre>
        </details>
      </div>
      <template #footer>
        <div class="footer">
          <button v-if="snap.reorders.some((x) => x.id === editing!.id)" type="button" class="danger" @click="removeReorder(editing!)">Delete</button>
          <span class="spacer"></span>
          <button type="button" @click="editing = null">Cancel</button>
          <button type="button" class="primary" @click="saveReorder">Save</button>
        </div>
      </template>
    </ModalShell>

    <ModalShell v-if="shipping" title="Shipment" @close="shipping = null">
      <div class="form">
        <label>
          <span>Carrier</span>
          <select v-model="ship.carrier"><option v-for="c in CARRIERS" :key="c.id" :value="c.id">{{ c.name }}</option></select>
        </label>
        <label><span>Tracking number</span><input v-model="ship.tracking" type="text" /></label>
        <div class="two">
          <label><span>Shipped on</span><input v-model="ship.shippedAt" type="date" /></label>
          <label><span>ETA</span><input v-model="ship.eta" type="date" /></label>
        </div>
        <p class="hint">Adding a tracking number moves the reorder to Shipped.</p>
      </div>
      <template #footer><div class="footer"><span class="spacer"></span><button type="button" @click="shipping = null">Cancel</button><button type="button" class="primary" @click="saveShip">Save</button></div></template>
    </ModalShell>

    <ModalShell v-if="costing && costs" title="Landed costs" @close="costing = null">
      <div class="form">
        <p class="hint">The agreed unit price plus this line's share of the landed extra, spread by line value. Written onto the catalogue products as their cost.</p>
        <table class="costs">
          <thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Landed</th></tr></thead>
          <tbody>
            <tr v-for="c in costs.resolved" :key="c.dossierId"><td>{{ c.title }}</td><td>{{ c.qty }}</td><td>{{ money(c.unitCost, costing.currency) }}</td><td><strong>{{ money(c.finalUnit, costing.currency) }}</strong></td></tr>
          </tbody>
        </table>
        <p v-if="costs.skipped.length" class="hint">Not linked to a catalogue product, so skipped: {{ costs.skipped.map((c) => c.title).join(', ') }}.</p>
      </div>
      <template #footer><div class="footer"><span class="spacer"></span><button type="button" @click="costing = null">Cancel</button><button type="button" class="primary" :disabled="!costs.resolved.length" @click="pushCosts">Write {{ costs.resolved.length }} cost{{ costs.resolved.length === 1 ? '' : 's' }}</button></div></template>
    </ModalShell>
  </div>
</template>

<style scoped>
.tab { display: flex; flex-direction: column; gap: .8rem; }
.tools { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.tools button, .actions button, .btn { display: inline-flex; align-items: center; gap: .35rem; }
label.inline { display: flex; flex-direction: row; align-items: center; gap: .4rem; font-size: .85rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .7rem .9rem; display: flex; flex-direction: column; gap: .5rem; }
.head { display: flex; align-items: center; gap: .5rem; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.main small { color: var(--zfy-muted, #5a6472); font-size: .76rem; }
.pill { font-size: .66rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; border-radius: 999px; padding: .15rem .5rem; background: var(--zfy-bg, #f1f4f6); color: var(--zfy-muted, #5a6472); }
.pill.received { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.board { list-style: none; margin: 0; padding: 0; display: flex; gap: 0; overflow-x: auto; }
.board li { flex: 1; min-width: 5rem; display: flex; flex-direction: column; align-items: center; gap: .2rem; font-size: .62rem; color: var(--zfy-faint, #8a94a0); position: relative; }
.board li i { width: .6rem; height: .6rem; border-radius: 50%; background: var(--zfy-line, #d6dde4); z-index: 1; }
.board li::before { content: ''; position: absolute; top: .3rem; left: -50%; right: 50%; height: 2px; background: var(--zfy-line, #d6dde4); }
.board li:first-child::before { display: none; }
.board li.done { color: var(--zfy-muted, #5a6472); }
.board li.done i, .board li.done::before { background: var(--zfy-accent, #0e7c66); }
.board li.current { color: var(--zfy-accent-ink, #0a5a4a); font-weight: 600; }
.ship { margin: 0; font-size: .82rem; display: flex; align-items: center; gap: .3rem; color: var(--zfy-muted, #5a6472); }
.actions { display: flex; flex-wrap: wrap; gap: .4rem; }
.actions button, .btn { min-height: 2rem; padding: .2rem .7rem; font-size: .78rem; }
.btn { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; background: var(--zfy-surface, #fff); color: var(--zfy-ink, #1a2230); font-weight: 500; text-decoration: none; }
.form { display: flex; flex-direction: column; gap: .6rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .5rem; }
legend { font-size: .8rem; font-weight: 600; padding: 0 .3rem; }
.lines { display: flex; flex-direction: column; gap: .3rem; }
.lhead, .line { display: grid; grid-template-columns: 1fr 4.5rem 5.5rem 5.5rem auto; gap: .4rem; align-items: center; }
.lhead { font-size: .7rem; color: var(--zfy-muted, #5a6472); }
.line .name { font-size: .85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.line input { min-height: 1.9rem; padding: .1rem .4rem; text-align: right; }
.line .quiet { min-height: 1.7rem; padding: 0 .3rem; }
.adder { align-self: flex-start; }
.spec { margin: .4rem 0 0; padding: .6rem .8rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); font-size: .78rem; white-space: pre-wrap; max-height: 16rem; overflow: auto; }
.costs { width: 100%; border-collapse: collapse; font-size: .85rem; font-variant-numeric: tabular-nums; }
.costs th, .costs td { text-align: right; padding: .3rem .5rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
.costs th:first-child, .costs td:first-child { text-align: left; }
.costs th { font-weight: 500; font-size: .72rem; color: var(--zfy-muted, #5a6472); }
.footer { display: flex; align-items: center; gap: .5rem; }
</style>
