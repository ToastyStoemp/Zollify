<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { NOTIFY_KIND_LABEL, NewsInputSchema, type NotifyKind, type Product } from '@zollify/shared';
import { QrCode, qrPngBase64 } from '@zollify/ui';
import { api, errorText, type NewsItem, type Overview, type SubscriberView } from '../api';
import { sdk } from '../runtime';

/**
 * The admin's side of Notify me: the codes to print (one for the booth, one
 * per item), who signed up and for what, a note to send to those who asked
 * for news, and the counts.
 */
const tab = ref<'codes' | 'subscribers' | 'news'>('codes');
const overview = ref<Overview | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

async function load(): Promise<void> {
  error.value = null;
  try {
    overview.value = await api.overview();
  } catch (err) {
    error.value = errorText(err, 'Could not load - this needs a connection.');
  }
}
onMounted(load);
function flash(msg: string): void {
  notice.value = msg;
  setTimeout(() => { if (notice.value === msg) notice.value = null; }, 4000);
}
const when = (ms: number | null): string => (ms ? new Date(ms).toLocaleDateString() : '-');
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ── Codes ──────────────────────────────────────────────────────────────────
const query = ref('');
const products = computed(() => {
  const q = query.value.trim().toLowerCase();
  return sdk().data.products.forSale().filter((p) => !q || p.title.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q)).slice(0, 30);
});
const picked = ref<Product | null>(null);
const urlFor = (p: Product | null): string => (overview.value?.publicUrl ? (p ? `${overview.value.publicUrl}/i/${encodeURIComponent(p.id)}` : overview.value.publicUrl) : '');

/** A sheet to print: the code, what it is for, and the address in words under it. */
async function printSheet(p: Product | null): Promise<void> {
  const url = urlFor(p);
  if (!url) return;
  const png = await qrPngBase64(url, { paperDots: 600, codeDots: 520 });
  const shop = sdk().account()?.accountName ?? '';
  const title = p ? `Want "${p.title}" when it is back?` : 'Hear from us';
  const sub = p ? 'Scan to be told when it is back in stock.' : 'Scan to hear when we are next near you, or when something new is in.';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Notify me</title><style>
  @page { margin: 12mm; } body { font-family: system-ui, sans-serif; color: #111; margin: 0; display: flex; justify-content: center; }
  .card { width: 100mm; text-align: center; display: flex; flex-direction: column; gap: 4mm; padding: 8mm; border: 1px solid #999; border-radius: 8px; }
  h1 { margin: 0; font-size: 16pt; } p { margin: 0; font-size: 10pt; color: #444; } img { width: 70mm; height: 70mm; align-self: center; } .url { font-size: 8pt; color: #666; overflow-wrap: anywhere; } .shop { font-size: 9pt; letter-spacing: .08em; text-transform: uppercase; }
  </style></head><body><div class="card"><div class="shop">${esc(shop)}</div><h1>${esc(title)}</h1><img src="data:image/png;base64,${png}" alt="QR code"><p>${esc(sub)}</p><p class="url">${esc(url)}</p></div>
  <script>window.addEventListener('load',function(){setTimeout(function(){window.print()},150)})<\/script></body></html>`;
  if (!(await sdk().ui.openDocument(`notify-me-${p ? p.id : 'booth'}.html`, html, 'text/html'))) sdk().ui.toast('The print window was blocked - allow pop-ups for this site.', { kind: 'warning' });
}
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flash('Copied.');
  } catch {
    sdk().ui.toast('Could not copy - select the address and copy it by hand.', { kind: 'warning' });
  }
}

// ── Subscribers ────────────────────────────────────────────────────────────
const subs = ref<SubscriberView[] | null>(null);
const subQuery = ref('');
const filter = ref<'live' | 'unconfirmed' | 'left' | 'all'>('live');
const FILTERS = [
  { id: 'live', label: 'Confirmed' },
  { id: 'unconfirmed', label: 'Waiting' },
  { id: 'left', label: 'Left' },
  { id: 'all', label: 'All' },
] as const;
let typing: ReturnType<typeof setTimeout> | undefined;
async function loadSubs(): Promise<void> {
  try {
    subs.value = (await api.subscribers(subQuery.value.trim())).subscribers;
  } catch (err) {
    error.value = errorText(err, 'Could not load the subscribers.');
  }
}
function onSubQuery(): void {
  clearTimeout(typing);
  typing = setTimeout(loadSubs, 250);
}
const state = (s: SubscriberView): 'live' | 'unconfirmed' | 'left' => (s.unsubscribedAt != null ? 'left' : s.confirmedAt == null ? 'unconfirmed' : 'live');
const shownSubs = computed(() => (subs.value ?? []).filter((s) => filter.value === 'all' || state(s) === filter.value));
const kindsOf = (s: SubscriberView): string => s.kinds.map((k: NotifyKind) => NOTIFY_KIND_LABEL[k]).join(', ');
const kindLabel = (k: string): string => NOTIFY_KIND_LABEL[k as NotifyKind] ?? k;
async function erase(s: SubscriberView): Promise<void> {
  if (!(await sdk().ui.confirm(`Erase ${s.email}? They will hear nothing more and the address is gone.`, 'Erase subscriber', { confirm: 'Erase' }))) return;
  try {
    await api.remove(s.id);
    subs.value = (subs.value ?? []).filter((x) => x.id !== s.id);
    void load();
  } catch (err) {
    error.value = errorText(err, 'Could not erase.');
  }
}

// ── News ───────────────────────────────────────────────────────────────────
const news = ref<NewsItem[] | null>(null);
const draft = reactive({ subject: '', text: '' });
async function loadNews(): Promise<void> {
  try {
    news.value = (await api.news()).news;
  } catch (err) {
    error.value = errorText(err, 'Could not load the news.');
  }
}
async function send(): Promise<void> {
  error.value = null;
  const parsed = NewsInputSchema.safeParse(draft);
  if (!parsed.success) {
    error.value = parsed.error.issues[0]?.message ?? 'Check the message.';
    return;
  }
  const n = overview.value?.counts.byKind.news ?? 0;
  if (!(await sdk().ui.confirm(`Send "${parsed.data.subject}" to ${n} ${n === 1 ? 'person' : 'people'} now?`, 'Send news', { confirm: 'Send' }))) return;
  busy.value = true;
  try {
    const { news: item } = await api.send(parsed.data);
    news.value = [item, ...(news.value ?? [])];
    draft.subject = '';
    draft.text = '';
    flash(`Sent to ${item.sent} of ${item.recipients}.`);
  } catch (err) {
    error.value = errorText(err, 'Could not send.');
  } finally {
    busy.value = false;
  }
}
function open(t: typeof tab.value): void {
  tab.value = t;
  if (t === 'subscribers' && !subs.value) void loadSubs();
  if (t === 'news' && !news.value) void loadNews();
}
</script>

<template>
  <div class="notify">
    <header class="top">
      <div>
        <h1>Notify me</h1>
        <p class="lede">A code customers scan to hear when an item is back, when you are next near them, or what is new in the webstore. Addresses are confirmed before anything is sent and erased when they leave.</p>
      </div>
    </header>
    <div class="chips tabs" role="tablist" aria-label="View">
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'codes' }" :aria-selected="tab === 'codes'" @click="open('codes')">Codes</button>
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'subscribers' }" :aria-selected="tab === 'subscribers'" @click="open('subscribers')">Subscribers <small v-if="overview">{{ overview.counts.live }}</small></button>
      <button type="button" class="chip" role="tab" :class="{ on: tab === 'news' }" :aria-selected="tab === 'news'" @click="open('news')">News</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="ok" role="status">{{ notice }}</p>
    <p v-if="overview && !overview.mailEnabled" class="error">This server cannot send email, so nobody can confirm a sign-up yet.</p>
    <p v-else-if="overview && !overview.publicUrl" class="warn">The page has no address yet - give it one under Settings → Notify me.</p>

    <template v-if="tab === 'codes' && overview?.publicUrl">
      <div class="two">
        <section class="card">
          <h2>For the booth or the counter</h2>
          <p class="hint">One code for everything the page offers. Print it on the table sign or next to the till.</p>
          <QrCode :value="urlFor(null)" :size="180" />
          <p class="url">{{ urlFor(null) }}</p>
          <div class="actions">
            <button type="button" class="primary" @click="printSheet(null)">Print</button>
            <button type="button" @click="copy(urlFor(null))">Copy link</button>
          </div>
        </section>
        <section class="card">
          <h2>For one item</h2>
          <p class="hint">Scanned from a label or price card: the page asks to be told when that item is back. Hand it out when something sells out.</p>
          <input v-model="query" type="search" placeholder="Find an item" aria-label="Find an item" />
          <ul class="list">
            <li v-for="p in products" :key="p.id"><button type="button" :class="{ on: picked?.id === p.id }" @click="picked = p">{{ p.title }}<small v-if="p.sku" class="hint"> · {{ p.sku }}</small></button></li>
          </ul>
          <template v-if="picked">
            <QrCode :value="urlFor(picked)" :size="160" />
            <p class="url">{{ urlFor(picked) }}</p>
            <div class="actions">
              <button type="button" class="primary" @click="printSheet(picked)">Print</button>
              <button type="button" @click="copy(urlFor(picked))">Copy link</button>
            </div>
          </template>
        </section>
      </div>
    </template>

    <template v-else-if="tab === 'subscribers'">
      <ul v-if="overview" class="stats">
        <li><span class="label">Confirmed</span><strong>{{ overview.counts.live }}</strong></li>
        <li v-for="(n, k) in overview.counts.byKind" :key="k"><span class="label">{{ kindLabel(String(k)) }}</span><strong>{{ n }}</strong></li>
        <li><span class="label">Waiting to confirm</span><strong>{{ overview.counts.unconfirmed }}</strong></li>
      </ul>
      <div class="bar">
        <input v-model="subQuery" type="search" placeholder="Find an address" aria-label="Find an address" @input="onSubQuery" />
        <div class="chips" role="group" aria-label="Filter">
          <button v-for="f in FILTERS" :key="f.id" type="button" class="chip" :class="{ on: filter === f.id }" @click="filter = f.id">{{ f.label }}</button>
        </div>
      </div>
      <p v-if="!subs" class="hint">Loading…</p>
      <p v-else-if="!shownSubs.length" class="hint">Nobody here yet.</p>
      <div v-else class="table-scroll stack">
        <table>
          <thead><tr><th>Email</th><th>Hears about</th><th>Items</th><th>Where</th><th>Since</th><th>Last mail</th><th></th></tr></thead>
          <tbody>
            <tr v-for="s in shownSubs" :key="s.id" class="row">
              <td><strong>{{ s.email }}</strong><span v-if="state(s) !== 'live'" class="badge" :class="state(s)"> {{ state(s) === 'left' ? 'left' : 'waiting' }}</span></td>
              <td data-label="Hears about">{{ kindsOf(s) }}</td>
              <td data-label="Items">{{ s.products.length ? s.products.join(', ') : (s.kinds.includes('restock') ? 'anything' : '-') }}</td>
              <td data-label="Where">{{ s.country || (s.kinds.includes('events') ? 'anywhere' : '-') }}</td>
              <td data-label="Since">{{ when(s.confirmedAt ?? s.createdAt) }}</td>
              <td data-label="Last mail">{{ when(s.lastSentAt) }}</td>
              <td><button type="button" class="danger" @click="erase(s)">Erase</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else-if="tab === 'news'">
      <form class="card" @submit.prevent="send">
        <h2>A note to those who asked for news</h2>
        <p class="hint">Goes out now, one plain mail each, with your webstore link and a leave link. {{ overview?.counts.byKind.news ?? 0 }} would get it.</p>
        <label>Subject <input v-model="draft.subject" type="text" maxlength="120" required /></label>
        <label>Message <textarea v-model="draft.text" rows="6" maxlength="4000" required></textarea></label>
        <div class="actions"><button type="submit" class="primary" :disabled="busy || !overview?.mailEnabled">Send</button></div>
      </form>
      <p v-if="news && !news.length" class="hint">Nothing sent yet.</p>
      <ul v-else-if="news" class="history">
        <li v-for="n in news" :key="n.id"><strong>{{ n.subject }}</strong><span class="hint"> · {{ when(n.createdAt) }} · sent to {{ n.sent }} of {{ n.recipients }}</span><p class="text">{{ n.text }}</p></li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.notify { display: flex; flex-direction: column; gap: .8rem; }
.top { display: flex; align-items: center; justify-content: space-between; gap: .6rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: 1.05rem; }
.lede, .hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .9rem; max-width: 70ch; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.warn { margin: 0; color: #9a3412; }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .875rem; }
.chips { display: flex; gap: .3rem; flex-wrap: wrap; }
.chip { font-size: .78rem; padding: .2rem .6rem; border-radius: 999px; min-height: 0; }
.chip.on { background: var(--zfy-accent, #0e7c66); color: #fff; }
.chip small { opacity: .7; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: start; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .6rem; }
.url { margin: 0; font-size: .8rem; color: var(--zfy-muted, #5a6472); overflow-wrap: anywhere; user-select: all; }
.actions { display: flex; gap: .5rem; flex-wrap: wrap; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .2rem; max-height: 14rem; overflow: auto; }
.list button { width: 100%; text-align: left; font-weight: 400; padding: .35rem .6rem; min-height: 2.2rem; }
.list button.on { outline: 2px solid var(--zfy-accent, #0e7c66); }
.bar { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
.badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; border-radius: 999px; padding: .1rem .55rem; background: #fef3c7; color: #92400e; margin-left: .4rem; }
.badge.left { background: #e5e7eb; color: #374151; }
table { width: 100%; border-collapse: collapse; background: var(--zfy-surface, #fff); border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: .5rem .7rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); font-size: .9rem; white-space: nowrap; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); }
tbody tr:last-child td { border-bottom: 0; }
.danger { color: var(--zfy-danger, #c6512f); }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .875rem; }
textarea { font: inherit; }
.history { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .6rem; }
.history li { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; background: var(--zfy-surface, #fff); }
.text { margin: .3rem 0 0; white-space: pre-line; font-size: .9rem; }
@media (max-width: 800px) { .two { grid-template-columns: 1fr; } }
</style>
