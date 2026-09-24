<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { SalesEvent } from '@zollify/shared';
import { fmtPrice, toLocalPrice } from '@zollify/shared';
import { CountryPicker, CurrencyPicker, DateRangePicker, Icon, ModalShell } from '@zollify/ui';
import {
  activeEventId,
  claimsForEvent,
  currentAccount,
  deleteSalesEvent,
  fetchExchangeRate,
  recentTransactions,
  setActiveEvent,
  setClaim,
  shellConfirm,
  upsertSalesEvent,
  visibleEvents,
} from '@zollify/platform';

/**
 * Events - ZollTool's card grid. Upcoming and active first, soonest at the
 * top; finished ones below. Selling always goes through an event, so the
 * card is where you open it, sell for it, and close it again.
 */

const account = currentAccount;
const router = useRouter();
const canEdit = computed(() => account.value?.role === 'owner' || account.value?.role === 'admin');
const isHelper = computed(() => (account.value?.allowedEventIds?.length ?? 0) > 0);
const baseCurrency = computed(() => account.value?.profile.defaultCurrency ?? 'CHF');
const error = ref<string | null>(null);

const hasRoute = (name: string): boolean => router.hasRoute(name);

// Sort key = the event's date; undated events sort last.
const dateKey = (e: SalesEvent): string => e.dateStart || e.dateEnd || '￿';
const upcoming = computed(() =>
  visibleEvents.value.filter((e) => e.status !== 'closed').sort((a, b) => dateKey(a).localeCompare(dateKey(b)) || a.name.localeCompare(b.name)),
);
const finished = computed(() =>
  visibleEvents.value.filter((e) => e.status === 'closed').sort((a, b) => dateKey(b).localeCompare(dateKey(a)) || b.updatedAt - a.updatedAt),
);

/** Sales and revenue per event, in the event's base currency. */
const statsById = computed(() => {
  const map = new Map<string, { count: number; revenue: number; currency: string }>();
  for (const tx of recentTransactions.value) {
    if (tx.revertedAt) continue;
    const cur = map.get(tx.eventId) ?? { count: 0, revenue: 0, currency: tx.baseCurrency ?? tx.currency };
    cur.count++;
    cur.revenue += tx.baseTotal ?? tx.total;
    map.set(tx.eventId, cur);
  }
  return map;
});
const stats = (id: string) => statsById.value.get(id) ?? { count: 0, revenue: 0, currency: baseCurrency.value };

function fmtDates(e: SalesEvent): string {
  if (e.dateStart && e.dateEnd) return `${e.dateStart} → ${e.dateEnd}`;
  return e.dateStart || e.dateEnd || '';
}
function pill(e: SalesEvent): string {
  return e.id === activeEventId.value ? 'selling' : e.status;
}

// ── Actions ─────────────────────────────────────────────────────────────────
async function guard(work: () => Promise<void>): Promise<void> {
  error.value = null;
  try {
    await work();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Something went wrong.';
  }
}
const activate = (e: SalesEvent) =>
  guard(async () => {
    if (e.status !== 'active') await upsertSalesEvent({ ...e, status: 'active' });
    await setActiveEvent(e.id);
  });
const sell = (e: SalesEvent) =>
  guard(async () => {
    await activate(e);
    if (hasRoute('pos:index')) await router.push({ name: 'pos:index' });
  });
async function close(e: SalesEvent): Promise<void> {
  const ok = await shellConfirm('Closing stops sales for this event. Nothing is deleted - history and exports stay, and you can reopen it any time.', 'Close event?');
  if (!ok) return;
  await guard(async () => {
    const end = e.dateEnd || e.dateStart;
    const today = new Date().toISOString().slice(0, 10);
    // An event that has not happened yet parks back to planned rather than finishing.
    await upsertSalesEvent({ ...e, status: end && end > today ? 'planned' : 'closed' });
    if (activeEventId.value === e.id) await setActiveEvent(null);
  });
}
async function remove(e: SalesEvent): Promise<void> {
  const ok = await shellConfirm(
    'The event disappears from every device. Recorded sales are kept in History under "Removed event", but its claims and customs details go with it.',
    'Delete event?',
  );
  if (!ok) return;
  await guard(() => deleteSalesEvent(e.id));
}

// ── Editor ──────────────────────────────────────────────────────────────────
const ROUNDING = [
  ['0', 'No rounding'],
  ['1', '1'],
  ['5', '5'],
  ['10', '10'],
  ['20', '20'],
  ['50', '50'],
  ['100', '100'],
] as const;
const editing = ref(false);
const editId = ref<string | null>(null);
const fetchingRate = ref(false);
const rateError = ref('');
const form = reactive({
  name: '',
  dateStart: '',
  dateEnd: '',
  street: '',
  postcode: '',
  city: '',
  country: '',
  tin: '',
  localCurrency: '',
  exchangeRate: '',
  roundingIncrement: '0',
  copyStockFrom: '',
});

function openNew(): void {
  editId.value = null;
  Object.assign(form, {
    name: '',
    dateStart: '',
    dateEnd: '',
    street: '',
    postcode: '',
    city: '',
    country: account.value?.profile.artist.countryOfOrigin || 'Switzerland',
    tin: '',
    localCurrency: '',
    exchangeRate: '',
    roundingIncrement: '0',
    copyStockFrom: '',
  });
  rateError.value = '';
  error.value = null;
  editing.value = true;
}
function openEdit(e: SalesEvent): void {
  editId.value = e.id;
  Object.assign(form, {
    name: e.name,
    dateStart: e.dateStart ?? '',
    dateEnd: e.dateEnd ?? '',
    street: e.venue?.street ?? '',
    postcode: e.venue?.postcode ?? '',
    city: e.venue?.city ?? '',
    country: e.venue?.country ?? '',
    tin: e.venue?.tin ?? '',
    localCurrency: e.localCurrency ?? '',
    exchangeRate: e.exchangeRate != null ? String(e.exchangeRate) : '',
    roundingIncrement: String(e.roundingIncrement ?? 0),
    copyStockFrom: '',
  });
  rateError.value = '';
  error.value = null;
  editing.value = true;
}

async function fetchRate(): Promise<void> {
  if (!form.localCurrency.trim()) return;
  fetchingRate.value = true;
  rateError.value = '';
  const rate = await fetchExchangeRate(baseCurrency.value, form.localCurrency);
  fetchingRate.value = false;
  if (rate == null) {
    rateError.value = 'Could not fetch a rate - enter it by hand.';
    return;
  }
  form.exchangeRate = String(rate);
}

const localExample = computed(() => {
  const rate = parseFloat(form.exchangeRate);
  if (!form.localCurrency || !(rate > 0)) return '';
  return `${baseCurrency.value} 100 is charged as ${form.localCurrency} ${toLocalPrice(100, rate, Number(form.roundingIncrement) || 0).toFixed(2)}`;
});

async function save(): Promise<void> {
  if (!form.name.trim()) {
    error.value = 'Give the event a name before saving.';
    return;
  }
  const existing = editId.value ? visibleEvents.value.find((e) => e.id === editId.value) : undefined;
  const local = form.localCurrency.trim().toUpperCase();
  const rate = parseFloat(form.exchangeRate);
  const converting = Boolean(local) && Number.isFinite(rate) && rate > 0;
  const event: SalesEvent = {
    ...existing,
    id: editId.value ?? crypto.randomUUID(),
    name: form.name.trim(),
    dateStart: form.dateStart || undefined,
    dateEnd: form.dateEnd || undefined,
    venue: {
      street: form.street.trim() || undefined,
      postcode: form.postcode.trim() || undefined,
      city: form.city.trim() || undefined,
      country: form.country.trim() || undefined,
      tin: form.tin.trim() || undefined,
    },
    currency: baseCurrency.value,
    localCurrency: converting ? local : undefined,
    exchangeRate: converting ? rate : undefined,
    roundingIncrement: Number(form.roundingIncrement) || 0,
    status: existing?.status ?? 'planned',
    updatedAt: Date.now(),
  };
  await guard(async () => {
    await upsertSalesEvent(event);
    if (!existing && form.copyStockFrom) {
      for (const row of claimsForEvent(form.copyStockFrom)) await setClaim(event.id, row.productId, row.variantId, row.broughtQty);
    }
    editing.value = false;
    if (!existing && !activeEventId.value) await activate(event);
  });
}
</script>

<template>
  <section class="events">
    <header>
      <h1>Events</h1>
      <button v-if="canEdit" type="button" class="primary" @click="openNew"><Icon name="plus" :size="16" /> New event</button>
    </header>

    <p v-if="isHelper" class="hint">You're set up as a helper, so you only see the events you've been given.</p>
    <p v-if="error && !editing" class="error" role="alert">{{ error }}</p>

    <p v-if="!visibleEvents.length" class="empty">No events yet. Create one to start selling - every sale is recorded against the active event.</p>

    <template v-for="group in [{ label: '', list: upcoming }, { label: 'Finished', list: finished }]" :key="group.label">
      <h2 v-if="group.label && group.list.length" class="group">{{ group.label }}</h2>
      <ul v-if="group.list.length" class="grid">
        <li v-for="e in group.list" :key="e.id" :class="['card', { active: e.id === activeEventId }]">
          <div class="title">
            <strong>{{ e.name }}</strong>
            <span :class="['pill', pill(e)]">{{ pill(e) }}</span>
          </div>
          <p class="when">{{ fmtDates(e) }}<template v-if="e.venue?.city"> · {{ e.venue.city }}</template><template v-if="e.localCurrency"> · {{ e.currency }} → {{ e.localCurrency }}</template></p>
          <p class="stats">{{ stats(e.id).count }} sale{{ stats(e.id).count === 1 ? '' : 's' }} · {{ fmtPrice(stats(e.id).revenue, stats(e.id).currency) }}</p>
          <div class="actions">
            <button v-if="e.status === 'planned'" type="button" class="primary" @click="activate(e)"><Icon name="door-open" :size="14" /> Open</button>
            <button v-else-if="e.status === 'active'" type="button" class="primary" @click="sell(e)"><Icon name="shopping-cart" :size="14" /> Sell</button>
            <button v-else type="button" @click="activate(e)">Reopen</button>
            <router-link :to="{ name: 'history', query: { event: e.id } }" class="btn"><Icon name="bar-chart" :size="14" /> History</router-link>
            <router-link v-if="canEdit && e.localCurrency" :to="{ name: 'prices', params: { eventId: e.id } }" class="btn"><Icon name="coins" :size="14" /> Prices</router-link>
            <router-link v-if="hasRoute('customs-ch:documents')" :to="{ name: 'customs-ch:documents', params: { eventId: e.id } }" class="btn"><Icon name="file-text" :size="14" /> Customs (CH)</router-link>
            <router-link v-if="hasRoute('customs-de:documents')" :to="{ name: 'customs-de:documents', params: { eventId: e.id } }" class="btn"><Icon name="file-text" :size="14" /> Customs (DE)</router-link>
            <button v-if="canEdit" type="button" @click="openEdit(e)">Edit</button>
            <button v-if="canEdit && e.status !== 'closed'" type="button" class="quiet" @click="close(e)">Close</button>
            <!-- Deleting is two steps on purpose: close first, then delete. -->
            <button v-if="canEdit && e.status === 'closed'" type="button" class="quiet danger" @click="remove(e)">Delete</button>
          </div>
        </li>
      </ul>
    </template>

    <ModalShell v-if="editing" :title="editId ? 'Edit event' : 'New event'" @close="editing = false">
      <div class="form">
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <label><span>Name</span><input v-model="form.name" type="text" required /></label>
        <label><span>Dates</span><DateRangePicker v-model:start="form.dateStart" v-model:end="form.dateEnd" /></label>
        <div class="two">
          <label><span>Street</span><input v-model="form.street" type="text" /></label>
          <label><span>City</span><input v-model="form.city" type="text" /></label>
          <label><span>Postcode</span><input v-model="form.postcode" type="text" /></label>
          <label><span>Country</span><CountryPicker v-model="form.country" store="name" /></label>
        </div>
        <label><span>Organiser tax id (optional)</span><input v-model="form.tin" type="text" placeholder="For customs paperwork" /></label>

        <fieldset>
          <legend>Currency</legend>
          <p class="hint">Books are always kept in {{ baseCurrency }} (Settings → Booth profile). Charging in another currency is for a convention abroad - the till charges the converted amount, books stay in {{ baseCurrency }}. Leave blank to sell in {{ baseCurrency }} directly.</p>
          <div class="three">
            <label><span>Local currency</span><CurrencyPicker v-model="form.localCurrency" placeholder="SEK" /></label>
            <label><span>Rate (1 {{ baseCurrency }} =)</span><input v-model="form.exchangeRate" type="number" min="0" step="0.0001" inputmode="decimal" /></label>
            <label>
              <span>Round to nearest</span>
              <select v-model="form.roundingIncrement"><option v-for="[v, l] in ROUNDING" :key="v" :value="v">{{ l }}</option></select>
            </label>
          </div>
          <div class="rate">
            <button type="button" :disabled="!form.localCurrency.trim() || fetchingRate" @click="fetchRate">
              <Icon name="refresh-cw" :size="14" /> {{ fetchingRate ? 'Fetching…' : "Fetch today's rate" }}
            </button>
            <span v-if="rateError" class="warn">{{ rateError }}</span>
            <span v-else-if="localExample" class="hint">{{ localExample }}</span>
          </div>
        </fieldset>

        <label v-if="!editId">
          <span>Copy stock claims from</span>
          <select v-model="form.copyStockFrom">
            <option value="">- don't copy -</option>
            <option v-for="e in visibleEvents" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
        </label>
      </div>
      <template #footer>
        <div class="footer">
          <button type="button" @click="editing = false">Cancel</button>
          <button type="button" class="primary" :disabled="!form.name.trim()" @click="save">{{ editId ? 'Save' : 'Create' }}</button>
        </div>
      </template>
    </ModalShell>
  </section>
</template>

<style scoped>
.events { display: flex; flex-direction: column; gap: 1rem; max-width: 72rem; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
h1 { margin: 0; font-size: 1.35rem; }
header .primary { display: inline-flex; align-items: center; gap: .4rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .82rem; }
.warn { color: var(--zfy-warning-ink, #8a5a1e); font-size: .82rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.group { margin: .5rem 0 0; font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; color: var(--zfy-muted, #5a6472); }
.grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: .75rem; }
.card { display: flex; flex-direction: column; gap: .35rem; padding: .9rem 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
.card.active { border-color: var(--zfy-accent, #0e7c66); box-shadow: 0 0 0 1px var(--zfy-accent, #0e7c66); }
.title { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.title strong { font-size: 1rem; }
.pill { font-size: .66rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; border-radius: 999px; padding: .15rem .5rem; background: var(--zfy-bg, #f1f4f6); color: var(--zfy-muted, #5a6472); }
.pill.selling, .pill.active { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.pill.planned { background: var(--zfy-signal-soft, #e4ecf6); color: var(--zfy-ink, #1a2230); }
.when { margin: 0; font-size: .8rem; color: var(--zfy-muted, #5a6472); font-variant-numeric: tabular-nums; }
.stats { margin: 0; font-size: .875rem; }
.actions { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .4rem; }
.actions button, .actions .btn { min-height: 2.2rem; padding: .2rem .7rem; font-size: .78rem; display: inline-flex; align-items: center; gap: .3rem; }
.btn { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; background: var(--zfy-surface, #fff); color: var(--zfy-ink, #1a2230); font-weight: 500; text-decoration: none; }
.btn:hover { background: var(--zfy-bg, #f1f4f6); }
.form { display: flex; flex-direction: column; gap: .7rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.three { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: .6rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .6rem; }
legend { font-size: .8rem; font-weight: 600; padding: 0 .3rem; }
.rate { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.rate button { min-height: 2.2rem; font-size: .8rem; display: inline-flex; align-items: center; gap: .3rem; }
.footer { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
