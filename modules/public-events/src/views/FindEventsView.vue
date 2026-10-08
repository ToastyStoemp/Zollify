<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import type { PoolListing, SalesEvent } from '@zollify/shared';
import { api } from '../api';
import { sdk } from '../runtime';
import SharingCard from './SharingCard.vue';

/**
 * Find events: search the pool other booths share to and quick-add one into
 * this account. Open to every account, sharing or not. Listings carry public
 * event facts only - never who goes. Everything shown comes from the
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

onMounted(() => {
  void search();
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
      ...(l.url ? { booth: { link: l.url } } : {}),
      updatedAt: Date.now(),
    };
    await sdk().data.events.upsert(event);
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
</script>

<template>
  <section class="find">
    <header>
      <h1>Find events</h1>
      <p class="lede">
        Events other booths have shared. Nobody can see who goes to which event. Quick add copies the dates, address and link into your own events;
        you can change anything afterwards.
      </p>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="ok" role="status">{{ notice }}</p>

    <SharingCard />

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
          Nothing to add right now. Events you already have, share or added are left out.
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
.layout { display: grid; grid-template-columns: 1fr; gap: 1rem; align-items: start; }
.col { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .6rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .75rem; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
label.inline { flex-direction: row; align-items: center; gap: .4rem; }
.actions { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.head { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.name { font-weight: 600; }
.when, .where { color: var(--zfy-muted, #5a6472); font-size: .85rem; margin: 0; }
.desc { margin: 0; font-size: .9rem; }
.link { color: var(--zfy-accent-ink, #0a5a4a); font-size: .85rem; overflow-wrap: anywhere; }
.badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; color: var(--zfy-accent-ink, #0a5a4a); background: var(--zfy-accent-soft, #deeee9); border-radius: 999px; padding: .1rem .5rem; }
.report { display: flex; flex-direction: column; gap: .6rem; padding: .4rem 0; }
</style>
