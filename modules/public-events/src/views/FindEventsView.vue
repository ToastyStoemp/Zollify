<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { EventOverlaySchema, type PoolListing, type SalesEvent } from '@zollify/shared';
import { api } from '../api';
import { sdk } from '../runtime';

/**
 * Find events: search the pool other booths share to, quick-add one into this
 * account, and share your own events back. Everything shown comes from the
 * server as plain text; the template only interpolates it, so Vue escapes it.
 */

const filters = reactive({ q: '', city: '', country: '', from: '', to: '', past: false });
const listings = ref<PoolListing[]>([]);
const more = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busyId = ref<string | null>(null);
const reporting = ref<string | null>(null);
const reportReason = ref('wrong');
const reportNote = ref('');

const shared = ref<Record<string, PoolListing>>({});
const sharedName = ref<Record<string, string>>({});
const sharing = ref<string | null>(null);
const form = reactive({ edition: '', venueName: '', url: '', description: '', displayName: '' });

const events = computed(() =>
  [...sdk().data.events.list()]
    .filter((e) => (e.kind ?? 'event') === 'event' && e.dateStart)
    .sort((a, b) => (b.dateStart ?? '').localeCompare(a.dateStart ?? '')),
);

function flash(msg: string): void {
  notice.value = msg;
  setTimeout(() => (notice.value = null), 3000);
}
const fail = (err: unknown, fallback: string) => (error.value = err instanceof Error ? err.message : fallback);

async function search(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const params: Record<string, string> = {};
    for (const k of ['q', 'city', 'country', 'from', 'to'] as const) if (filters[k]) params[k] = filters[k];
    if (filters.past) params.past = '1';
    const res = await api.pool.search(params);
    listings.value = res.listings;
    more.value = res.more;
  } catch (err) {
    fail(err, 'Could not load the shared events.');
  } finally {
    loading.value = false;
  }
}

async function loadMine(): Promise<void> {
  try {
    const { shared: rows } = await api.pool.mine();
    shared.value = Object.fromEntries(rows.map((r) => [r.eventId, r.listing]));
    sharedName.value = Object.fromEntries(rows.map((r) => [r.eventId, r.displayName]));
  } catch (err) {
    fail(err, 'Could not load your shared events.');
  }
}

onMounted(() => {
  void search();
  void loadMine();
});

function dates(l: PoolListing): string {
  return l.dateEnd && l.dateEnd !== l.dateStart ? `${l.dateStart} to ${l.dateEnd}` : l.dateStart;
}
const place = (l: PoolListing) => [l.venueName, l.street, [l.postcode, l.city].filter(Boolean).join(' '), l.country].filter(Boolean).join(', ');

/** Creates the event in this account from the listing, then tells the server so it is not offered again. */
async function quickAdd(l: PoolListing): Promise<void> {
  busyId.value = l.id;
  error.value = null;
  try {
    const event: SalesEvent = {
      id: crypto.randomUUID(),
      name: l.name,
      dateStart: l.dateStart,
      dateEnd: l.dateEnd,
      venue: { street: l.street, postcode: l.postcode, city: l.city, country: l.country },
      currency: sdk().account()?.profile.defaultCurrency || 'EUR',
      status: 'planned',
      notes: [l.venueName, l.description].filter(Boolean).join('\n') || undefined,
      updatedAt: Date.now(),
    };
    await sdk().data.events.upsert(event);
    if (l.url) await api.saveOverlay(event.id, EventOverlaySchema.parse({ link: l.url }));
    await api.pool.adopt(l.id, event.id);
    listings.value = listings.value.filter((x) => x.id !== l.id);
    flash(`Added ${l.name} to your events.`);
  } catch (err) {
    fail(err, 'Could not add the event.');
  } finally {
    busyId.value = null;
  }
}

async function submitReport(l: PoolListing): Promise<void> {
  try {
    await api.pool.report(l.id, reportReason.value, reportNote.value);
    reporting.value = null;
    reportNote.value = '';
    flash('Thanks - reported.');
  } catch (err) {
    fail(err, 'Could not send the report.');
  }
}

async function openShare(ev: SalesEvent): Promise<void> {
  sharing.value = ev.id;
  const mine = shared.value[ev.id];
  let link = mine?.url ?? '';
  if (!mine) {
    try {
      link = (await api.config()).overlays[ev.id]?.link ?? '';
    } catch {
      /* the link is a convenience */
    }
  }
  Object.assign(form, {
    edition: mine?.edition ?? '',
    venueName: mine?.venueName ?? '',
    url: link.startsWith('https://') ? link : '',
    description: mine?.description ?? '',
    displayName: sharedName.value[ev.id] ?? '',
  });
}

async function share(ev: SalesEvent): Promise<void> {
  error.value = null;
  try {
    const { listing } = await api.pool.share({ eventId: ev.id, ...form });
    shared.value = { ...shared.value, [ev.id]: listing };
    sharedName.value = { ...sharedName.value, [ev.id]: form.displayName };
    sharing.value = null;
    flash('Shared to the pool.');
    void search();
  } catch (err) {
    fail(err, 'Could not share the event.');
  }
}

async function withdraw(ev: SalesEvent): Promise<void> {
  error.value = null;
  try {
    await api.pool.withdraw(ev.id);
    const { [ev.id]: _gone, ...rest } = shared.value;
    shared.value = rest;
    sharing.value = null;
    flash('Withdrawn from the pool.');
    void search();
  } catch (err) {
    fail(err, 'Could not withdraw the event.');
  }
}
</script>

<template>
  <section class="find">
    <header>
      <h1>Find events</h1>
      <p class="lede">
        Events other booths have shared. Quick add copies the dates, address and link into your own events;
        you can change anything afterwards.
      </p>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="ok" role="status">{{ notice }}</p>

    <div class="layout">
      <div class="col">
        <form class="card" @submit.prevent="search">
          <h2>Search</h2>
          <div class="grid">
            <label><span>Name</span><input v-model="filters.q" type="search" maxlength="80" /></label>
            <label><span>City</span><input v-model="filters.city" type="text" maxlength="80" /></label>
            <label><span>Country</span><input v-model="filters.country" type="text" maxlength="80" /></label>
            <label><span>From</span><input v-model="filters.from" type="date" /></label>
            <label><span>To</span><input v-model="filters.to" type="date" /></label>
          </div>
          <div class="actions">
            <label class="inline"><input v-model="filters.past" type="checkbox" /> <span>Include past events</span></label>
            <button type="submit" class="primary" :disabled="loading">{{ loading ? 'Searching…' : 'Search' }}</button>
          </div>
        </form>

        <p v-if="!loading && !listings.length" class="hint">
          Nothing to add right now. Events you already have or already added are left out.
        </p>
        <article v-for="l in listings" :key="l.id" class="card listing">
          <div class="head">
            <strong class="name">{{ l.name }}</strong>
            <span v-if="l.edition" class="badge">{{ l.edition }}</span>
          </div>
          <span class="when">{{ dates(l) }}</span>
          <span class="where">{{ place(l) }}</span>
          <p v-if="l.description" class="desc">{{ l.description }}</p>
          <a v-if="l.url" :href="l.url" target="_blank" rel="noopener noreferrer nofollow" class="link">{{ l.url }}</a>
          <p class="going">
            {{ l.going }} {{ l.going === 1 ? 'artist is' : 'artists are' }} going<template v-if="l.names.length">: {{ l.names.join(', ') }}</template>
          </p>
          <div class="actions">
            <button type="button" class="primary" :disabled="busyId === l.id" @click="quickAdd(l)">
              {{ busyId === l.id ? 'Adding…' : 'Quick add' }}
            </button>
            <button type="button" class="quiet" @click="reporting = reporting === l.id ? null : l.id">Report</button>
          </div>
          <form v-if="reporting === l.id" class="report" @submit.prevent="submitReport(l)">
            <label>
              <span>What is wrong?</span>
              <select v-model="reportReason">
                <option value="wrong">Wrong or outdated details</option>
                <option value="spam">Spam or not a real event</option>
                <option value="offensive">Offensive</option>
                <option value="other">Something else</option>
              </select>
            </label>
            <label><span>Note (optional)</span><input v-model="reportNote" type="text" maxlength="300" /></label>
            <button type="submit">Send report</button>
          </form>
        </article>
        <p v-if="more" class="hint">More results exist - narrow the search to see them.</p>
      </div>

      <div class="col">
        <div class="card">
          <h2>Share your events</h2>
          <p class="hint">
            Sharing is opt-in for each event. Only the name, dates, address, link and the short text you add
            below are published. Costs, sales, stock, notes and files never are. Your name is not shown
            unless you fill in the display name; others only see how many booths are going.
          </p>
          <p v-if="!events.length" class="hint">No events with dates yet.</p>
          <div v-for="ev in events" :key="ev.id" class="event">
            <div class="row">
              <span class="name">{{ ev.name }}</span>
              <span class="when">{{ ev.dateStart }}</span>
              <span v-if="shared[ev.id]" class="badge">shared</span>
              <button type="button" class="quiet" @click="sharing === ev.id ? (sharing = null) : openShare(ev)">
                {{ shared[ev.id] ? 'Edit' : 'Share' }}
              </button>
            </div>
            <form v-if="sharing === ev.id" class="extras" @submit.prevent="share(ev)">
              <div class="grid">
                <label><span>Edition (optional)</span><input v-model="form.edition" type="text" maxlength="60" placeholder="2026" /></label>
                <label><span>Venue name</span><input v-model="form.venueName" type="text" maxlength="120" /></label>
                <label><span>Website or tickets</span><input v-model="form.url" type="url" maxlength="500" placeholder="https://…" /></label>
                <label><span>Display name (optional)</span><input v-model="form.displayName" type="text" maxlength="60" /></label>
              </div>
              <label><span>Short description</span><input v-model="form.description" type="text" maxlength="400" /></label>
              <div class="actions">
                <button type="submit" class="primary">{{ shared[ev.id] ? 'Update listing' : 'Share to the pool' }}</button>
                <button v-if="shared[ev.id]" type="button" class="quiet" @click="withdraw(ev)">Withdraw</button>
              </div>
              <small class="hint">Needs a city and valid dates on the event. Links must be https.</small>
            </form>
            <p v-else-if="shared[ev.id]" class="hint">{{ shared[ev.id]!.going }} {{ shared[ev.id]!.going === 1 ? 'artist is' : 'artists are' }} going.</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.find { display: flex; flex-direction: column; gap: 1rem; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: 1.05rem; }
.lede, .hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .9rem; max-width: 60ch; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.ok { color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; margin: 0; }
.layout { display: grid; grid-template-columns: 3fr 2fr; gap: 1rem; align-items: start; }
.col { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .6rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .75rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label.inline { flex-direction: row; align-items: center; gap: .4rem; }
.actions { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.head { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.name { font-weight: 600; }
.when, .where, .going { color: var(--zfy-muted, #5a6472); font-size: .85rem; margin: 0; }
.desc { margin: 0; font-size: .9rem; }
.link { color: var(--zfy-accent-ink, #0a5a4a); font-size: .85rem; overflow-wrap: anywhere; }
.badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; color: var(--zfy-accent-ink, #0a5a4a); background: var(--zfy-accent-soft, #deeee9); border-radius: 999px; padding: .1rem .5rem; }
.event { border-top: 1px solid var(--zfy-line, #d6dde4); padding-top: .5rem; display: flex; flex-direction: column; gap: .4rem; }
.row { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; font-size: .9rem; }
.row .quiet { margin-left: auto; }
.extras, .report { display: flex; flex-direction: column; gap: .6rem; padding: .4rem 0; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
</style>
