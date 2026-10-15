<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  BELGIAN_VAT_RATES,
  VAT_CATEGORIES,
  VAT_CATEGORY_LABELS,
  fmtPrice,
  peppolTotals,
  type PeppolDocument,
  type PeppolDocumentInput,
  type PeppolProblem,
} from '@zollify/shared';
import { ModalShell } from '@zollify/ui';
import type { Customer } from '../api';
import PartyFields from './PartyFields.vue';

/**
 * One invoice or credit note. A draft is edited freely; an issued document
 * is shown as it was issued, with what can still be done to it.
 */
const props = defineProps<{ doc: PeppolDocument; problems: PeppolProblem[]; customers: Customer[]; smallBusiness: boolean; busy: boolean }>();
const emit = defineEmits<{
  close: [];
  save: [input: PeppolDocumentInput];
  issue: [input: PeppolDocumentInput];
  remove: [];
  credit: [];
  send: [];
  download: [];
  status: [status: 'sent' | 'paid' | 'issued'];
  'save-customer': [];
}>();

const draft = computed(() => props.doc.status === 'draft');
// Edited on a copy; nothing is saved until asked.
const form = ref<PeppolDocumentInput>(JSON.parse(JSON.stringify({
  kind: props.doc.kind,
  issueDate: props.doc.issueDate,
  dueDate: props.doc.dueDate,
  currency: props.doc.currency,
  buyer: props.doc.buyer,
  buyerReference: props.doc.buyerReference,
  orderReference: props.doc.orderReference,
  lines: props.doc.lines,
  note: props.doc.note,
  deliveryDate: props.doc.deliveryDate,
  invoiceRef: props.doc.invoiceRef,
  saleId: props.doc.saleId,
})) as PeppolDocumentInput);
const totals = computed(() => peppolTotals(form.value.lines));
const money = (n: number): string => fmtPrice(n, form.value.currency);

function addLine(): void {
  form.value.lines.push({ description: '', quantity: 1, unitCode: 'C62', unitPrice: 0, vatCategory: props.smallBusiness ? 'E' : 'S', vatRate: props.smallBusiness ? 0 : 21 });
}
function categoryChanged(i: number): void {
  const l = form.value.lines[i]!;
  if (l.vatCategory !== 'S') l.vatRate = 0;
  else if (!l.vatRate) l.vatRate = 21;
}
const customerId = ref('');
function pickCustomer(): void {
  const c = props.customers.find((x) => x.id === customerId.value);
  if (!c) return;
  const { id: _id, ...party } = c;
  form.value.buyer = { ...party };
}
const title = computed(() => {
  const kind = props.doc.kind === 'credit' ? 'Credit note' : 'Invoice';
  return props.doc.number ? `${kind} ${props.doc.number}` : `New ${kind.toLowerCase()} (draft)`;
});
const STATUS: Record<PeppolDocument['status'], string> = { draft: 'Draft', issued: 'Issued', sent: 'Sent', paid: 'Paid' };
</script>

<template>
  <ModalShell :title="title" @close="emit('close')">
    <div class="editor">
      <p v-if="!draft" class="state">
        {{ STATUS[doc.status] }}<template v-if="doc.sentVia"> over Peppol on {{ new Date(doc.sentVia.at).toLocaleDateString() }}</template>
        <template v-if="doc.paymentReference"> · payment reference {{ doc.paymentReference }}</template>
      </p>
      <ul v-if="draft && problems.length" class="problems" role="alert">
        <li v-for="p in problems" :key="p.rule + p.message"><code>{{ p.rule }}</code> {{ p.message }}</li>
      </ul>
      <p v-if="doc.kind === 'credit' && form.invoiceRef" class="hint">Corrects invoice {{ form.invoiceRef.number }} of {{ form.invoiceRef.issueDate }}. Enter what is credited - all of it, or the part that changes.</p>

      <fieldset :disabled="!draft">
        <div class="grid">
          <label><span>Date</span><input v-model="form.issueDate" type="date" /></label>
          <label v-if="doc.kind === 'invoice'"><span>Due</span><input v-model="form.dueDate" type="date" /></label>
          <label><span>Buyer's reference</span><input v-model="form.buyerReference" type="text" placeholder="Their PO or contact" /></label>
          <label><span>Order number</span><input v-model="form.orderReference" type="text" /></label>
          <label><span>Delivered on</span><input v-model="form.deliveryDate" type="date" /></label>
        </div>

        <h3>Buyer</h3>
        <div v-if="draft && customers.length" class="pick">
          <select v-model="customerId" aria-label="Saved customer" @change="pickCustomer">
            <option value="">Saved customers…</option>
            <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
        <PartyFields v-model="form.buyer" />
        <button v-if="draft" type="button" class="quiet small" @click="emit('save-customer')">Save as customer</button>

        <h3>Lines</h3>
        <div class="lines">
          <div class="line head" aria-hidden="true"><span class="desc">Description</span><span>Qty</span><span>Unit price excl. VAT</span><span>VAT</span><span></span><span class="net">Net</span></div>
          <div v-for="(l, i) in form.lines" :key="i" class="line">
            <input v-model="l.description" class="desc" type="text" placeholder="Description" aria-label="Description" />
            <input v-model.number="l.quantity" type="number" step="any" aria-label="Quantity" />
            <input v-model.number="l.unitPrice" type="number" min="0" step="0.01" aria-label="Unit price excluding VAT" />
            <select v-model="l.vatCategory" aria-label="VAT" @change="categoryChanged(i)">
              <option v-for="c in VAT_CATEGORIES" :key="c" :value="c">{{ VAT_CATEGORY_LABELS[c] }}</option>
            </select>
            <select v-if="l.vatCategory === 'S'" v-model.number="l.vatRate" aria-label="VAT rate">
              <option v-for="r in BELGIAN_VAT_RATES.filter((r) => r > 0)" :key="r" :value="r">{{ r }}%</option>
            </select>
            <span class="net">{{ money(totals.lines[i] ?? 0) }}</span>
            <button v-if="draft && form.lines.length > 1" type="button" class="quiet" aria-label="Remove line" @click="form.lines.splice(i, 1)">×</button>
          </div>
        </div>
        <button v-if="draft" type="button" class="quiet small" @click="addLine">+ Add line</button>

        <label class="block"><span>Note</span><textarea v-model="form.note" rows="2" /></label>
      </fieldset>

      <dl class="totals">
        <template v-for="g in totals.breakdown" :key="g.category + g.rate">
          <dt>VAT {{ g.category === 'S' ? `${g.rate}%` : VAT_CATEGORY_LABELS[g.category] }} on {{ money(g.taxable) }}</dt>
          <dd>{{ money(g.tax) }}</dd>
        </template>
        <dt>Excl. VAT</dt><dd>{{ money(totals.taxExclusive) }}</dd>
        <dt class="big">{{ doc.kind === 'credit' ? 'Credited' : 'To pay' }}</dt><dd class="big">{{ money(totals.payable) }}</dd>
      </dl>
    </div>
    <template #footer>
      <div class="footer">
        <template v-if="draft">
          <button v-if="doc.createdAt" type="button" class="quiet danger" @click="emit('remove')">Discard draft</button>
          <span class="grow" />
          <button type="button" @click="emit('download')">Preview XML</button>
          <button type="button" :disabled="busy" @click="emit('save', form)">Save draft</button>
          <button type="button" class="primary" :disabled="busy" @click="emit('issue', form)">Issue</button>
        </template>
        <template v-else>
          <button v-if="doc.kind === 'invoice'" type="button" class="quiet" @click="emit('credit')">Credit note</button>
          <span class="grow" />
          <button type="button" @click="emit('download')">Download XML</button>
          <button v-if="doc.status !== 'paid'" type="button" @click="emit('status', 'paid')">Mark paid</button>
          <button v-else type="button" @click="emit('status', doc.sentVia ? 'sent' : 'issued')">Not paid</button>
          <button type="button" class="primary" :disabled="busy" @click="emit('send')">{{ doc.sentVia ? 'Send again' : 'Send over Peppol' }}</button>
        </template>
      </div>
    </template>
  </ModalShell>
</template>

<style scoped>
.editor { display: flex; flex-direction: column; gap: .7rem; }
fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .6rem; min-width: 0; }
h3 { margin: .3rem 0 0; font-size: .9rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .5rem .7rem; }
.grid label, .block { display: flex; flex-direction: column; gap: .2rem; font-size: .84rem; }
.hint, .state { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.state { font-weight: 600; color: var(--zfy-accent-ink, #0a5a4a); }
.problems { margin: 0; padding: .5rem .7rem .5rem 1.6rem; border-radius: 8px; background: var(--zfy-signal-soft, #f6e5df); font-size: .82rem; display: flex; flex-direction: column; gap: .2rem; }
.problems code { font-size: .72rem; color: var(--zfy-muted, #5a6472); }
.pick select { width: 100%; }
.lines { display: flex; flex-direction: column; gap: .35rem; }
.line { display: grid; grid-template-columns: minmax(8rem, 3fr) 4rem 6rem minmax(7rem, 1.4fr) 4.5rem 5.5rem 1.6rem; gap: .35rem; align-items: center; }
.line.head { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); }
.line input, .line select { min-width: 0; }
.net { text-align: right; font-variant-numeric: tabular-nums; font-size: .84rem; }
.small { align-self: flex-start; font-size: .8rem; min-height: 2rem; }
.totals { display: grid; grid-template-columns: 1fr auto; gap: .2rem 1rem; margin: 0; font-size: .86rem; align-self: flex-end; min-width: 16rem; }
.totals dt { color: var(--zfy-muted, #5a6472); }
.totals dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.totals .big { font-weight: 700; color: var(--zfy-ink, #1a2230); font-size: 1rem; }
.footer { display: flex; gap: .5rem; align-items: center; width: 100%; flex-wrap: wrap; }
.grow { flex: 1; }
@media (max-width: 640px) {
  .line { grid-template-columns: 1fr 1fr 1fr; }
  .line .desc { grid-column: 1 / -1; }
  .line.head { display: none; }
}
</style>
