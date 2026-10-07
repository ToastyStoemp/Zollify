<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { PeppolPartySchema, fmtPrice, localIsoDay, type PeppolDocument, type PeppolDocumentInput, type PeppolProblem, type PeppolSettings } from '@zollify/shared';
import { Icon, ModalShell } from '@zollify/ui';
import {
  createDocument,
  creditDocument,
  deleteCustomer,
  deleteDocument,
  documentXml,
  errorText,
  fromSale,
  issueDocument,
  loadCustomers,
  loadDocument,
  loadDocuments,
  loadSettings,
  problemsOf,
  saveCustomer,
  sendDocument,
  setStatus,
  today,
  updateDocument,
  type Customer,
  type DocumentSummary,
} from '../api';
import { sdk } from '../runtime';
import DocumentEditor from './DocumentEditor.vue';

/**
 * E-invoices: Belgian B2B invoices and credit notes over Peppol. Drafts,
 * then issued (numbered and frozen), sent through the access point, paid.
 */
const docs = ref<DocumentSummary[] | null>(null);
const customers = ref<Customer[]>([]);
const settings = ref<PeppolSettings | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const filter = ref<'all' | 'draft' | 'open' | 'paid'>('all');

async function refresh(): Promise<void> {
  try {
    const [d, c, s] = await Promise.all([loadDocuments(), loadCustomers(), loadSettings()]);
    docs.value = d;
    customers.value = c;
    settings.value = s.settings;
  } catch (err) {
    error.value = errorText(err, 'Could not load invoices.');
  }
}
onMounted(refresh);

const shown = computed(() =>
  (docs.value ?? []).filter((d) => filter.value === 'all' || (filter.value === 'draft' ? d.status === 'draft' : filter.value === 'paid' ? d.status === 'paid' : d.status === 'issued' || d.status === 'sent')),
);
const ready = computed(() => !!settings.value?.name && !!settings.value?.peppolId);
const overdue = (d: DocumentSummary): boolean => d.kind === 'invoice' && (d.status === 'issued' || d.status === 'sent') && !!d.dueDate && d.dueDate < today();
const STATUS: Record<DocumentSummary['status'], string> = { draft: 'Draft', issued: 'Issued', sent: 'Sent', paid: 'Paid' };

// ── Editing ─────────────────────────────────────────────────────────────────
const open = ref<{ doc: PeppolDocument; problems: PeppolProblem[] } | null>(null);
async function openDoc(id: string): Promise<void> {
  try {
    const r = await loadDocument(id);
    open.value = { doc: r.document, problems: r.problems };
  } catch (err) {
    error.value = errorText(err, 'Could not open it.');
  }
}
function newInvoice(): void {
  const s = settings.value!;
  const due = localIsoDay(Date.now() + s.paymentDays * 86_400_000);
  open.value = {
    doc: {
      id: '',
      kind: 'invoice',
      number: null,
      status: 'draft',
      issueDate: today(),
      dueDate: due,
      currency: 'EUR',
      buyer: PeppolPartySchema.parse({ name: '' }),
      buyerReference: '',
      orderReference: '',
      lines: [{ description: '', quantity: 1, unitCode: 'C62', unitPrice: 0, vatCategory: s.smallBusinessExempt ? 'E' : 'S', vatRate: s.smallBusinessExempt ? 0 : 21 }],
      note: '',
      invoiceRef: null,
      saleId: null,
      paymentReference: null,
      createdAt: 0,
      updatedAt: 0,
      issuedAt: null,
    },
    problems: [],
  };
}

async function save(input: PeppolDocumentInput): Promise<PeppolDocument | null> {
  busy.value = true;
  error.value = null;
  try {
    const r = open.value!.doc.id ? await updateDocument(open.value!.doc.id, input) : await createDocument(input);
    open.value = { doc: r.document, problems: r.problems };
    await refresh();
    return r.document;
  } catch (err) {
    sdk().ui.toast(errorText(err, 'Could not save.'), { kind: 'error' });
    return null;
  } finally {
    busy.value = false;
  }
}
async function issue(input: PeppolDocumentInput): Promise<void> {
  const saved = await save(input);
  if (!saved) return;
  if (open.value!.problems.length) return void sdk().ui.toast('Fix the points listed first.', { kind: 'error' });
  if (!(await sdk().ui.confirm('Issuing takes the next number and freezes the document - corrections are made with a credit note.', 'Issue now?'))) return;
  busy.value = true;
  try {
    const r = await issueDocument(saved.id);
    open.value = { doc: r.document, problems: [] };
    sdk().ui.toast(`${r.document.kind === 'credit' ? 'Credit note' : 'Invoice'} ${r.document.number} issued.`, { kind: 'success' });
    await refresh();
  } catch (err) {
    const problems = problemsOf(err);
    if (problems.length) open.value = { doc: saved, problems };
    else sdk().ui.toast(errorText(err, 'Could not issue it.'), { kind: 'error' });
  } finally {
    busy.value = false;
  }
}
async function remove(): Promise<void> {
  if (!(await sdk().ui.confirm('The draft is deleted. Nothing was numbered, so nothing is missing from the sequence.', 'Discard draft?'))) return;
  await deleteDocument(open.value!.doc.id).catch(() => undefined);
  open.value = null;
  await refresh();
}
async function credit(): Promise<void> {
  try {
    const r = await creditDocument(open.value!.doc.id);
    open.value = { doc: r.document, problems: [] };
    await refresh();
  } catch (err) {
    sdk().ui.toast(errorText(err, 'Could not make a credit note.'), { kind: 'error' });
  }
}
async function send(): Promise<void> {
  busy.value = true;
  try {
    const r = await sendDocument(open.value!.doc.id);
    open.value = { doc: r.document, problems: [] };
    sdk().ui.toast(`Sent over Peppol${r.reference ? ` (${r.reference})` : ''}.`, { kind: 'success' });
    await refresh();
  } catch (err) {
    sdk().ui.toast(errorText(err, 'Could not send it.'), { kind: 'error', timeoutMs: 8000 });
  } finally {
    busy.value = false;
  }
}
async function download(): Promise<void> {
  const d = open.value!.doc;
  if (!d.id) return void sdk().ui.toast('Save the draft first.', { kind: 'error' });
  const xml = await documentXml(d.id);
  await sdk().ui.saveFile(`${(d.number ?? 'draft').replace(/[^\w-]+/g, '-')}.xml`, xml, 'application/xml');
}
async function status(s: 'sent' | 'paid' | 'issued'): Promise<void> {
  const r = await setStatus(open.value!.doc.id, s);
  open.value = { doc: r.document, problems: [] };
  await refresh();
}
async function saveAsCustomer(): Promise<void> {
  const buyer = open.value!.doc.buyer;
  if (!buyer.name) return;
  const existing = customers.value.find((c) => c.name === buyer.name);
  await saveCustomer(existing?.id ?? crypto.randomUUID(), buyer);
  customers.value = await loadCustomers();
  sdk().ui.toast(`${buyer.name} saved.`, { kind: 'success' });
}

// ── From a till sale ────────────────────────────────────────────────────────
const picking = ref(false);
const sales = computed(() =>
  sdk()
    .data.transactions.recent()
    .filter((t) => !t.revertedAt)
    .slice(0, 40),
);
async function invoiceSale(id: string): Promise<void> {
  picking.value = false;
  try {
    const r = await fromSale(id);
    open.value = { doc: r.document, problems: r.problems };
    await refresh();
  } catch (err) {
    sdk().ui.toast(errorText(err, 'Could not make an invoice from that sale.'), { kind: 'error' });
  }
}

// ── Customers ───────────────────────────────────────────────────────────────
const showCustomers = ref(false);
async function removeCustomer(c: Customer): Promise<void> {
  if (!(await sdk().ui.confirm(`${c.name} is removed from your saved customers. Invoices already made keep their details.`, 'Remove customer?'))) return;
  await deleteCustomer(c.id);
  customers.value = await loadCustomers();
}
</script>

<template>
  <section class="page invoices">
    <header>
      <h1>E-invoices</h1>
      <div class="seg" role="group" aria-label="Show">
        <button v-for="f in (['all', 'draft', 'open', 'paid'] as const)" :key="f" type="button" :class="{ on: filter === f }" @click="filter = f">{{ { all: 'All', draft: 'Drafts', open: 'Unpaid', paid: 'Paid' }[f] }}</button>
      </div>
      <span class="grow" />
      <button type="button" @click="showCustomers = true"><Icon name="users" :size="14" /> Customers</button>
      <button type="button" :disabled="!ready" @click="picking = true"><Icon name="shopping-cart" :size="14" /> From a sale</button>
      <button type="button" class="primary" :disabled="!ready" @click="newInvoice"><Icon name="plus" :size="14" /> New invoice</button>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="settings && !ready" class="warn">Add your business name and Belgian enterprise number to your Business profile first (Settings → Business profile). Payment details and the access point are under Settings → E-invoices (Peppol).</p>

    <p v-if="docs && !shown.length" class="empty">No invoices here yet.</p>
    <ul v-else-if="docs" class="list">
      <li v-for="d in shown" :key="d.id">
        <button type="button" class="row" @click="openDoc(d.id)">
          <strong>{{ d.number ?? 'Draft' }}</strong>
          <span>{{ d.kind === 'credit' ? 'Credit note · ' : '' }}{{ d.buyer || 'No buyer yet' }}</span>
          <span class="when">{{ d.issueDate }}<template v-if="d.dueDate && d.kind === 'invoice'"> · due {{ d.dueDate }}</template></span>
          <span :class="['pill', d.status, { late: overdue(d) }]">{{ overdue(d) ? 'Overdue' : STATUS[d.status] }}</span>
          <strong class="amount">{{ d.kind === 'credit' ? '-' : '' }}{{ fmtPrice(d.total, d.currency) }}</strong>
        </button>
      </li>
    </ul>

    <DocumentEditor
      v-if="open"
      :key="open.doc.id + open.doc.status + open.doc.updatedAt"
      :doc="open.doc"
      :problems="open.problems"
      :customers="customers"
      :small-business="!!settings?.smallBusinessExempt"
      :busy="busy"
      @close="open = null"
      @save="save"
      @issue="issue"
      @remove="remove"
      @credit="credit"
      @send="send"
      @download="download"
      @status="status"
      @save-customer="saveAsCustomer"
    />

    <ModalShell v-if="picking" title="Invoice a till sale" @close="picking = false">
      <p class="hint">For a business customer who paid at the till and needs a proper invoice. The lines and VAT come from the sale; add the buyer next.</p>
      <ul class="sales">
        <li v-for="t in sales" :key="t.id">
          <button type="button" @click="invoiceSale(t.id)">
            <span>{{ new Date(t.timestamp).toLocaleString() }}</span>
            <span class="items">{{ t.items.map((i) => `${i.qty} × ${i.title}`).join(', ') }}</span>
            <strong>{{ fmtPrice(t.total, t.currency) }}</strong>
          </button>
        </li>
      </ul>
    </ModalShell>

    <ModalShell v-if="showCustomers" title="Customers" @close="showCustomers = false">
      <p v-if="!customers.length" class="hint">Save a buyer from an invoice ("Save as customer") to reuse their details.</p>
      <ul class="sales">
        <li v-for="c in customers" :key="c.id" class="cust">
          <span><strong>{{ c.name }}</strong><small>{{ c.vatNumber || c.companyId }} · Peppol {{ c.peppolScheme }}:{{ c.peppolId || '-' }}</small></span>
          <button type="button" class="quiet" @click="removeCustomer(c)">Remove</button>
        </li>
      </ul>
    </ModalShell>
  </section>
</template>

<style scoped>
.invoices { display: flex; flex-direction: column; gap: .8rem; max-width: 64rem; }
header { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; margin-right: .5rem; }
header button { display: inline-flex; align-items: center; gap: .35rem; min-height: 2.3rem; font-size: .84rem; }
.grow { flex: 1; }
.seg { display: inline-flex; gap: .15rem; padding: .15rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); }
.seg button { border: 0; background: none; min-height: 2rem; padding: .1rem .7rem; border-radius: 6px; color: var(--zfy-muted, #5a6472); }
.seg button.on { background: var(--zfy-surface, #fff); color: var(--zfy-ink, #1a2230); font-weight: 600; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.warn { margin: 0; color: var(--zfy-warning-ink, #8a5a1e); }
.hint { margin: 0 0 .5rem; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.empty { margin: 0; padding: 1.5rem; text-align: center; color: var(--zfy-muted, #5a6472); border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); overflow: hidden; }
.list li + li { border-top: 1px solid var(--zfy-line, #d6dde4); }
.row { width: 100%; display: grid; grid-template-columns: 9rem 1fr auto auto 7rem; gap: .8rem; align-items: center; padding: .7rem 1rem; border: 0; background: none; text-align: left; font-size: .88rem; }
.row:hover { background: var(--zfy-bg, #f1f4f6); }
.when { color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.amount { text-align: right; font-variant-numeric: tabular-nums; }
.pill { font-size: .66rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; padding: .12rem .5rem; border-radius: 999px; background: var(--zfy-bg, #f1f4f6); color: var(--zfy-muted, #5a6472); }
.pill.sent { background: var(--zfy-signal-soft, #e4ecf6); }
.pill.paid { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.pill.late { background: var(--zfy-signal-soft, #f6e5df); color: var(--zfy-danger, #c6512f); }
.sales { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; max-height: 60vh; overflow-y: auto; }
.sales button { width: 100%; display: grid; grid-template-columns: 10rem 1fr auto; gap: .6rem; text-align: left; font-size: .84rem; padding: .5rem .6rem; }
.sales .items { color: var(--zfy-muted, #5a6472); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cust { display: flex; align-items: center; gap: .5rem; padding: .4rem .5rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); }
.cust span { flex: 1; display: flex; flex-direction: column; }
.cust small { color: var(--zfy-muted, #5a6472); font-size: .76rem; }
@media (max-width: 720px) { .row { grid-template-columns: 1fr auto; } .row .when { display: none; } }
</style>
