<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  COMMISSION_STATUSES,
  COMMISSION_STATUS_LABEL,
  CommissionCreateSchema,
  CommissionInputSchema,
  CommissionSettingsSchema,
  fmtPrice,
  isClosedStatus,
  isOverdue,
  nextStatuses,
  type CommissionSettings,
  type CommissionStatus,
} from '@zollify/shared';
import { QrCode } from '@zollify/ui';
import { api, errorText, localToday, type CommissionView } from '../api';
import { choiceOf, customerFields, duplicatesIn, emptyChoice, type CustomerChoice, type CustomerContact } from '../customer-form';
import CustomerPicker from './CustomerPicker.vue';
import CustomersPanel from './CustomersPanel.vue';
import { slipHtml } from '../slip';
import { sdk } from '../runtime';

/**
 * The owner's and staff's side: every commission with status filters and
 * search, a detail with its timeline and quick status buttons, the QR code for
 * the customer's page, the customers on file with what each one ordered, and
 * (admins) where people collect their work and how long details are kept.
 */

const items = ref<CommissionView[]>([]);
const settings = ref<CommissionSettings>(CommissionSettingsSchema.parse({}));
const emailEnabled = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

const tab = ref<'commissions' | 'customers'>('commissions');
const isAdmin = computed(() => sdk().account()?.role !== 'member');
const today = localToday();

async function load(): Promise<void> {
  error.value = null;
  try {
    const res = await api.list();
    items.value = res.commissions;
    settings.value = res.settings;
    Object.assign(pickup, res.settings);
    emailEnabled.value = res.emailEnabled;
  } catch (err) {
    error.value = errorText(err, 'Could not load commissions - this needs a connection.');
  } finally {
    loaded.value = true;
  }
}
onMounted(load);

function flash(msg: string): void {
  notice.value = msg;
  setTimeout(() => { if (notice.value === msg) notice.value = null; }, 4000);
}

// ── List ────────────────────────────────────────────────────────────────────
type Filter = 'open' | CommissionStatus | 'all';
const filter = ref<Filter>('open');
const query = ref('');
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'open', label: 'Open' },
  ...COMMISSION_STATUSES.map((s) => ({ id: s as Filter, label: COMMISSION_STATUS_LABEL[s] })),
  { id: 'all', label: 'All' },
];
const overdue = (c: CommissionView): boolean => isOverdue(c, today);
const count = (f: Filter): number => items.value.filter((c) => matches(c, f)).length;
function matches(c: CommissionView, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'open') return !isClosedStatus(c.status);
  return c.status === f;
}
const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return items.value
    .filter((c) => matches(c, filter.value) && (!q || `${c.customerName} ${c.title} ${c.email} ${c.phone}`.toLowerCase().includes(q)))
    // Overdue first, then the soonest due date, then newest.
    .sort((a, b) => Number(overdue(b)) - Number(overdue(a)) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || b.updatedAt - a.updatedAt);
});
const overdueCount = computed(() => items.value.filter(overdue).length);

// ── Detail ──────────────────────────────────────────────────────────────────
const openId = ref<string | null>(null);
const current = computed(() => items.value.find((c) => c.id === openId.value) ?? null);
const message = ref('');
const sendEmail = ref(false);

function replace(c: CommissionView): void {
  const i = items.value.findIndex((x) => x.id === c.id);
  if (i >= 0) items.value[i] = c;
  else items.value.unshift(c);
}

function open(c: CommissionView): void {
  openId.value = c.id;
  message.value = '';
  sendEmail.value = false;
  editing.value = false;
}

async function run(fn: () => Promise<void>, fallback: string): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await fn();
  } catch (err) {
    error.value = errorText(err, fallback);
  } finally {
    busy.value = false;
  }
}

/** Moving to a step and posting a message are one action: the message belongs to that step. */
function move(status: CommissionStatus | undefined): Promise<void> {
  const c = current.value;
  if (!c) return Promise.resolve();
  return run(async () => {
    const res = await api.update(c.id, { ...(status ? { status } : {}), message: message.value, email: sendEmail.value });
    replace(res.commission);
    message.value = '';
    sendEmail.value = false;
    flash(res.emailed ? 'Updated, and the customer was emailed.' : 'Updated.');
  }, 'Could not save the update.');
}

/** Offer the email when the customer can be reached and the update is the one they wait for. */
function pickStatus(s: CommissionStatus): void {
  const c = current.value;
  sendEmail.value = s === 'ready' && !!c?.email && emailEnabled.value;
  void move(s);
}

const link = computed(() => current.value?.publicUrl ?? '');
async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(link.value);
    flash('Link copied.');
  } catch {
    flash('Could not copy - select the link and copy it by hand.');
  }
}
async function shareLink(): Promise<void> {
  const c = current.value;
  if (!c) return;
  if (typeof navigator.share === 'function') {
    try { await navigator.share({ title: c.title, url: c.publicUrl }); } catch { /* cancelled */ }
  } else await copyLink();
}
async function printSlip(): Promise<void> {
  const c = current.value;
  if (!c) return;
  await run(async () => {
    const html = await slipHtml(c, settings.value.shopName || sdk().account()?.accountName || '');
    if (!(await sdk().ui.openDocument(`commission-${c.id.slice(0, 8)}.html`, html))) flash('The slip was blocked by the browser - allow pop-ups and try again.');
  }, 'Could not make the slip.');
}
const emailLink = (): Promise<void> =>
  run(async () => {
    const c = current.value;
    if (c) flash((await api.emailLink(c.id)).emailed ? 'Link emailed.' : 'The email could not be sent.');
  }, 'Could not send the email.');
const newLink = (): Promise<void> =>
  run(async () => {
    const c = current.value;
    if (!c || !(await sdk().ui.confirm('The old link and QR code stop working. Anyone who has them will see "not available".', 'Replace the link?', { confirm: 'Replace' }))) return;
    replace(await api.newLink(c.id));
    flash('New link made. Print or send the new QR code.');
  }, 'Could not replace the link.');
const erase = (): Promise<void> =>
  run(async () => {
    const c = current.value;
    if (!c || !(await sdk().ui.confirm(`Erase "${c.title}"? The customer's details stay on their record until it is erased. Sales already rung up stay in your books.`, 'Erase commission?', { confirm: 'Erase' }))) return;
    await api.remove(c.id);
    items.value = items.value.filter((x) => x.id !== c.id);
    openId.value = null;
  }, 'Could not erase it.');

// ── Create / edit ───────────────────────────────────────────────────────────
const editing = ref(false);
const creating = ref(false);
const form = reactive({ title: '', description: '', price: '', depositAsked: '', dueDate: '', notes: '', currency: 'EUR' });
const choice = ref<CustomerChoice>(emptyChoice());
const duplicates = ref<CustomerContact[]>([]);

/** A new commission, for a customer already on file when one is given. */
function startNew(customer?: CustomerContact): void {
  Object.assign(form, { title: '', description: '', price: '', depositAsked: '', dueDate: '', notes: '', currency: settings.value.currency });
  choice.value = customer ? choiceOf(customer) : emptyChoice();
  duplicates.value = [];
  tab.value = 'commissions';
  creating.value = true;
  editing.value = false;
  openId.value = null;
}
function startEdit(): void {
  const c = current.value;
  if (!c) return;
  Object.assign(form, { title: c.title, description: c.description, dueDate: c.dueDate, notes: c.notes, currency: c.currency, price: c.price ? String(c.price) : '', depositAsked: c.depositAsked ? String(c.depositAsked) : '' });
  editing.value = true;
}
const num = (s: string): number => Math.max(0, Number(s.replace(',', '.')) || 0);
async function submit(force = false): Promise<void> {
  const fields = { ...form, price: num(form.price), depositAsked: num(form.depositAsked) };
  if (creating.value) {
    const parsed = CommissionCreateSchema.safeParse({ ...fields, ...customerFields(choice.value, force) });
    if (!parsed.success) {
      error.value = parsed.error.issues[0]?.message ?? 'Check the form.';
      return;
    }
    await run(async () => {
      try {
        const made = await api.create(parsed.data);
        replace(made);
        creating.value = false;
        open(made);
      } catch (err) {
        // A customer like this one is already on file: offer them instead of adding a second.
        const found = duplicatesIn(err);
        if (!found) throw err;
        duplicates.value = found;
      }
    }, 'Could not save the commission.');
    return;
  }
  const parsed = CommissionInputSchema.safeParse(fields);
  if (!parsed.success) {
    error.value = parsed.error.issues[0]?.message ?? 'Check the form.';
    return;
  }
  await run(async () => {
    if (current.value) {
      replace(await api.save(current.value.id, parsed.data));
      editing.value = false;
    }
  }, 'Could not save the commission.');
}
const useDuplicate = (c: CustomerContact): void => {
  choice.value = choiceOf(c);
  duplicates.value = [];
};

/** From the customers tab: show one of their commissions. */
function showCommission(c: CommissionView): void {
  replace(c);
  tab.value = 'commissions';
  filter.value = 'all';
  open(c);
}
const customerFocus = ref<string | null>(null);
function showCustomer(c: CommissionView): void {
  customerFocus.value = c.customerId;
  tab.value = 'customers';
}

// ── Where people collect ────────────────────────────────────────────────────
const pickup = reactive<CommissionSettings>(CommissionSettingsSchema.parse({}));
const showSettings = ref(false);
const saveSettings = (): Promise<void> =>
  run(async () => {
    const parsed = CommissionSettingsSchema.safeParse(pickup);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Check the settings.');
    settings.value = await api.saveSettings(parsed.data);
    flash('Saved.');
  }, 'Could not save the settings.');

const money = (n: number, c: CommissionView): string => fmtPrice(n, c.currency);
const stamp = (at: number): string => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
</script>

<template>
  <div class="comm">
    <header class="top">
      <h1>Commissions</h1>
      <button type="button" class="primary" @click="startNew()">New commission</button>
    </header>
    <div class="chips tabs" role="tablist" aria-label="View">
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'commissions' }" :aria-selected="tab === 'commissions'" @click="tab = 'commissions'">Commissions</button>
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'customers' }" :aria-selected="tab === 'customers'" @click="customerFocus = null; tab = 'customers'">Customers</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="ok" role="status">{{ notice }}</p>
    <p v-if="overdueCount" class="warn">{{ overdueCount }} overdue - past the due date and not finished.</p>

    <CustomersPanel
      v-if="tab === 'customers'"
      :is-admin="isAdmin"
      :currency="settings.currency"
      :keep-days="settings.keepCustomerDays"
      :focus-id="customerFocus"
      @new-commission="startNew"
      @open-commission="showCommission"
      @changed="load"
    />

    <div v-else class="layout">
      <section class="list" aria-label="Commissions">
        <input v-model="query" type="search" placeholder="Search name, title, email, phone" aria-label="Search commissions" />
        <div class="chips" role="group" aria-label="Filter by status">
          <button v-for="f in FILTERS" :key="f.id" type="button" class="chip" :class="{ on: filter === f.id }" :aria-pressed="filter === f.id" @click="filter = f.id">
            {{ f.label }} <small>{{ count(f.id) }}</small>
          </button>
        </div>
        <p v-if="!loaded" class="hint">Loading…</p>
        <p v-else-if="!shown.length" class="hint">{{ items.length ? 'Nothing matches.' : 'No commissions yet. Take the first with New commission.' }}</p>
        <button v-for="c in shown" :key="c.id" type="button" class="row" :class="{ sel: c.id === openId, late: overdue(c) }" @click="open(c)">
          <span class="main"><strong>{{ c.title }}</strong><span class="hint">{{ c.customerName }}</span></span>
          <span class="side">
            <span class="badge" :class="c.status">{{ COMMISSION_STATUS_LABEL[c.status] }}</span>
            <span v-if="overdue(c)" class="late-tag">Overdue · {{ c.dueDate }}</span>
            <span v-else-if="c.dueDate && !isClosedStatus(c.status)" class="hint">Due {{ c.dueDate }}</span>
            <span v-if="c.price > 0 && !isClosedStatus(c.status)" class="hint">{{ c.balance > 0 ? `${money(c.balance, c)} to pay` : 'Paid' }}</span>
          </span>
        </button>

        <details v-if="isAdmin" class="settings" :open="showSettings" @toggle="showSettings = ($event.target as HTMLDetailsElement).open">
          <summary>Pickup details on the customer's page</summary>
          <label>Shop name <small>(blank: your account name)</small><input v-model="pickup.shopName" type="text" maxlength="80" /></label>
          <label>Collect from <input v-model="pickup.pickupName" type="text" maxlength="120" placeholder="Store or event name" /></label>
          <label>Address <textarea v-model="pickup.pickupAddress" rows="2" maxlength="300" /></label>
          <label>Note <input v-model="pickup.pickupNote" type="text" maxlength="300" placeholder="Opening hours, what to bring" /></label>
          <label>Default currency <input v-model="pickup.currency" type="text" maxlength="3" class="short" /></label>
          <label>Time zone <small>(times on the customer's page, e.g. Europe/Zurich)</small><input v-model="pickup.timeZone" type="text" maxlength="64" placeholder="UTC" /></label>
          <label>Keep customer details after the last commission closes <small>days, 0 to 365; 0 erases at the next check (every few hours). Then name, email, phone, notes and messages are erased.</small>
            <input v-model.number="pickup.keepCustomerDays" type="number" min="0" max="365" step="1" class="short" />
          </label>
          <button type="button" :disabled="busy" @click="saveSettings">Save</button>
        </details>
      </section>

      <section class="detail" aria-live="polite">
        <form v-if="creating || editing" class="card" @submit.prevent="submit()">
          <h2>{{ creating ? 'New commission' : 'Edit commission' }}</h2>
          <CustomerPicker v-if="creating" v-model="choice" :keep-days="settings.keepCustomerDays" :duplicates="duplicates" @use-duplicate="useDuplicate" @add-anyway="submit(true)" />
          <p v-else class="hint">For {{ current?.customerName }}. Change their details under Customers.</p>
          <label>Title <small>the customer sees this</small><input v-model="form.title" type="text" maxlength="120" required /></label>
          <label>Details <small>private to you and staff</small><textarea v-model="form.description" rows="3" maxlength="4000" /></label>
          <div class="two">
            <label>Price ({{ form.currency }}) <input v-model="form.price" type="text" inputmode="decimal" /></label>
            <label>Deposit asked <input v-model="form.depositAsked" type="text" inputmode="decimal" /></label>
          </div>
          <label>Due date <input v-model="form.dueDate" type="date" /></label>
          <label>Internal notes <small>never shown to the customer</small><textarea v-model="form.notes" rows="2" maxlength="4000" /></label>
          <div class="actions">
            <button type="submit" class="primary" :disabled="busy">Save</button>
            <button type="button" @click="creating = false; editing = false">Cancel</button>
          </div>
        </form>

        <article v-else-if="current" class="card">
          <header class="dh">
            <div>
              <h2>{{ current.title }}</h2>
              <p class="hint">{{ current.customerName }}<template v-if="current.email"> · {{ current.email }}</template><template v-if="current.phone"> · {{ current.phone }}</template></p>
              <button v-if="current.customerId" type="button" class="link" @click="showCustomer(current)">All commissions of this customer</button>
            </div>
            <span class="badge" :class="current.status">{{ COMMISSION_STATUS_LABEL[current.status] }}</span>
          </header>
          <p v-if="overdue(current)" class="warn">Overdue since {{ current.dueDate }}.</p>
          <p v-else-if="current.dueDate" class="hint">Due {{ current.dueDate }}</p>
          <dl class="money">
            <dt>Price</dt><dd>{{ current.price > 0 ? money(current.price, current) : 'Not set' }}</dd>
            <dt>Paid so far</dt><dd>{{ money(current.paid, current) }}<span v-if="current.depositAsked > 0 && current.paid < current.depositAsked" class="hint"> (deposit asked {{ money(current.depositAsked, current) }})</span></dd>
            <dt>Balance</dt><dd><strong>{{ money(current.balance, current) }}</strong></dd>
          </dl>
          <p class="hint">Take a deposit or the balance from the till: Commission button.</p>
          <p v-if="current.description" class="text">{{ current.description }}</p>
          <p v-if="current.notes" class="text note"><strong>Internal note:</strong> {{ current.notes }}</p>

          <div v-if="nextStatuses(current.status).length" class="statuses" role="group" aria-label="Move to">
            <button v-for="s in nextStatuses(current.status)" :key="s" type="button" :disabled="busy" @click="pickStatus(s)">{{ COMMISSION_STATUS_LABEL[s] }}</button>
          </div>
          <label class="msg">Message for the customer <small>shown on their page with the next update</small>
            <textarea v-model="message" rows="2" maxlength="500" placeholder="e.g. Sketch approved, starting the linework" />
          </label>
          <label v-if="current.email && emailEnabled" class="inline"><input v-model="sendEmail" type="checkbox" /> Email the customer this update</label>
          <button v-if="message.trim()" type="button" :disabled="busy" @click="move(undefined)">Post message only</button>

          <h3>Timeline</h3>
          <ol class="timeline">
            <li v-for="u in [...current.updates].reverse()" :key="u.id">
              <strong>{{ u.changed ? COMMISSION_STATUS_LABEL[u.status] : 'Message' }}</strong> <span class="hint">{{ stamp(u.at) }}</span>
              <p v-if="u.message" class="text">{{ u.message }}</p>
            </li>
          </ol>
          <ul v-if="current.payments.length" class="pays">
            <li v-for="p in current.payments" :key="p.saleId"><span>{{ p.label }} <small class="hint">{{ stamp(p.at) }}</small></span><strong>{{ money(p.amount, current) }}</strong></li>
          </ul>

          <h3>Customer link</h3>
          <div class="qr">
            <QrCode :value="link" :size="150" label="QR code for the customer's tracking page" />
            <div class="qr-side">
              <code class="url">{{ link }}</code>
              <div class="actions">
                <button type="button" @click="copyLink">Copy link</button>
                <button type="button" @click="shareLink">Share</button>
                <button type="button" :disabled="busy" @click="printSlip">Print slip</button>
                <button v-if="current.email && emailEnabled" type="button" :disabled="busy" @click="emailLink">Email link</button>
                <button v-if="isAdmin" type="button" :disabled="busy" @click="newLink">New link</button>
              </div>
            </div>
          </div>

          <div class="actions foot">
            <button type="button" @click="startEdit">Edit details</button>
            <button v-if="isAdmin" type="button" class="danger" :disabled="busy" @click="erase">Erase</button>
          </div>
        </article>

        <p v-else class="hint">Pick a commission to see it, or start a new one.</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.comm { display: flex; flex-direction: column; gap: .8rem; }
.top { display: flex; align-items: center; justify-content: space-between; gap: .6rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: 1.1rem; overflow-wrap: anywhere; }
h3 { margin: .6rem 0 0; font-size: .95rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
.warn { margin: 0; color: #9a3412; font-weight: 600; font-size: .9rem; }
.layout { display: grid; grid-template-columns: minmax(16rem, 22rem) 1fr; gap: 1rem; align-items: start; }
.list, .detail { display: flex; flex-direction: column; gap: .5rem; min-width: 0; }
.chips { display: flex; gap: .3rem; flex-wrap: wrap; }
.chip { font-size: .78rem; padding: .2rem .6rem; border-radius: 999px; min-height: 0; }
.chip.on { background: var(--zfy-accent, #0e7c66); color: #fff; }
.chip small { opacity: .7; }
.row { display: flex; justify-content: space-between; gap: .6rem; text-align: left; width: 100%; padding: .55rem .7rem; font-weight: 400; min-height: 3rem; }
.row.sel { outline: 2px solid var(--zfy-accent, #0e7c66); }
.row.late { border-left: 4px solid #c2410c; }
.main, .side { display: flex; flex-direction: column; gap: .1rem; min-width: 0; }
.main strong { overflow-wrap: anywhere; }
.side { align-items: flex-end; text-align: right; flex: none; }
.late-tag { color: #c2410c; font-weight: 700; font-size: .78rem; }
.badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; border-radius: 999px; padding: .1rem .55rem; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); white-space: nowrap; align-self: flex-start; }
.badge.cancelled { background: #fee2e2; color: #991b1b; }
.badge.collected { background: #e5e7eb; color: #374151; }
.badge.ready { background: #dbeafe; color: #1e40af; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .6rem; }
.dh { display: flex; justify-content: space-between; gap: .6rem; align-items: flex-start; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .875rem; }
label.inline { flex-direction: row; align-items: center; gap: .4rem; }
label small { color: var(--zfy-muted, #5a6472); font-size: .76rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.short { width: 5rem; }
.link { align-self: flex-start; padding: 0; min-height: 0; border: 0; background: none; color: var(--zfy-accent-ink, #0a5a4a); text-decoration: underline; font-size: .84rem; font-weight: 400; }
.actions { display: flex; gap: .5rem; flex-wrap: wrap; }
.foot { justify-content: space-between; margin-top: .4rem; }
.statuses { display: flex; gap: .4rem; flex-wrap: wrap; }
.money { display: grid; grid-template-columns: auto 1fr; gap: .2rem 1rem; margin: 0; font-size: .92rem; }
.money dd { margin: 0; }
.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .9rem; }
.note { background: var(--zfy-surface-2, #e9edf1); border-radius: 8px; padding: .4rem .6rem; }
.timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.pays { list-style: none; margin: 0; padding: .4rem 0 0; border-top: 1px solid var(--zfy-line, #d6dde4); display: flex; flex-direction: column; gap: .2rem; font-size: .88rem; }
.pays li { display: flex; justify-content: space-between; gap: .6rem; }
.qr { display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-start; }
.qr-side { display: flex; flex-direction: column; gap: .5rem; min-width: 0; flex: 1 1 14rem; }
.url { font-size: .75rem; overflow-wrap: anywhere; }
.settings { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .5rem; margin-top: .5rem; }
.settings summary { cursor: pointer; font-weight: 600; font-size: .9rem; }
.settings[open] > :not(summary) { margin-top: .5rem; }
@media (max-width: 800px) { .layout { grid-template-columns: 1fr; } .two { grid-template-columns: 1fr; } }
</style>
