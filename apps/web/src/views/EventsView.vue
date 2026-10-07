<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { SalesEvent, SalesEventKind } from '@zollify/shared';
import { BOOTH_LIMITS, boothFieldsForDuplicate, boothLayoutLabel, cleanBooth, safeHttpsUrl, sanitizeBoothLayout, VAT_RATES, countryCodeOf, fmtPrice, isStore, fmtRate, resolveEventVat, seesSalesTotals, toLocalPrice, type BoothLayout, type EventVat } from '@zollify/shared';
import BoothLayoutModal from './BoothLayoutModal.vue';
import EventNotesModal from './EventNotesModal.vue';
import EventSeriesModal from '../components/EventSeriesModal.vue';
import { CountryPicker, CurrencyPicker, DateRangePicker, Icon, ModalShell } from '@zollify/ui';
import {
  activeEventId,
  claimUnsoldFrom,
  claimsForEvent,
  currentAccount,
  deleteSalesEvent,
  eventIsOver,
  eventPricing,
  fetchExchangeRate,
  recentTransactions,
  removeAllEventFiles,
  setActiveEvent,
  setClaim,
  shellConfirm,
  upsertSalesEvent,
  visibleEvents,
} from '@zollify/platform';

/**
 * Events - ZollTool's card grid. Stores (permanent shops) first, then
 * upcoming and active events, soonest at the top; finished ones below.
 * Selling always goes through an event or a store, so the card is where you
 * open it, sell for it, and close it again.
 */

const account = currentAccount;
const router = useRouter();
/**
 * Events (fairs, markets, conventions - dated) and Stores (shops - open until
 * closed) are separate pages on the same screen: an account sees the ones it
 * runs (Settings → Business profile → What you run).
 */
const props = withDefaults(defineProps<{ mode?: 'events' | 'stores' }>(), { mode: 'events' });
const storesPage = computed(() => props.mode === 'stores');
const canEdit = computed(() => account.value?.role === 'owner' || account.value?.role === 'admin');
/** Staff see takings only when the owner allows it (Settings → Team). */
const showTotals = computed(() => seesSalesTotals(account.value));
const isHelper = computed(() => (account.value?.allowedEventIds?.length ?? 0) > 0);
const baseCurrency = computed(() => account.value?.profile.defaultCurrency ?? 'CHF');
const error = ref<string | null>(null);

const hasRoute = (name: string): boolean => router.hasRoute(name);
// One Customs button per event; the hub then asks which country's paperwork.
const customsOn = (): boolean =>
  hasRoute('customs-hub:index') && (hasRoute('customs-ch:documents') || hasRoute('customs-de:documents'));

// Sort key = the event's date; undated events sort last.
const dateKey = (e: SalesEvent): string => e.dateStart || e.dateEnd || '￿';
const stores = computed(() =>
  visibleEvents.value.filter((e) => isStore(e)).sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || a.name.localeCompare(b.name)),
);
/** What this page lists, in groups. */
const groups = computed(() =>
  storesPage.value
    ? [
        { label: '', list: stores.value.filter((e) => e.status !== 'closed') },
        { label: 'Closed', list: stores.value.filter((e) => e.status === 'closed') },
      ]
    : [
        { label: '', list: upcoming.value },
        { label: 'Finished', list: finished.value },
      ],
);
const listed = computed(() => groups.value.reduce((n, g) => n + g.list.length, 0));
const upcoming = computed(() =>
  visibleEvents.value.filter((e) => !isStore(e) && e.status !== 'closed').sort((a, b) => dateKey(a).localeCompare(dateKey(b)) || a.name.localeCompare(b.name)),
);
const finished = computed(() =>
  visibleEvents.value.filter((e) => !isStore(e) && e.status === 'closed').sort((a, b) => dateKey(b).localeCompare(dateKey(a)) || b.updatedAt - a.updatedAt),
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
  if (e.id === activeEventId.value) return 'selling';
  // A store has no dates to be "planned" for - it is open or it is not.
  if (isStore(e)) return e.status === 'active' ? 'open' : 'closed';
  return e.status;
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
  const ok = isStore(e)
    ? await shellConfirm('Closing stops sales at this store. Nothing is deleted - history, stock and consignment statements stay, and you can reopen it any time.', 'Close store?')
    : await shellConfirm('Closing stops sales for this event. Nothing is deleted - history and exports stay, and you can reopen it any time.', 'Close event?');
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
  const what = isStore(e) ? 'store' : 'event';
  const ok = await shellConfirm(
    `The ${what} disappears from every device. Recorded sales are kept in History under "Removed event", but its claims and customs details go with it.`,
    `Delete ${what}?`,
  );
  if (!ok) return;
  await guard(async () => {
    await removeAllEventFiles(e);
    await deleteSalesEvent(e.id);
  });
}

const posOn = (): boolean => hasRoute('pos:index');

// ── The "more" menu ─────────────────────────────────────────────────────────
// A tile keeps its main action and History; the rest lives in a menu.
const menuFor = ref<string | null>(null);
const closeMenu = (): void => {
  menuFor.value = null;
};
onMounted(() => window.addEventListener('click', closeMenu));
onBeforeUnmount(() => window.removeEventListener('click', closeMenu));
/** Whether the menu has anything in it for this tile (a helper may have nothing). */
const hasMore = (e: SalesEvent): boolean =>
  canEdit.value || Boolean(notesBadge(e)) || Boolean(layoutNote(e)) || (customsOn() && !isStore(e));

// ── Booth layout ────────────────────────────────────────────────────────────
const layoutFor = ref<string | null>(null);
/** The tile's layout line; a stored layout is re-checked, so a bad one just shows nothing. */
const layoutNote = (e: SalesEvent): string => {
  const layout = sanitizeBoothLayout(e.boothLayout);
  return layout ? boothLayoutLabel(layout) : '';
};

// ── Notes & files ───────────────────────────────────────────────────────────
const notesFor = ref<string | null>(null);
// ── Editions ────────────────────────────────────────────────────────────────
const seriesFor = ref<string | null>(null);
function openPlanner(id: string): void {
  seriesFor.value = null;
  void router.push({ name: 'event-plan', params: { eventId: id } });
}
/** Whether a card has anything to read, so a helper only gets the button when there is. */
const notesBadge = (e: SalesEvent): string => {
  const files = e.attachments?.length ?? 0;
  return files ? String(files) : e.notes?.trim() ? '•' : '';
};

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
/** What the editor is creating or editing - a store has no dates. */
const editKind = ref<SalesEventKind>('event');
const kindLabel = computed(() => (editKind.value === 'store' ? 'store' : 'event'));
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
  boothHall: '',
  boothNumber: '',
  boothLink: '',
  boothNote: '',
  noPool: false,
  localCurrency: '',
  exchangeRate: '',
  roundingIncrement: '0',
  copyStockFrom: '',
  /** 'claims' copies the claims as they were; 'unsold' claims only what that event did not sell. */
  stockMode: 'unsold' as 'claims' | 'unsold',
  /** VAT: 'auto' follows the country and Settings → VAT; rates blank = the country's. */
  vatMode: 'auto' as 'auto' | 'charge' | 'exempt',
  vatStandard: '',
  vatReduced: '',
  /** Event whose price overrides come along - only while the local currency still matches it. */
  pricesFrom: '',
});

/** Booth layout carried over by Duplicate; stored with the new event on save. */
const carriedLayout = ref<BoothLayout | undefined>();
/** Set when Duplicate filled in booth details or a layout, so the dialog can ask for a check. */
const boothCopied = ref(false);

function openNew(kind: SalesEventKind = 'event'): void {
  editId.value = null;
  carriedLayout.value = undefined;
  boothCopied.value = false;
  editKind.value = kind;
  Object.assign(form, {
    name: '',
    dateStart: '',
    dateEnd: '',
    street: '',
    postcode: '',
    city: '',
    country: account.value?.profile.artist.countryOfOrigin || 'Switzerland',
    tin: '',
    boothHall: '',
    boothNumber: '',
    boothLink: '',
    boothNote: '',
    noPool: false,
    localCurrency: '',
    exchangeRate: '',
    roundingIncrement: '0',
    copyStockFrom: '',
    stockMode: 'unsold',
    vatMode: 'auto',
    vatStandard: '',
    vatReduced: '',
    pricesFrom: '',
  });
  rateError.value = '';
  error.value = null;
  editing.value = true;
}
/**
 * A new event prefilled from an existing one - venue, currency, rate,
 * rounding and price overrides - for back-to-back shows in the same country.
 * Dates start blank. Stock defaults to what the source did not sell once it
 * is over, since that is what is physically carried on to the next show.
 */
function openDuplicate(e: SalesEvent): void {
  openNew(e.kind ?? 'event');
  const carried = boothFieldsForDuplicate(e);
  carriedLayout.value = carried.boothLayout;
  boothCopied.value = Boolean(carried.booth || carried.boothLayout);
  Object.assign(form, {
    name: `${e.name} (copy)`,
    boothHall: carried.booth?.hall ?? '',
    boothNumber: carried.booth?.number ?? '',
    boothLink: carried.booth?.link ?? '',
    boothNote: carried.booth?.note ?? '',
    noPool: Boolean(carried.noPool),
    street: e.venue?.street ?? '',
    postcode: e.venue?.postcode ?? '',
    city: e.venue?.city ?? '',
    country: e.venue?.country ?? '',
    tin: e.venue?.tin ?? '',
    localCurrency: e.localCurrency ?? '',
    exchangeRate: e.exchangeRate != null ? String(e.exchangeRate) : '',
    roundingIncrement: String(e.roundingIncrement ?? 0),
    copyStockFrom: claimsForEvent(e.id).length ? e.id : '',
    stockMode: eventIsOver(e) ? 'unsold' : 'claims',
    pricesFrom: e.id,
    ...vatFormOf(e.vat),
  });
}
const vatFormOf = (vat: EventVat | undefined) => ({
  vatMode: vat?.mode ?? 'auto',
  vatStandard: vat?.standard != null ? String(vat.standard) : '',
  vatReduced: vat?.reduced != null ? String(vat.reduced) : '',
});
function openEdit(e: SalesEvent): void {
  editId.value = e.id;
  editKind.value = e.kind ?? 'event';
  Object.assign(form, {
    name: e.name,
    dateStart: e.dateStart ?? '',
    dateEnd: e.dateEnd ?? '',
    street: e.venue?.street ?? '',
    postcode: e.venue?.postcode ?? '',
    city: e.venue?.city ?? '',
    country: e.venue?.country ?? '',
    tin: e.venue?.tin ?? '',
    boothHall: e.booth?.hall ?? '',
    boothNumber: e.booth?.number ?? '',
    boothLink: e.booth?.link ?? '',
    boothNote: e.booth?.note ?? '',
    noPool: Boolean(e.noPool),
    localCurrency: e.localCurrency ?? '',
    exchangeRate: e.exchangeRate != null ? String(e.exchangeRate) : '',
    roundingIncrement: String(e.roundingIncrement ?? 0),
    copyStockFrom: '',
    stockMode: 'unsold',
    ...vatFormOf(e.vat),
    pricesFrom: '',
  });
  rateError.value = '';
  error.value = null;
  editing.value = true;
}

const pricesSource = computed(() => (form.pricesFrom ? visibleEvents.value.find((e) => e.id === form.pricesFrom) : undefined));
const overrideCount = (e: SalesEvent | undefined): number =>
  Object.keys(e?.localPriceOverrides ?? {}).length + Object.keys(e?.localTierOverrides ?? {}).length;
/** Overrides are prices in one currency - they only carry over while the currency still matches. */
const pricesCarry = computed(() => {
  const src = pricesSource.value;
  return Boolean(src?.localCurrency) && src!.localCurrency === form.localCurrency.trim().toUpperCase();
});
/** Picking an event to copy prices from fills the currency fields to match it. */
function pickPricesFrom(): void {
  const src = pricesSource.value;
  if (!src) return;
  form.localCurrency = src.localCurrency ?? '';
  form.exchangeRate = src.exchangeRate != null ? String(src.exchangeRate) : '';
  form.roundingIncrement = String(src.roundingIncrement ?? 0);
}

const stockSource = computed(() => (form.copyStockFrom ? visibleEvents.value.find((e) => e.id === form.copyStockFrom) : undefined));
/** The source still reserves its own claims until it is over, so copying them as-is would hold the same stock twice. */
const stockSourceRunning = computed(() => Boolean(stockSource.value) && !eventIsOver(stockSource.value));

// ── VAT ─────────────────────────────────────────────────────────────────────
const vatCountry = computed(() => countryCodeOf(form.country));
const countryRates = computed(() => VAT_RATES[vatCountry.value]);
const parseRate = (v: string): number | undefined => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 && n < 100 ? n : undefined;
};
function formVat(): EventVat | undefined {
  const vat: EventVat = {};
  if (form.vatMode !== 'auto') vat.mode = form.vatMode;
  const standard = parseRate(form.vatStandard);
  const reduced = parseRate(form.vatReduced);
  if (standard != null) vat.standard = standard;
  if (reduced != null) vat.reduced = reduced;
  return Object.keys(vat).length ? vat : undefined;
}
/** What this event's receipts will say, as the form stands. */
const vatPreview = computed(() => {
  const r = resolveEventVat({ venue: { country: form.country }, vat: formVat() }, account.value?.profile);
  if (r.exempt) return `Exempt - receipts say “${r.note}”${r.exNumber ? ` with EX ${r.exNumber}` : ''}.`;
  if (r.standard == null) return 'No VAT rates known for this country - enter them, or sales are recorded without VAT.';
  return `Charging ${fmtRate(r.standard)}${r.reduced != null && r.reduced !== r.standard ? `, ${fmtRate(r.reduced)} on reduced products` : ''}.`;
});
/** Short VAT summary for an event card. */
function vatSummary(e: SalesEvent): string {
  const r = resolveEventVat(e, account.value?.profile);
  if (r.exempt) return 'VAT exempt';
  return r.standard != null ? `VAT ${fmtRate(r.standard)}` : '';
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
    error.value = `Give the ${kindLabel.value} a name before saving.`;
    return;
  }
  const store = editKind.value === 'store';
  if (!store && form.boothLink.trim() && !safeHttpsUrl(form.boothLink)) {
    error.value = 'The booth link must start with https://';
    return;
  }
  const existing = editId.value ? visibleEvents.value.find((e) => e.id === editId.value) : undefined;
  const local = form.localCurrency.trim().toUpperCase();
  const rate = parseFloat(form.exchangeRate);
  const converting = Boolean(local) && Number.isFinite(rate) && rate > 0;
  const pricing = !existing && pricesCarry.value && pricesSource.value ? eventPricing(pricesSource.value) : {};
  const event: SalesEvent = {
    ...existing,
    // Overrides only; currency, rate and rounding come from the form below.
    ...pricing,
    id: editId.value ?? crypto.randomUUID(),
    name: form.name.trim(),
    // 'event' is left implicit, so events keep the shape they always had.
    kind: store ? 'store' : undefined,
    dateStart: store ? undefined : form.dateStart || undefined,
    dateEnd: store ? undefined : form.dateEnd || undefined,
    venue: {
      street: form.street.trim() || undefined,
      postcode: form.postcode.trim() || undefined,
      city: form.city.trim() || undefined,
      country: form.country.trim() || undefined,
      tin: form.tin.trim() || undefined,
    },
    booth: store ? undefined : cleanBooth({ hall: form.boothHall, number: form.boothNumber, link: form.boothLink, note: form.boothNote }),
    noPool: store || !form.noPool ? undefined : true,
    boothLayout: !existing && !store ? carriedLayout.value : existing?.boothLayout,
    currency: baseCurrency.value,
    localCurrency: converting ? local : undefined,
    exchangeRate: converting ? rate : undefined,
    roundingIncrement: Number(form.roundingIncrement) || 0,
    vat: formVat(),
    // A store has no dates to wait for, so it opens as soon as it exists.
    status: existing?.status ?? (store ? 'active' : 'planned'),
    updatedAt: Date.now(),
  };
  await guard(async () => {
    await upsertSalesEvent(event);
    if (!existing && form.copyStockFrom) {
      if (form.stockMode === 'unsold') await claimUnsoldFrom(form.copyStockFrom, event.id);
      else for (const row of claimsForEvent(form.copyStockFrom)) await setClaim(event.id, row.productId, row.variantId, row.broughtQty);
    }
    editing.value = false;
    if (!existing && !activeEventId.value) await activate(event);
  });
}
</script>

<template>
  <section class="events">
    <header>
      <h1>{{ storesPage ? 'Stores' : 'Events' }}</h1>
      <div v-if="canEdit" class="header-actions">
        <button v-if="storesPage" type="button" class="primary" @click="openNew('store')"><Icon name="plus" :size="16" /> New store</button>
        <button v-else type="button" class="primary" @click="openNew('event')"><Icon name="plus" :size="16" /> New event</button>
      </div>
    </header>

    <p v-if="isHelper" class="hint">You're set up as a helper, so you only see the events you've been given.</p>
    <p v-if="error && !editing" class="error" role="alert">{{ error }}</p>

    <p v-if="!listed && storesPage" class="empty">No stores yet. A store is open until you close it - no dates - and sells through the till like an event.</p>
    <p v-else-if="!listed" class="empty">No events yet. Create one to start selling - every sale is recorded against the active event.</p>

    <template v-for="group in groups" :key="group.label">
      <h2 v-if="group.label && group.list.length" class="group">{{ group.label }}</h2>
      <ul v-if="group.list.length" class="grid">
        <li v-for="e in group.list" :key="e.id" :class="['card', { active: e.id === activeEventId }]">
          <div class="title">
            <strong>{{ e.name }}</strong>
            <span v-if="e.edition" class="pill">{{ e.edition }}</span>
            <span :class="['pill', pill(e)]">{{ pill(e) }}</span>
          </div>
          <p class="when"><template v-if="isStore(e)">Store</template>{{ fmtDates(e) }}<template v-if="e.venue?.city"> · {{ e.venue.city }}</template><template v-if="e.localCurrency"> · {{ e.currency }} → {{ e.localCurrency }}</template><template v-if="vatSummary(e)"> · {{ vatSummary(e) }}</template></p>
          <p v-if="showTotals" class="stats">{{ stats(e.id).count }} sale{{ stats(e.id).count === 1 ? '' : 's' }} · {{ fmtPrice(stats(e.id).revenue, stats(e.id).currency) }}</p>
          <p v-if="layoutNote(e)" class="layout-note"><Icon name="layers" :size="12" /> Layout: {{ layoutNote(e) }}</p>
          <div class="actions">
            <button v-if="e.status === 'planned'" type="button" class="primary" @click="sell(e)"><Icon name="door-open" :size="14" /> Open</button>
            <button v-else-if="e.status === 'active' && posOn()" type="button" class="primary" @click="sell(e)"><Icon name="shopping-cart" :size="14" /> Sell</button>
            <button v-else-if="e.status === 'closed'" type="button" @click="sell(e)">Reopen</button>
            <router-link :to="{ name: 'history', query: { event: e.id } }" class="btn"><Icon name="bar-chart" :size="14" /> History</router-link>
            <div v-if="hasMore(e)" class="more" @click.stop>
              <button type="button" :aria-expanded="menuFor === e.id" aria-haspopup="menu" aria-label="More actions" @click="menuFor = menuFor === e.id ? null : e.id"><Icon name="more" :size="16" /></button>
              <div v-if="menuFor === e.id" class="menu" role="menu" @click="menuFor = null">
                <button v-if="canEdit || notesBadge(e)" type="button" role="menuitem" @click="notesFor = e.id"><Icon name="paperclip" :size="14" /> Notes &amp; files<template v-if="notesBadge(e)"> · {{ notesBadge(e) }}</template></button>
                <button v-if="canEdit || layoutNote(e)" type="button" role="menuitem" @click="layoutFor = e.id"><Icon name="layers" :size="14" /> Booth layout<template v-if="layoutNote(e)"> · set</template></button>
                <router-link v-if="canEdit && e.localCurrency" :to="{ name: 'prices', params: { eventId: e.id } }" role="menuitem"><Icon name="coins" :size="14" /> Prices</router-link>
                <router-link v-if="customsOn() && !isStore(e)" :to="{ name: 'customs-hub:index', query: { event: e.id } }" role="menuitem"><Icon name="file-text" :size="14" /> Customs</router-link>
                <button v-if="canEdit" type="button" role="menuitem" @click="openEdit(e)"><Icon name="settings" :size="14" /> Edit</button>
                <button v-if="canEdit" type="button" role="menuitem" @click="openDuplicate(e)"><Icon name="copy" :size="14" /> Duplicate</button>
                <button v-if="(canEdit || e.seriesId) && !isStore(e)" type="button" role="menuitem" @click="seriesFor = e.id"><Icon name="calendar" :size="14" /> Editions</button>
                <!-- Only meaningful for an active event - close() on a planned one
                     just re-confirms 'planned' (it parks a not-yet-started event
                     back there instead of closing it), so showing it there was
                     a dead-end button doing nothing. -->
                <button v-if="canEdit && e.status === 'active'" type="button" role="menuitem" @click="close(e)"><Icon name="x" :size="14" /> Close</button>
                <!-- Deleting an active event is two steps on purpose: close first,
                     then delete - it may have real sales/claims to protect. A
                     planned event can't have any of that yet (it was never
                     opened), so it deletes directly; forcing "close" on it first
                     was also a dead end anyway - close() parks a not-yet-started
                     event straight back to 'planned' (see close() above) instead
                     of ever reaching 'closed', so the button below would never
                     have appeared for it. -->
                <button v-if="canEdit && (e.status === 'closed' || e.status === 'planned')" type="button" role="menuitem" class="danger" @click="remove(e)"><Icon name="trash" :size="14" /> Delete</button>
              </div>
            </div>
          </div>
        </li>
      </ul>
    </template>

    <EventSeriesModal v-if="seriesFor" :event-id="seriesFor" :can-edit="canEdit" @close="seriesFor = null" @planner="openPlanner" />
    <EventNotesModal v-if="notesFor" :event-id="notesFor" :can-edit="canEdit" @close="notesFor = null" />
    <BoothLayoutModal v-if="layoutFor" :event-id="layoutFor" :can-edit="canEdit" @close="layoutFor = null" />

    <ModalShell v-if="editing" :title="`${editId ? 'Edit' : 'New'} ${kindLabel}`" @close="editing = false">
      <div class="form">
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <label><span>Name</span><input v-model="form.name" type="text" required /></label>
        <label v-if="editKind === 'event'"><span>Dates</span><DateRangePicker v-model:start="form.dateStart" v-model:end="form.dateEnd" /></label>
        <p v-else class="hint">A store is open until you close it - no dates. Its stock claims reserve what is on its shelves, and it sells through the till like an event.</p>
        <div class="two">
          <label><span>Street</span><input v-model="form.street" type="text" /></label>
          <label><span>City</span><input v-model="form.city" type="text" /></label>
          <label><span>Postcode</span><input v-model="form.postcode" type="text" /></label>
          <label><span>Country</span><CountryPicker v-model="form.country" store="name" /></label>
        </div>
        <label v-if="editKind === 'event'"><span>Organiser tax id (optional)</span><input v-model="form.tin" type="text" placeholder="For customs paperwork" /></label>

        <fieldset v-if="editKind === 'event'">
          <legend>Booth</legend>
          <div class="two">
            <label><span>Hall</span><input v-model="form.boothHall" type="text" :maxlength="BOOTH_LIMITS.hall" placeholder="3" /></label>
            <label><span>Booth number</span><input v-model="form.boothNumber" type="text" :maxlength="BOOTH_LIMITS.number" placeholder="B-12" /></label>
          </div>
          <label><span>Link</span><input v-model="form.boothLink" type="url" :maxlength="BOOTH_LIMITS.link" placeholder="https://…" /></label>
          <label><span>Note for visitors</span><input v-model="form.boothNote" type="text" :maxlength="BOOTH_LIMITS.note" placeholder="New prints, limited pins." /></label>
          <p v-if="boothCopied" class="warn">Hall, booth number and layout were copied - check them.</p>
          <p class="hint">Shown on your public events page, widget, calendar and Instagram bio.</p>
          <label class="check"><input v-model="form.noPool" type="checkbox" /> <span>Do not share this event with the community</span></label>
          <p class="hint">For private or invite-only events. Only matters if you share your events (Settings, Event sharing).</p>
        </fieldset>

        <fieldset>
          <legend>Currency</legend>
          <label v-if="!editId">
            <span>Match prices from</span>
            <select v-model="form.pricesFrom" @change="pickPricesFrom">
              <option value="">- don't copy -</option>
              <option v-for="e in visibleEvents.filter((v) => v.localCurrency)" :key="e.id" :value="e.id">{{ e.name }} ({{ e.localCurrency }})</option>
            </select>
          </label>
          <p v-if="pricesSource && overrideCount(pricesSource)" :class="pricesCarry ? 'hint' : 'warn'">
            <template v-if="pricesCarry">{{ overrideCount(pricesSource) }} price override{{ overrideCount(pricesSource) === 1 ? '' : 's' }} from {{ pricesSource.name }} come along.</template>
            <template v-else>The local currency no longer matches {{ pricesSource.name }}, so its price overrides are not copied.</template>
          </p>
          <p class="hint">Books are always kept in {{ baseCurrency }} (Settings → Business profile). Charging in another currency is for a convention abroad - the till charges the converted amount, books stay in {{ baseCurrency }}. Leave blank to sell in {{ baseCurrency }} directly.</p>
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

        <fieldset>
          <legend>VAT</legend>
          <div class="three">
            <label>
              <span>VAT here</span>
              <select v-model="form.vatMode">
                <option value="auto">Automatic</option>
                <option value="charge">Charge VAT</option>
                <option value="exempt">Exempt (small business)</option>
              </select>
            </label>
            <template v-if="form.vatMode !== 'exempt'">
              <label>
                <span>Standard rate %</span>
                <input v-model="form.vatStandard" type="number" min="0" max="99" step="0.1" inputmode="decimal" :placeholder="countryRates ? String(countryRates.standard) : '-'" />
              </label>
              <label>
                <span>Reduced rate %</span>
                <input v-model="form.vatReduced" type="number" min="0" max="99" step="0.1" inputmode="decimal" list="zfy-reduced-rates" :placeholder="countryRates ? String(countryRates.reduced[0] ?? countryRates.standard) : '-'" />
                <datalist id="zfy-reduced-rates"><option v-for="r in countryRates?.reduced ?? []" :key="r" :value="r" /></datalist>
              </label>
            </template>
          </div>
          <p class="hint">{{ vatPreview }} Automatic is exempt in the countries ticked under Settings → VAT; blank rates use the country's.</p>
        </fieldset>

        <label v-if="!editId">
          <span>Copy stock claims from</span>
          <select v-model="form.copyStockFrom">
            <option value="">- don't copy -</option>
            <option v-for="e in visibleEvents" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
        </label>
        <div v-if="!editId && form.copyStockFrom" class="choice">
          <label class="radio"><input v-model="form.stockMode" type="radio" value="unsold" /> Claim what it didn't sell</label>
          <label class="radio"><input v-model="form.stockMode" type="radio" value="claims" /> Same claims as it had</label>
        </div>
        <p v-if="!editId && stockSourceRunning" class="warn">{{ stockSource!.name }} is still running - its claims keep reserving stock until it's closed, so the same items are held twice until then.</p>
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
header button { display: inline-flex; align-items: center; gap: .4rem; }
.header-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
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
.pill.selling, .pill.active, .pill.open { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.pill.planned { background: var(--zfy-signal-soft, #e4ecf6); color: var(--zfy-ink, #1a2230); }
.when { margin: 0; font-size: .8rem; color: var(--zfy-muted, #5a6472); font-variant-numeric: tabular-nums; }
.stats { margin: 0; font-size: .875rem; }
.layout-note { margin: 0; font-size: .8rem; color: var(--zfy-muted, #5a6472); display: flex; align-items: center; gap: .3rem; }
.actions { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .4rem; }
.actions button, .actions .btn { min-height: 2.2rem; padding: .2rem .7rem; font-size: .78rem; display: inline-flex; align-items: center; gap: .3rem; }
.btn { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; background: var(--zfy-surface, #fff); color: var(--zfy-ink, #1a2230); font-weight: 500; text-decoration: none; }
.btn:hover { background: var(--zfy-bg, #f1f4f6); }
.more { position: relative; margin-left: auto; }
.menu { position: absolute; right: 0; top: calc(100% + .25rem); z-index: 5; min-width: 11rem; display: flex; flex-direction: column; padding: .3rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; background: var(--zfy-surface, #fff); box-shadow: 0 12px 28px -12px var(--zfy-shadow, rgba(20,26,34,.4)); }
.menu button, .menu a { display: flex; align-items: center; gap: .5rem; width: 100%; min-height: 2.4rem; padding: .3rem .6rem; border: 0; border-radius: 6px; background: none; color: var(--zfy-ink, #1a2230); font-size: .85rem; text-align: left; text-decoration: none; cursor: pointer; }
.menu button:hover, .menu a:hover { background: var(--zfy-bg, #f1f4f6); }
.menu .danger { color: var(--zfy-danger, #c6512f); }
.form { display: flex; flex-direction: column; gap: .7rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label.check { flex-direction: row; align-items: center; gap: .5rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.three { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: .6rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .6rem; }
legend { font-size: .8rem; font-weight: 600; padding: 0 .3rem; }
.rate { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.rate button { min-height: 2.2rem; font-size: .8rem; display: inline-flex; align-items: center; gap: .3rem; }
.choice { display: flex; gap: 1rem; flex-wrap: wrap; }
.radio { flex-direction: row; align-items: center; gap: .4rem; }
.footer { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
