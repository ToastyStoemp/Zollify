<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { EMPTY_PROFILE_LINKS, emptyProfile, isStore, sellsAt, type ArtistDetails, type ProfileLinks, type SalesEvent, type SellsAt } from '@zollify/shared';
import { authFetch, currentAccount, setActiveEvent, updateProfile, upsertSalesEvent, visibleEvents } from '@zollify/platform';
import { DateRangePicker } from '@zollify/ui';
import ArtistForm from '../components/ArtistForm.vue';
import { loadEnabledModules, unloadModule } from '../boot';

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
  sourcing: { forWhom: 'Keep suppliers and draft reorders when stock runs low.', recommended: false },
  'shopify-sync': { forWhom: 'Only if you also run a Shopify store and want the catalogue matched against it.', recommended: false },
  migration: { forWhom: 'Only if you are moving from ZollTool. Import the backup once, then switch it off.', recommended: false },
  'peppol-be': {
    forWhom: 'Belgian B2B invoices as Peppol e-invoices. Takes your name, address, VAT and enterprise number from the first step; you only add the access point and payment details.',
    recommended: false,
  },
  consignment: { forWhom: 'For stores selling artists’ work on consignment: commissions, payouts, shelf rentals and setups.', recommended: false },
  commissions: { forWhom: 'For artists taking custom work: save the customer, take a deposit at the till, and give them a QR code to follow progress.', recommended: false },
};

const router = useRouter();
const account = currentAccount;
const canRename = computed(() => account.value?.role === 'owner');

const step = ref<1 | 2 | 3 | 4>(1);
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
// Off unless chosen: nothing is shared until the owner agrees. Applied with the modules, since the pool lives in Public events.
const shareEvents = ref(false);
const name = ref(account.value?.accountName ?? '');
const artist = ref<ArtistDetails>({ ...(account.value?.profile.artist ?? emptyProfile().artist) });
const currency = ref(account.value?.profile.defaultCurrency ?? 'CHF');
const links = ref<ProfileLinks>({ ...EMPTY_PROFILE_LINKS, ...account.value?.profile.links });

async function saveWho(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await updateProfile({
      sells: { events: runsEvents.value, stores: runsStores.value },
      artist: artist.value,
      links: { ...links.value },
      ...(/^[A-Za-z]{3}$/.test(currency.value.trim()) ? { defaultCurrency: currency.value.trim().toUpperCase() } : {}),
      ...(canRename.value && name.value.trim() ? { name: name.value.trim() } : {}),
    });
    // A store selling artists' work wants Consignment; suggest it. Customs paperwork is for
    // taking stock to fairs across a border, so a stores-only business starts without it.
    const next = new Set(wanted.value);
    if (runsStores.value && modules.value.some((m) => m.moduleId === 'consignment')) next.add('consignment');
    if (!runsEvents.value) for (const id of ['customs-hub', 'customs-ch', 'customs-de']) next.delete(id);
    if (runsEvents.value && shareEvents.value && modules.value.some((m) => m.moduleId === 'public-events')) next.add('public-events');
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
const eventForm = ref({ name: '', dateStart: '', dateEnd: '', storeName: '', storeCity: '' });
const step2Label = computed(() => (runs.value === 'both' ? 'Event & store' : runs.value === 'stores' ? 'Your store' : 'Next event'));
async function saveEvent(): Promise<void> {
  const name = runsEvents.value ? eventForm.value.name.trim() : '';
  const storeName = runsStores.value ? eventForm.value.storeName.trim() : '';
  if (!name && !storeName) {
    step.value = 3;
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    const base = { venue: { country: artist.value.countryOfOrigin || undefined }, currency: currency.value.trim().toUpperCase() || 'CHF', status: 'active' as const, updatedAt: Date.now() };
    let first: string | null = null;
    if (storeName) {
      const store: SalesEvent = { ...base, id: crypto.randomUUID(), name: storeName, kind: 'store', venue: { ...base.venue, city: eventForm.value.storeCity.trim() || undefined } };
      await upsertSalesEvent(store);
      first = store.id;
    }
    if (name) {
      const event: SalesEvent = { ...base, id: crypto.randomUUID(), name, dateStart: eventForm.value.dateStart || undefined, dateEnd: eventForm.value.dateEnd || undefined };
      await upsertSalesEvent(event);
      first ??= event.id;
    }
    if (first) await setActiveEvent(first);
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
    // Start from what is already on; a brand-new account has the seeded
    // defaults, which match the recommendations.
    wanted.value = new Set(res.modules.filter((m) => m.enabled).map((m) => m.moduleId));
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the module list.';
  }
});

function guideFor(mod: AvailableModule) {
  const g = GUIDE[mod.moduleId] ?? { forWhom: mod.description ?? '', recommended: false };
  return mod.moduleId === 'consignment' ? { ...g, recommended: runsStores.value } : g;
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
    step.value = 4;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not change those modules.';
  } finally {
    busy.value = false;
  }
}

// ── Step 3: next ─────────────────────────────────────────────────────────────
const sellingOn = computed(() => wanted.value.has('pos'));

async function finish(to: { name: string; query?: Record<string, string> } = { name: 'home' }): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
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
      <li :class="{ current: step === 3, done: step > 3 }">Modules</li>
      <li :class="{ current: step === 4 }">Next steps</li>
    </ol>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!-- ── 1 ─────────────────────────────────────────────────────────────── -->
    <form v-if="step === 1" class="card" @submit.prevent="saveWho">
      <h1>Welcome to Zollify</h1>
      <p class="lede">
        One app for your business: the till, stock, events and paperwork. First, who is behind the
        table? You enter this once: receipts, customs documents and e-invoices all read it from here,
        so no module asks again. Everything past your name is optional, and you can change it any
        time under Settings → Business profile.
      </p>

      <fieldset class="runs">
        <legend>What do you run?</legend>
        <label v-for="r in RUNS" :key="r.id" :class="{ on: runs === r.id }">
          <input v-model="runs" type="radio" name="runs" :value="r.id" />
          <strong>{{ r.title }}</strong>
          <span>{{ r.text }}</span>
        </label>
      </fieldset>
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
      <p class="lede small">This decides whether you get the Events page, the Stores page, or both. Change it any time under Settings → Business profile.</p>

      <ArtistForm v-model="artist" v-model:links="links" v-model:name="name" v-model:currency="currency" :can-rename="canRename" />

      <footer class="actions">
        <button type="button" class="quiet" :disabled="busy" @click="finish()">Skip setup</button>
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Saving…' : 'Continue' }}</button>
      </footer>
    </form>

    <!-- ── 2 ─────────────────────────────────────────────────────────────── -->
    <form v-else-if="step === 2" class="card" @submit.prevent="saveEvent">
      <h1>{{ runs === 'stores' ? 'Your store' : runs === 'both' ? 'Your next event and your store' : 'Your next event' }}</h1>
      <p class="lede">Every sale is filed against an event or a store, with its stock and paperwork. Name {{ runs === 'stores' ? 'your store' : runs === 'both' ? 'them' : 'your next convention' }} to get started, or leave it empty to skip.</p>
      <p v-if="visibleEvents.length" class="lede ok">{{ visibleEvents.length }} already synced in - you can skip this.</p>
      <div v-if="runsEvents" class="grid">
        <label><span>Event name</span><input v-model="eventForm.name" type="text" placeholder="Fantasy Basel 2026" /></label>
        <label><span>Dates</span><DateRangePicker v-model:start="eventForm.dateStart" v-model:end="eventForm.dateEnd" start-label="Starts" end-label="Ends" /></label>
      </div>
      <div v-if="runsStores" class="grid">
        <label><span>Store name</span><input v-model="eventForm.storeName" type="text" placeholder="Atelier Zurich" /></label>
        <label><span>City</span><input v-model="eventForm.storeCity" type="text" placeholder="Zurich" /></label>
      </div>
      <p class="lede small">Sells in {{ currency || 'your base currency' }}; add a local currency later.</p>
      <footer class="actions">
        <button type="button" class="quiet" :disabled="busy" @click="step = 1">Back</button>
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Saving…' : (runsEvents && eventForm.name.trim()) || (runsStores && eventForm.storeName.trim()) ? 'Create & continue' : 'Skip' }}</button>
      </footer>
    </form>

    <!-- ── 3 ─────────────────────────────────────────────────────────────── -->
    <form v-else-if="step === 3" class="card" @submit.prevent="saveModules">
      <h1>Switch on what you need</h1>
      <p class="lede">
        Zollify is built from modules. Turn on the ones that fit your business - anything you leave off
        stays out of the way and can be switched on later under Modules.
      </p>

      <ul class="modules">
        <li v-for="mod in modules" :key="mod.moduleId">
          <label>
            <input
              type="checkbox"
              :checked="wanted.has(mod.moduleId)"
              :aria-describedby="`why-${mod.moduleId}`"
              @change="toggleWanted(mod.moduleId)"
            />
            <span class="body">
              <span class="title">
                {{ mod.title }}
                <span v-if="guideFor(mod).recommended" class="badge">Recommended</span>
              </span>
              <span :id="`why-${mod.moduleId}`" class="why">{{ guideFor(mod).forWhom }}</span>
            </span>
          </label>
        </li>
      </ul>
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
        <li>
          <strong>Add your products</strong>
          <span>Titles, prices, sizes - and a photo if you like. Everything else reads from this.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'catalog' })">Open Catalog</button>
        </li>
        <li>
          <strong>Count what you own</strong>
          <span>One inventory for the whole business. Events can claim a share of it.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'stock' })">Open Inventory</button>
        </li>
        <li v-if="runsEvents">
          <strong>Create your first event</strong>
          <span>Every sale is filed against the active event, so make one before you sell.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'events' })">Open Events</button>
        </li>
        <li v-if="runsStores">
          <strong>Add your stores</strong>
          <span>Each shop sells through the till with its own stock on the shelves.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'stores' })">Open Stores</button>
        </li>
        <li v-if="sellingOn">
          <strong>Pick how you take payment</strong>
          <span>Cash and an external card terminal work out of the box; wired terminals live under Settings → Payments.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'settings', query: { panel: 'pos.payments' } })">Open Payments</button>
        </li>
        <li>
          <strong>Invite helpers</strong>
          <span>Give someone the till for one event without handing over the whole account.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'settings', query: { panel: 'core.team' } })">Open Team</button>
        </li>
      </ol>

      <footer class="actions">
        <button type="button" class="quiet" :disabled="busy" @click="step = 3">Back</button>
        <button type="button" class="primary" :disabled="busy" @click="finish()">{{ busy ? 'Finishing…' : 'Go to Home' }}</button>
      </footer>
    </div>
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
.lede.ok { color: var(--zfy-accent-ink); }
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
.next button { grid-column: 2; grid-row: 1 / span 2; white-space: nowrap; }
@media (max-width: 560px) {
  .next li { grid-template-columns: 1fr; }
  .next button { grid-column: 1; grid-row: auto; justify-self: start; margin-top: .3rem; }
}
</style>
