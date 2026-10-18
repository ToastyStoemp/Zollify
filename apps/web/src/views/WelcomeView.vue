<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { EMPTY_PROFILE_LINKS, EU_COUNTRIES as EU_COUNTRIES_FOR_SME, countryCodeOf, emptyProfile, fmtDayRange, guessFromDevice, type PoolListing, isStore, sellsAt, type ArtistDetails, type ProfileLinks, type SalesEvent, type SellsAt } from '@zollify/shared';
import { allProducts, authFetch, currentAccount, isNative, setActiveEvent, updateProfile, upsertSalesEvent, visibleEvents } from '@zollify/platform';
import { CountryPicker, DateRangePicker, QrCode } from '@zollify/ui';
import ArtistForm from '../components/ArtistForm.vue';
import StoreSetupWizard from '../components/StoreSetupWizard.vue';
import { contributions, loadEnabledModules, unloadModule } from '../boot';

/**
 * First-run setup. Short steps: what the business runs (events, stores or
 * both - it decides which pages it gets) and who it is, its next event or its
 * store, which modules to switch on, and where to go next. Every step can be skipped - skipping still
 * marks setup as done so the wizard never nags, and it can be re-run from
 * Settings → Business profile.
 */

interface AvailableModule {
  moduleId: string;
  version: string;
  title: string;
  description?: string;
  enabled: boolean;
}

/**
 * A sentence per module in the seller's words, plus whether a new booth
 * usually wants it. The module's own description says what it does; this says
 * who it is for.
 */
const GUIDE: Record<string, { forWhom: string; recommended: boolean }> = {
  pos: { forWhom: 'The till. You need this to sell anything at all.', recommended: true },
  customs: {
    forWhom: 'For selling across a border - Swiss EDEC, forms 1174/1187, proforma invoice and goods lists from your claimed stock. Uses your business details from the first step.',
    recommended: true,
  },
  'price-cards': { forWhom: 'Printable price tags straight from the catalogue. Handy at any table.', recommended: true },
  'public-events': {
    forWhom: 'A public "where to find us" page, a widget for your shop, a calendar feed and an Instagram bio - all from your events.',
    recommended: true,
  },
  tax: {
    forWhom: 'Month-end books: cluster card and online takings per convention, verify against myPOS, book revenue and fees into Lexware, and keep a per-event P&L.',
    recommended: false,
  },
  'multi-storage': { forWhom: 'Only if you keep stock in more than one place - a storage unit, the studio. Shows what is where and what to fetch for each event.', recommended: false },
  sourcing: { forWhom: 'Keep suppliers and draft reorders when stock runs low.', recommended: false },
  'shopify-sync': { forWhom: 'Only if you also run a Shopify store and want the catalogue matched against it.', recommended: false },
  migration: { forWhom: 'Only if you are moving from ZollTool. Import the backup once, then switch it off.', recommended: false },
  'peppol-be': {
    forWhom: 'Belgian B2B invoices as Peppol e-invoices. Takes your name, address, VAT and enterprise number from the first step; you only add the access point and payment details.',
    recommended: false,
  },
  'sme-scheme': {
    forWhom: 'For small businesses exempt from VAT: where you are exempt, the EX number for the EU SME scheme, and a quarterly report of sales per country.',
    recommended: false,
  },
  'tax-deadlines': {
    forWhom: 'Reminders before each filing and payment date, worked out from your VAT answers here - Germany in full, the EU SME scheme report anywhere in the EU, and your own dates.',
    recommended: false,
  },
  economic: { forWhom: 'Danish books: each day of sales goes into your e-conomic journal with its VAT codes, renters’ shares kept apart, for your accountant to post.', recommended: false },
  consignment: { forWhom: 'For stores selling artists’ work on consignment: commissions, payouts, shelf rentals and setups.', recommended: false },
  commissions: { forWhom: 'For artists taking custom work: save the customer, take a deposit at the till, and give them a QR code to follow progress.', recommended: false },
};

const router = useRouter();
const account = currentAccount;
const canRename = computed(() => account.value?.role === 'owner');

// Stages: 1 who you are, 2 the event or store, 3 modules, then one per step the
// switched-on modules add (card payments from the till), then Next steps. Module
// steps come after the module choice, so a module switched on there asks its own.
const MODULES_STAGE = 3;
/**
 * Where setup was left. A reload, a lost session or coming back later used to
 * start over at step 1 with the answers blank, although the event and the
 * profile were already saved - people created their event twice. Kept per
 * account in this browser only; finishing or skipping clears it.
 */
const stepKey = `zollify.welcome.step.${account.value?.accountId ?? ''}`;
const readStep = (): number => {
  try {
    const n = Number(sessionStorage.getItem(stepKey));
    return Number.isInteger(n) && n > 1 ? n : 1;
  } catch {
    return 1;
  }
};
const step = ref(readStep());
watch(step, (n) => {
  try {
    if (n > 1) sessionStorage.setItem(stepKey, String(n));
    else sessionStorage.removeItem(stepKey);
  } catch {
    /* this visit only */
  }
});
const forgetStep = (): void => {
  try {
    sessionStorage.removeItem(stepKey);
  } catch {
    /* nothing kept */
  }
};
const moduleSteps = computed(() => contributions.setupStepsFor(account.value?.role ?? 'member'));
// The first tax question, kept to one tap. Yes switches on the SME module, which asks where
// it applies in its own step; No puts "Add your VAT numbers" on the last page.
type Scheme = '' | 'sme' | 'vat';
const SCHEMES: { id: Scheme; title: string; text: string }[] = [
  { id: 'sme', title: 'Yes', text: 'I am exempt from VAT below a turnover threshold.' },
  { id: 'vat', title: 'No, I charge VAT', text: 'My receipts show VAT and my VAT number.' },
  { id: '', title: 'Not sure yet', text: 'Decide later under Settings → VAT.' },
];
const storedVat = account.value?.profile.vat;
const scheme = ref<Scheme>(storedVat?.scheme || (storedVat?.exemptCountries?.length ? 'sme' : ''));
/**
 * The steps after Modules: core's own first (the small-business exemption, when
 * the business said it is on a scheme - where, and the EX number), then one per
 * step the switched-on modules add (card payments from the till).
 */
const extraSteps = computed(() => [
  ...(scheme.value === 'sme' ? [{ id: 'core.exemption', title: 'Small-business exemption', component: () => import('../components/SmeExemptionSetupStep.vue') }] : []),
  ...moduleSteps.value,
]);
const extraStepViews = computed(() => extraSteps.value.map((s) => defineAsyncComponent(s.component)));
const nextStage = computed(() => MODULES_STAGE + 1 + extraSteps.value.length);
const moduleStep = computed(() => (step.value > MODULES_STAGE && step.value < nextStage.value ? step.value - MODULES_STAGE - 1 : -1));
const busy = ref(false);
const error = ref<string | null>(null);

// ── Step 1: what you run, and who ────────────────────────────────────────────
type Runs = 'events' | 'stores' | 'both';
const RUNS: { id: Runs; title: string; text: string }[] = [
  { id: 'events', title: 'Events', text: 'Fairs, markets, conventions - a pop-up for a few days at a time.' },
  { id: 'stores', title: 'Stores', text: 'A shop, or several, open until you close them.' },
  { id: 'both', title: 'Both', text: 'Events and stores.' },
];
const toRuns = (s: SellsAt): Runs => (s.events && s.stores ? 'both' : s.stores ? 'stores' : 'events');
const runs = ref<Runs>(toRuns(sellsAt(account.value?.profile, visibleEvents.value.some((e) => isStore(e)))));
const runsEvents = computed(() => runs.value !== 'stores');
const runsStores = computed(() => runs.value !== 'events');
// Off until the owner says yes: sharing is opt-in, and the answer has to stick - it used to
// reset to "yes" on every revisit and quietly publish the event. Starts from what the server
// has, so re-running setup shows the real state. Applied with the modules (the pool lives in Public events).
const shareEvents = ref(false);
onMounted(async () => {
  try {
    const cur = (await authFetch('/m/public-events/pool/settings')) as { share?: boolean };
    if (typeof cur.share === 'boolean') shareEvents.value = cur.share;
  } catch {
    /* module off or not published here: stays off */
  }
});
/** Re-running setup and now charging VAT: the exemption set earlier ends, or sales would keep printing it. */
const endsExemption = computed(() => scheme.value === 'vat' && (storedVat?.exemptCountries?.length ?? 0) > 0);
const name = ref(account.value?.accountName ?? '');
const startArtist = account.value?.profile.artist ?? emptyProfile().artist;
// The contact email starts as the one they signed in with - nearly always the
// right one, and still theirs to change. One already saved is kept.
const artist = ref<ArtistDetails>({ ...startArtist, email: startArtist.email || account.value?.email || '' });
const currency = ref(account.value?.profile.defaultCurrency ?? 'CHF');
const links = ref<ProfileLinks>({ ...EMPTY_PROFILE_LINKS, ...account.value?.profile.links });
// A new business starts from where its device is (time zone, then language) - never over a country already saved.
const guessed = !artist.value.countryOfOrigin ? guessFromDevice() : null;
if (guessed) {
  artist.value.countryOfOrigin = guessed.name;
  if (guessed.currency) currency.value = guessed.currency;
}

async function saveWho(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await updateProfile({
      sells: { events: runsEvents.value, stores: runsStores.value },
      artist: artist.value,
      vat: { scheme: scheme.value, ...(endsExemption.value ? { exemptCountries: [] } : {}) },
      links: { ...links.value },
      ...(/^[A-Za-z]{3}$/.test(currency.value.trim()) ? { defaultCurrency: currency.value.trim().toUpperCase() } : {}),
      ...(canRename.value && name.value.trim() ? { name: name.value.trim() } : {}),
    });
    // Consignment follows the store's own answer ("whose work do you sell?") in its wizard,
    // not the Stores choice: a shop selling only its own stock got it ticked and with it the
    // Rent and Workshop till tiles. Customs paperwork is for taking stock to fairs across a
    // border, so a stores-only business starts without it.
    const next = new Set(wanted.value);
    if (!runsEvents.value) for (const id of ['customs-hub', 'customs-ch', 'customs-de']) next.delete(id);
    if (runsEvents.value && shareEvents.value && modules.value.some((m) => m.moduleId === 'public-events')) next.add('public-events');
    if (scheme.value === 'sme' && modules.value.some((m) => m.moduleId === 'sme-scheme')) next.add('sme-scheme');
    wanted.value = next;
    step.value = 2;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save those details.';
  } finally {
    busy.value = false;
  }
}

// ── Step 2: the next event ───────────────────────────────────────────────────
// Everything happens inside an event: stock, sales and paperwork. Leave the
// name empty to skip; events that already synced in make this step moot.
// The country decides the event's VAT and whether stock crosses a customs border, so it is asked, not assumed.
const eventForm = ref({ name: '', dateStart: '', dateEnd: '', city: '', country: '' });
// The country just given on step 1 is the likeliest; it used to show only as a placeholder, so people typed it twice.
watch(step, (n) => {
  if (n === 2 && !eventForm.value.country && artist.value.countryOfOrigin) eventForm.value.country = artist.value.countryOfOrigin;
});
// A store is set up by its own questions (VAT, artists, reports), in a window of their own.
const settingUp = ref(false);
const storeMade = ref(false);
/** The wizard may have switched Consignment on; the module list and the wish list must agree before they are applied. */
async function storeSetupClosed(): Promise<void> {
  settingUp.value = false;
  try {
    const res = (await authFetch('/modules/available')) as { modules: AvailableModule[] };
    const on = res.modules.find((m) => m.moduleId === 'consignment')?.enabled ?? false;
    const mod = modules.value.find((m) => m.moduleId === 'consignment');
    if (mod) mod.enabled = on;
    if (on) wanted.value = new Set([...wanted.value, 'consignment']);
  } catch {
    /* the modules step falls back to what it loaded */
  }
}
const step2Label = computed(() => (runs.value === 'both' ? 'Event & store' : runs.value === 'stores' ? 'Your store' : 'Next event'));
async function saveEvent(): Promise<void> {
  const name = runsEvents.value ? eventForm.value.name.trim() : '';
  if (!name) {
    step.value = 3;
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    // A convention weeks away is upcoming, not selling now: the first event used to open
    // the till at once, so a Dane's shop sales were filed against a Stockholm con in November.
    const today = new Date().toISOString().slice(0, 10);
    const onNow = !eventForm.value.dateStart || eventForm.value.dateStart <= today;
    const base = { venue: { country: eventForm.value.country || artist.value.countryOfOrigin || undefined, city: eventForm.value.city.trim() || undefined }, currency: currency.value.trim().toUpperCase() || 'CHF', status: (onNow ? 'active' : 'planned') as SalesEvent['status'], updatedAt: Date.now() };
    const event: SalesEvent = { ...base, id: crypto.randomUUID(), name, dateStart: eventForm.value.dateStart || undefined, dateEnd: eventForm.value.dateEnd || undefined };
    await upsertSalesEvent(event);
    if (onNow && !visibleEvents.value.some((e) => isStore(e) && !e.deletedAt)) await setActiveEvent(event.id);
    step.value = 3;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not create that event.';
  } finally {
    busy.value = false;
  }
}

// ── Step 2: modules ──────────────────────────────────────────────────────────
const modules = ref<AvailableModule[]>([]);
const wanted = ref<Set<string>>(new Set());

onMounted(async () => {
  try {
    const res = (await authFetch('/modules/available')) as { modules: AvailableModule[] };
    // Recommended first, the till at the very top: the order a new booth
    // should read them in, not the alphabet.
    modules.value = [...res.modules].sort(
      (a, b) =>
        Number(b.moduleId === 'pos') - Number(a.moduleId === 'pos') ||
        Number(guideFor(b).recommended) - Number(guideFor(a).recommended) ||
        a.title.localeCompare(b.title),
    );
    // Start from what is already on. A business setting up for the first time also
    // gets every recommended module ticked - "Recommended" with the box empty left
    // people without a till. Re-running setup keeps what the owner chose since.
    const fresh = !account.value?.profile.setupCompletedAt;
    wanted.value = new Set(res.modules.filter((m) => m.enabled || (fresh && guideFor(m).recommended && m.moduleId !== 'consignment')).map((m) => m.moduleId));
    if (fresh && CUSTOMS.some((c) => wanted.value.has(c.id))) wanted.value.add('customs-hub');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the module list.';
  }
});

function guideFor(mod: AvailableModule) {
  const g = GUIDE[mod.moduleId] ?? { forWhom: mod.description ?? '', recommended: false };
  if (mod.moduleId === 'consignment') return { ...g, recommended: runsStores.value };
  if (mod.moduleId === 'sme-scheme') return { ...g, recommended: scheme.value === 'sme' };
  // On the scheme there is a quarterly report to file; in Germany, a full calendar of returns.
  if (mod.moduleId === 'tax-deadlines') return { ...g, recommended: scheme.value === 'sme' || countryCodeOf(artist.value.countryOfOrigin) === 'DE' };
  return g;
}

// ── The shared pool: pick the next convention instead of typing it ──────────
// Other sellers' events (name, dates, place, link - never who goes). Adding one
// copies it into this account's events, as Find events does.
const poolOn = computed(() => modules.value.some((m) => m.moduleId === 'public-events' && m.enabled));
const poolQuery = ref('');
const poolResults = ref<PoolListing[]>([]);
const poolAdded = ref<string[]>([]);
const poolBusy = ref<string | null>(null);
let poolTimer: ReturnType<typeof setTimeout> | undefined;
async function searchPool(): Promise<void> {
  try {
    const q = new URLSearchParams({ q: poolQuery.value.trim(), limit: '6' });
    poolResults.value = ((await authFetch(`/m/public-events/pool/listings?${q.toString()}`)) as { listings: PoolListing[] }).listings;
  } catch {
    poolResults.value = [];
  }
}
watch(poolQuery, () => {
  clearTimeout(poolTimer);
  poolTimer = setTimeout(() => void searchPool(), 250);
});
watch(
  () => step.value === 2 && poolOn.value,
  (on) => {
    if (on) void searchPool();
  },
);
async function addFromPool(l: PoolListing): Promise<void> {
  poolBusy.value = l.id;
  error.value = null;
  try {
    const event: SalesEvent = {
      id: crypto.randomUUID(),
      name: l.name,
      dateStart: l.dateStart,
      dateEnd: l.dateEnd,
      venue: { street: l.street, postcode: l.postcode, city: l.city, country: l.country },
      currency: currency.value.trim().toUpperCase() || 'EUR',
      status: 'planned',
      notes: [l.venueName, l.description].filter(Boolean).join('\n') || undefined,
      ...(l.url ? { booth: { link: l.url } } : {}),
      updatedAt: Date.now(),
    };
    await upsertSalesEvent(event);
    // Only so the pool stops offering it; the event is added either way.
    await authFetch(`/m/public-events/pool/listings/${encodeURIComponent(l.id)}/adopt`, { method: 'POST', body: JSON.stringify({ eventId: event.id }) }).catch(() => undefined);
    // Only an event already running becomes the till; a planned one waits for its dates.
    if (!poolAdded.value.length && l.dateStart <= new Date().toISOString().slice(0, 10)) await setActiveEvent(event.id);
    poolAdded.value = [...poolAdded.value, l.name];
    poolResults.value = poolResults.value.filter((x) => x.id !== l.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not add that event.';
  } finally {
    poolBusy.value = null;
  }
}

/**
 * The module list in the groups a seller thinks in. Customs is one choice
 * with a country under it: the hub is plumbing and follows whichever country
 * is on. Anything not named here lands under Other.
 */
const GROUPS: { title: string; ids: string[] }[] = [
  { title: 'Selling', ids: ['pos', 'price-cards', 'label-printer', 'commissions'] },
  { title: 'Events', ids: ['public-events', 'convention-checklist', 'customs'] },
  { title: 'Stores', ids: ['consignment', 'consignment-artist', 'multi-storage'] },
  { title: 'Books and stock', ids: ['sme-scheme', 'tax', 'tax-deadlines', 'economic', 'peppol-be', 'costs', 'sourcing', 'shopify-sync'] },
  { title: 'Moving in', ids: ['migration'] },
];
const CUSTOMS: { id: string; label: string }[] = [
  { id: 'customs-ch', label: 'Switzerland (EDEC, forms 1174/1187)' },
  { id: 'customs-de', label: 'Germany (ATLAS)' },
];
/** Names a seller would use; the module's own title otherwise. */
const TITLES: Record<string, string> = { pos: 'Till' };
const customsChoices = computed(() => CUSTOMS.filter((c) => modules.value.some((m) => m.moduleId === c.id)));
const customsWanted = computed(() => CUSTOMS.some((c) => wanted.value.has(c.id)));
/**
 * Modules that only make sense for one country's businesses. Anyone else
 * sees them folded under "Other countries" rather than beside the till: a
 * Belgian store was offered Danish bookkeeping and German Lexware books, and
 * ticked the wrong ones.
 */
const COUNTRY_ONLY: Record<string, string[]> = {
  'peppol-be': ['BE'],
  economic: ['DK'],
  tax: ['DE'],
  'tax-deadlines': ['DE', ...EU_COUNTRIES_FOR_SME],
};
const homeCode = computed(() => countryCodeOf(artist.value.countryOfOrigin));
/** Shown in its group, or folded away: the business is in a country the module serves, or has it on already. */
const fitsCountry = (id: string): boolean => {
  if (wanted.value.has(id)) return true;
  // The SME report is for businesses on the scheme; "I charge VAT" folds it away.
  if (id === 'sme-scheme' && scheme.value !== 'sme') return false;
  const only = COUNTRY_ONLY[id];
  return !only || !homeCode.value || only.includes(homeCode.value);
};
const showOther = ref(false);
const moduleGroups = computed(() => {
  const byId = new Map(modules.value.map((m) => [m.moduleId, m]));
  const placed = new Set(['customs', 'customs-hub', ...CUSTOMS.map((c) => c.id)]);
  const folded: { id: string; mod: AvailableModule }[] = [];
  const groups = GROUPS
    // The Events block is for events, the Stores block for stores: a stores-only shop
    // was shown Public events as RECOMMENDED and the whole convention toolkit.
    .filter((g) => (g.title !== 'Events' || runsEvents.value) && (g.title !== 'Stores' || runsStores.value))
    .map((g) => ({
      title: g.title,
      items: g.ids
        .filter((id) => (id === 'customs' ? customsChoices.value.length > 0 : byId.has(id)))
        .flatMap((id) => {
          placed.add(id);
          if (id === 'customs') return [{ id, mod: null as AvailableModule | null }];
          const mod = byId.get(id)!;
          if (!fitsCountry(id)) {
            folded.push({ id, mod });
            return [];
          }
          return [{ id, mod }];
        }),
    }));
  // Stores-only: the event modules still exist, under Other, for the day they are wanted.
  for (const id of GROUPS.flatMap((g) => g.ids)) if (!placed.has(id) && byId.has(id)) { placed.add(id); folded.push({ id, mod: byId.get(id)! }); }
  const other = [...modules.value.filter((m) => !placed.has(m.moduleId)).map((m) => ({ id: m.moduleId, mod: m as AvailableModule | null })), ...folded];
  return [...groups, { title: 'Other countries and setups', items: other, folded: true }].filter((g) => g.items.length);
});
function setCustoms(id: string, on: boolean): void {
  const next = new Set(wanted.value);
  if (on) next.add(id);
  else next.delete(id);
  if (CUSTOMS.some((c) => next.has(c.id))) next.add('customs-hub');
  else next.delete('customs-hub');
  wanted.value = next;
}
/** Customs on means every country this server offers, until one is unticked. */
function toggleCustoms(): void {
  const on = !customsWanted.value;
  for (const c of customsChoices.value) setCustoms(c.id, on);
}

function toggleWanted(id: string): void {
  const next = new Set(wanted.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  wanted.value = next;
}

/**
 * Applies only what changed. Server first, then the running shell, so a
 * refused toggle leaves the UI honest - the same order the Modules screen uses.
 */
async function saveModules(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const changed = modules.value.filter((m) => m.enabled !== wanted.value.has(m.moduleId));
    for (const mod of changed) {
      await authFetch('/modules/toggle', {
        method: 'POST',
        body: JSON.stringify({ moduleId: mod.moduleId, enabled: !mod.enabled }),
      });
      if (mod.enabled) await unloadModule(router, mod.moduleId);
      mod.enabled = !mod.enabled;
    }
    if (changed.some((m) => m.enabled)) await loadEnabledModules(router);
    if (runsEvents.value && shareEvents.value && wanted.value.has('public-events')) {
      try {
        await authFetch('/m/public-events/pool/settings', { method: 'PUT', body: JSON.stringify({ share: true }) });
      } catch {
        error.value = 'Could not turn on event sharing - you can turn it on under Settings.';
      }
    }
    step.value = MODULES_STAGE + 1;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not change those modules.';
  } finally {
    busy.value = false;
  }
}

// ── Step 3: next ─────────────────────────────────────────────────────────────
const sellingOn = computed(() => wanted.value.has('pos'));
// The last page lists only what is still to do: no "create your first event" to someone with thirteen.
const hasProducts = computed(() => allProducts.value.length > 0);
const hasEvents = computed(() => visibleEvents.value.some((e) => !isStore(e) && !e.deletedAt));
const hasStores = computed(() => visibleEvents.value.some((e) => isStore(e) && !e.deletedAt));
const paymentsAsked = computed(() => moduleSteps.value.some((m) => m.id === 'pos.payments'));
/** Charging VAT and no number per country yet: worth a line on the last page. */
const vatNumbersMissing = computed(() => scheme.value === 'vat' && !(account.value?.profile.vat?.vatNumbers ?? []).length);
/** Said yes to a scheme but left the exemption step without ticking a country: every sale still charges VAT. */
const smeNotSet = computed(() => scheme.value === 'sme' && !(account.value?.profile.vat?.exemptCountries ?? []).length);
/** The Android app this server hands out, for card readers and the till on a tablet. Null when none is published, or already in it. */
const androidApp = ref<{ url: string } | null>(null);
onMounted(async () => {
  if (isNative()) return;
  try {
    const res = await fetch('/api/updates/latest');
    if (!res.ok) return;
    androidApp.value = { url: `${location.origin}/api/updates/download/full` };
  } catch {
    /* no app published here */
  }
});

/**
 * Skipping from the first step still keeps what is on that screen - what you run,
 * country, currency, the VAT answer. Skip used to drop them, so a Dane who chose
 * "Both" landed on an Events-only account counting in CHF.
 */
async function skipFromStart(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await updateProfile({
      sells: { events: runsEvents.value, stores: runsStores.value },
      artist: artist.value,
      vat: { scheme: scheme.value },
      ...(/^[A-Za-z]{3}$/.test(currency.value.trim()) ? { defaultCurrency: currency.value.trim().toUpperCase() } : {}),
      ...(canRename.value && name.value.trim() ? { name: name.value.trim() } : {}),
    });
  } catch {
    /* the profile can be finished later under Settings; skipping must not fail */
  }
  await finish();
}

async function finish(to: { name: string; query?: Record<string, string> } = { name: 'home' }): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    forgetStep();
    await updateProfile({ setupCompleted: true });
    await router.replace(to);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not finish setup.';
    busy.value = false;
  }
}
</script>

<template>
  <section class="welcome">
    <p class="brand">Zollify<span>.</span></p>
    <ol class="steps" aria-label="Setup progress">
      <li :class="{ current: step === 1, done: step > 1 }">Who you are</li>
      <li :class="{ current: step === 2, done: step > 2 }">{{ step2Label }}</li>
      <li :class="{ current: step === MODULES_STAGE, done: step > MODULES_STAGE }">Modules</li>
      <li v-for="(m, i) in extraSteps" :key="m.id" :class="{ current: step === MODULES_STAGE + 1 + i, done: step > MODULES_STAGE + 1 + i }">{{ m.title }}</li>
      <li :class="{ current: step === nextStage }">Next steps</li>
    </ol>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!-- ── 1 ─────────────────────────────────────────────────────────────── -->
    <form v-if="step === 1" class="card" @submit.prevent="saveWho">
      <h1>Welcome to Zollify</h1>
      <p class="lede">
        One app for your business: the till, stock, {{ runsStores && !runsEvents ? "your store" : runsStores ? "events, stores" : "events" }} and paperwork. First, who is behind the
        table? Your name, country and currency are enough to start; the rest can wait until a receipt
        or a customs form needs it, under Settings → Business profile.
      </p>

      <fieldset class="runs">
        <legend>What do you run?</legend>
        <label v-for="r in RUNS" :key="r.id" :class="{ on: runs === r.id }">
          <input v-model="runs" type="radio" name="runs" :value="r.id" />
          <strong>{{ r.title }}</strong>
          <span>{{ r.text }}</span>
        </label>
      </fieldset>
      <p class="lede small">This decides whether you get the Events page, the Stores page, or both. Change it any time under Settings → Business profile.</p>
      <fieldset v-if="runsEvents" class="runs share">
        <legend>Help other artists find events?</legend>
        <p class="lede small">Share the name, dates, place and link of your events with the community. Others can add them to their own events in one tap. Nobody can see who goes to which event. You can turn this off any time in Settings.</p>
        <label :class="{ on: !shareEvents }">
          <input v-model="shareEvents" type="radio" name="shareEvents" :value="false" />
          <strong>No, keep my events to myself</strong>
        </label>
        <label :class="{ on: shareEvents }">
          <input v-model="shareEvents" type="radio" name="shareEvents" :value="true" />
          <strong>Yes, share my events</strong>
        </label>
      </fieldset>

      <fieldset class="runs">
        <legend>Are you on a small-business VAT scheme?</legend>
        <label v-for="o in SCHEMES" :key="o.id || 'unsure'" :class="{ on: scheme === o.id }">
          <input v-model="scheme" type="radio" name="scheme" :value="o.id" />
          <strong>{{ o.title }}</strong>
          <span>{{ o.text }}</span>
        </label>
      </fieldset>
      <p v-if="endsExemption" class="lede small warn">You are set as exempt in {{ storedVat!.exemptCountries.join(', ') }}. Continuing with "No" ends that - new sales there charge VAT.</p>

      <p v-if="guessed" class="lede small">Country and currency are a guess from this device's settings - change them if they are wrong.</p>
      <ArtistForm v-model="artist" v-model:links="links" v-model:name="name" v-model:currency="currency" :can-rename="canRename" compact :show-eori="runsEvents" />

      <footer class="actions">
        <button type="button" class="quiet" :disabled="busy" @click="skipFromStart">Skip setup</button>
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Saving…' : 'Continue' }}</button>
      </footer>
    </form>

    <!-- ── 2 ─────────────────────────────────────────────────────────────── -->
    <form v-else-if="step === 2" class="card" @submit.prevent="saveEvent">
      <h1>{{ runs === 'stores' ? 'Your store' : runs === 'both' ? 'Your next event and your store' : 'Your next event' }}</h1>
      <p class="lede">Every sale is filed against an event or a store, with its stock and paperwork. {{ runs === 'stores' ? 'Answer a few questions about your store' : runs === 'both' ? 'Name your next event and answer a few questions about your store' : 'Name your next convention' }} to get started, or skip.</p>
      <p v-if="visibleEvents.length" class="lede ok">{{ visibleEvents.length }} already synced in - you can skip this.</p>
      <div v-if="runsEvents && poolOn" class="pool">
        <label><span>Find your next convention</span><input v-model="poolQuery" type="search" placeholder="Search events other sellers share" /></label>
        <p v-if="poolAdded.length" class="lede ok">Added: {{ poolAdded.join(', ') }}</p>
        <ul v-if="poolResults.length" class="pool-list">
          <li v-for="l in poolResults" :key="l.id">
            <span class="pool-name"><strong>{{ l.name }}</strong><small>{{ fmtDayRange(l.dateStart, l.dateEnd) }}<template v-if="l.city || l.country"> · {{ [l.city, l.country].filter(Boolean).join(', ') }}</template></small></span>
            <button type="button" :disabled="poolBusy !== null" @click="addFromPool(l)">{{ poolBusy === l.id ? 'Adding…' : 'Add' }}</button>
          </li>
        </ul>
        <p v-else-if="poolQuery.trim()" class="lede small">No shared event by that name yet - add it below.</p>
        <p class="lede small">Not listed? Add it yourself:</p>
      </div>
      <div v-if="runsEvents" class="grid">
        <label><span>Event name</span><input v-model="eventForm.name" type="text" placeholder="Fantasy Basel 2026" /></label>
        <label><span>Dates</span><DateRangePicker v-model:start="eventForm.dateStart" v-model:end="eventForm.dateEnd" start-label="Starts" end-label="Ends" /></label>
        <label><span>City</span><input v-model="eventForm.city" type="text" placeholder="Basel" /></label>
        <label><span>Country</span><CountryPicker v-model="eventForm.country" store="name" :placeholder="artist.countryOfOrigin || 'Country'" /><small class="lede small">Sets the VAT and tells you if you need customs papers.</small></label>
      </div>
      <div v-if="runsStores" class="store-setup">
        <p v-if="storeMade" class="lede ok">Your store is set up.</p>
        <button v-else type="button" :disabled="busy" @click="settingUp = true">Set up your store</button>
      </div>
      <p class="lede small">Sells in {{ currency || 'your base currency' }}; add a local currency later.</p>
      <footer class="actions">
        <button type="button" class="quiet" :disabled="busy" @click="step = 1">Back</button>
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Saving…' : runsEvents && eventForm.name.trim() ? 'Create & continue' : storeMade || poolAdded.length ? 'Continue' : 'Skip' }}</button>
      </footer>
    </form>

    <!-- ── 3 ─────────────────────────────────────────────────────────────── -->
    <form v-else-if="moduleStep >= 0" class="card" @submit.prevent="step++">
      <h1>{{ extraSteps[moduleStep]!.title }}</h1>
      <component :is="extraStepViews[moduleStep]" />
      <footer class="actions">
        <button type="button" class="quiet" @click="step--">Back</button>
        <button type="submit" class="primary">Continue</button>
      </footer>
    </form>

    <form v-else-if="step === MODULES_STAGE" class="card" @submit.prevent="saveModules">
      <h1>Switch on what you need</h1>
      <p class="lede">
        Zollify is built from modules. Turn on the ones that fit your business - anything you leave off
        stays out of the way and can be switched on later under Modules.
      </p>

      <section v-for="g in moduleGroups" :key="g.title" class="mgroup">
        <h2 v-if="!('folded' in g)">{{ g.title }}</h2>
        <button v-else type="button" class="quiet fold" :aria-expanded="showOther" @click="showOther = !showOther">{{ showOther ? 'Hide' : 'Show' }} {{ g.items.length }} more - other countries, events or stores</button>
        <ul v-if="!('folded' in g) || showOther" class="modules">
          <li v-for="item in g.items" :key="item.id">
            <template v-if="item.mod">
              <label>
                <input
                  type="checkbox"
                  :checked="wanted.has(item.id)"
                  :aria-describedby="`why-${item.id}`"
                  @change="toggleWanted(item.id)"
                />
                <span class="body">
                  <span class="title">
                    {{ TITLES[item.id] ?? item.mod.title }}
                    <span v-if="guideFor(item.mod).recommended" class="badge">Recommended</span>
                  </span>
                  <span :id="`why-${item.id}`" class="why">{{ guideFor(item.mod).forWhom }}</span>
                </span>
              </label>
            </template>
            <div v-else class="customs">
              <label>
                <input type="checkbox" :checked="customsWanted" aria-describedby="why-customs" @change="toggleCustoms" />
                <span class="body">
                  <span class="title">Customs paperwork <span v-if="runsEvents" class="badge">Recommended</span></span>
                  <span id="why-customs" class="why">For taking stock to fairs across a border: export and re-import papers, proforma invoices and goods lists from your claimed stock.</span>
                </span>
              </label>
              <div v-if="customsWanted" class="countries">
                <label v-for="c in customsChoices" :key="c.id" class="country">
                  <input type="checkbox" :checked="wanted.has(c.id)" @change="setCustoms(c.id, ($event.target as HTMLInputElement).checked)" />
                  <span>{{ c.label }}</span>
                </label>
              </div>
            </div>
          </li>
        </ul>
      </section>
      <p v-if="!modules.length" class="empty">No modules are published on this server yet.</p>

      <footer class="actions">
        <button type="button" class="quiet" :disabled="busy" @click="step = 2">Back</button>
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Applying…' : 'Continue' }}</button>
      </footer>
    </form>

    <!-- ── 3 ─────────────────────────────────────────────────────────────── -->
    <div v-else class="card">
      <h1>You're set up</h1>
      <p class="lede">
        Here is the order most sellers do things in. Each one takes a minute, and none of them has
        to happen today.
      </p>

      <ol class="next">
        <li v-if="!hasProducts">
          <strong>Add your products</strong>
          <span>Titles, prices, sizes - and a photo if you like. Everything else reads from this.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'catalog' })">Open Catalog</button>
        </li>
        <li>
          <strong>Count what you own</strong>
          <span>One inventory for the whole business. Events can claim a share of it.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'stock' })">Open Inventory</button>
        </li>
        <li v-if="runsEvents && !hasEvents">
          <strong>Create your first event</strong>
          <span>Every sale is filed against the active event, so make one before you sell.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'events' })">Open Events</button>
        </li>
        <li v-if="runsStores && !hasStores">
          <strong>Add your stores</strong>
          <span>Each shop sells through the till with its own stock on the shelves.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'stores' })">Open Stores</button>
        </li>
        <li v-if="vatNumbersMissing">
          <strong>Add your VAT numbers</strong>
          <span>One for each country you are registered in. Receipts there print it; elsewhere they print the number from your business details.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'settings', query: { panel: 'core.vat' } })">Open VAT</button>
        </li>
        <li v-if="smeNotSet">
          <strong>Set where you are exempt</strong>
          <span>Until you do, every sale charges VAT. Your EX number goes in the same place.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'settings', query: { panel: 'core.vat' } })">Open VAT</button>
        </li>
        <li v-if="sellingOn && !paymentsAsked">
          <strong>Pick how you take payment</strong>
          <span>Cash and an external card terminal work out of the box; wired terminals live under Settings → Card terminal.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'settings', query: { panel: 'pos.payments' } })">Open Payments</button>
        </li>
        <li v-if="androidApp && sellingOn" class="app">
          <strong>Get the Android app</strong>
          <span>For card readers and the till on a phone or tablet. Scan this with the device, or open the link on it.</span>
          <a :href="androidApp.url" class="btn" download>Download</a>
          <QrCode :value="androidApp.url" :size="120" label="Android app download QR code" class="qr" />
        </li>
        <li>
          <strong>Invite helpers</strong>
          <span>{{ runsStores ? "Give staff the till without handing over the whole account - they ring up sales, you see the totals." : "Give someone the till for one event without handing over the whole account." }}</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'settings', query: { panel: 'core.team' } })">Open Team</button>
        </li>
      </ol>

      <footer class="actions">
        <button type="button" class="quiet" :disabled="busy" @click="step = nextStage - 1">Back</button>
        <button type="button" class="primary" :disabled="busy" @click="finish()">{{ busy ? 'Finishing…' : 'Go to Home' }}</button>
      </footer>
    </div>
    <StoreSetupWizard v-if="settingUp" onboarding @created="storeMade = true" @close="storeSetupClosed" />
  </section>
</template>

<style scoped>
.welcome { max-width: 44rem; margin: 0 auto; display: flex; flex-direction: column; gap: 1rem; align-self: start; }
.brand { font-weight: 800; font-size: 1.25rem; letter-spacing: -.02em; margin: 0; }
.brand span { color: var(--zfy-accent); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: .75rem; }
.grid label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.runs { border: 0; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .5rem; }
.runs.share p { grid-column: 1 / -1; margin: 0; }
.runs legend { font-weight: 600; margin-bottom: .4rem; font-size: .95rem; }
.runs label { display: flex; flex-direction: column; gap: .2rem; padding: .7rem .8rem; border: 1px solid var(--zfy-line); border-radius: 10px; cursor: pointer; font-size: .85rem; }
.runs label.on { border-color: var(--zfy-accent); background: var(--zfy-accent-soft); }
.runs input { position: absolute; opacity: 0; pointer-events: none; }
.runs label:focus-within { outline: 2px solid var(--zfy-accent); outline-offset: 2px; }
.runs span { color: var(--zfy-muted); }
.lede.small { font-size: .8rem; }
.store-setup { display: flex; }
.pool { display: flex; flex-direction: column; gap: .6rem; }
.pool label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.pool-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.pool-list li { display: flex; align-items: center; gap: .75rem; padding: .55rem .75rem; border: 1px solid var(--zfy-line); border-radius: 10px; }
.pool-name { flex: 1; display: flex; flex-direction: column; gap: .1rem; min-width: 0; }
.pool-name small { color: var(--zfy-muted); font-size: .8rem; }
.lede.ok { color: var(--zfy-accent-ink); }
.lede.warn { color: var(--zfy-warning-ink); }
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .5rem; counter-reset: step; }
.steps li { display: flex; align-items: center; gap: .4rem; font-size: .8rem; color: var(--zfy-faint); }
.steps li::before { counter-increment: step; content: counter(step); display: grid; place-items: center; width: 1.5rem; height: 1.5rem; border-radius: 999px; border: 1px solid var(--zfy-line); font-variant-numeric: tabular-nums; }
.steps li.current { color: var(--zfy-ink); font-weight: 600; }
.steps li.current::before { background: var(--zfy-accent); border-color: var(--zfy-accent); color: var(--zfy-on-accent); }
.steps li.done { color: var(--zfy-muted); }
.steps li.done::before { content: '✓'; background: var(--zfy-accent-soft); border-color: var(--zfy-accent-soft); color: var(--zfy-accent-ink); }
.steps li + li::after { content: none; }
.card { background: var(--zfy-surface); border: 1px solid var(--zfy-line); border-radius: 14px; padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem; }
h1 { margin: 0; font-size: 1.5rem; letter-spacing: -.01em; text-wrap: balance; }
.lede { margin: 0; color: var(--zfy-muted); max-width: 60ch; }
.error { color: var(--zfy-danger); margin: 0; }
.empty { color: var(--zfy-muted); margin: 0; }
.actions { display: flex; justify-content: space-between; gap: .5rem; padding-top: .5rem; border-top: 1px solid var(--zfy-line); }
.mgroup { display: flex; flex-direction: column; gap: .5rem; }
.mgroup h2 { margin: .4rem 0 0; font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; color: var(--zfy-muted); }
.fold { align-self: flex-start; font-size: .85rem; color: var(--zfy-muted); padding: .3rem 0; }
.customs { border: 1px solid var(--zfy-line); border-radius: 10px; }
.customs > label { border: 0 !important; }
.countries { display: flex; flex-direction: column; gap: .35rem; padding: 0 .9rem .75rem 2.6rem; }
.country { display: flex !important; gap: .5rem; align-items: center; padding: 0 !important; border: 0 !important; font-size: .875rem; }
.modules { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.modules label { display: flex; gap: .75rem; align-items: flex-start; padding: .75rem .9rem; border: 1px solid var(--zfy-line); border-radius: 10px; cursor: pointer; }
.modules label:hover { background: var(--zfy-surface-2); }
.modules input { margin-top: .2rem; flex: none; }
.body { display: flex; flex-direction: column; gap: .15rem; }
.title { font-weight: 600; display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.why { font-size: .875rem; color: var(--zfy-muted); }
.badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; color: var(--zfy-accent-ink); background: var(--zfy-accent-soft); border-radius: 999px; padding: .1rem .5rem; }
.next { margin: 0; padding: 0 0 0 1.4rem; display: flex; flex-direction: column; gap: .85rem; }
.next li { display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto; gap: .1rem .75rem; align-items: center; }
.next strong { grid-column: 1; }
.next span { grid-column: 1; font-size: .875rem; color: var(--zfy-muted); }
.next button, .next .btn { grid-column: 2; grid-row: 1 / span 2; white-space: nowrap; }
.next .qr { grid-column: 1; justify-self: start; margin-top: .3rem; }
@media (max-width: 560px) {
  .next li { grid-template-columns: 1fr; }
  .next button { grid-column: 1; grid-row: auto; justify-self: start; margin-top: .3rem; }
}
</style>
