<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import {
  activeEvent,
  allProducts,
  currentAccount,
  inventoryRows,
  lastSyncAt,
  recentTransactions,
  syncState,
  visibleEvents,
} from '@zollify/platform';
import { fmtPrice } from '@zollify/shared';
import { Icon } from '@zollify/ui';

/**
 * Home is the booth's morning glance: where you are selling, how today is
 * going, what is coming up, and what is about to run out. Every number links
 * to the screen that explains it.
 */

const router = useRouter();
const account = currentAccount;

const hasRoute = (name: string): boolean => router.hasRoute(name);
const canSell = computed(() => hasRoute('pos:index'));
const isAdmin = computed(() => account.value?.role === 'owner' || account.value?.role === 'admin');

const today = new Date().toISOString().slice(0, 10);
const startOfDay = new Date();
startOfDay.setHours(0, 0, 0, 0);

const greeting = computed(() => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
});

// ── Today at the active event ───────────────────────────────────────────────
const event = activeEvent;

const todaysSales = computed(() =>
  recentTransactions.value.filter((t) => !t.revertedAt && t.timestamp >= startOfDay.getTime() && (!event.value || t.eventId === event.value.id)),
);
const eventSales = computed(() => (event.value ? recentTransactions.value.filter((t) => !t.revertedAt && t.eventId === event.value!.id) : []));

function sum(list: typeof recentTransactions.value, kind?: 'cash' | 'card'): number {
  let total = 0;
  for (const t of list) {
    for (const leg of t.payments) if (!kind || leg.kind === kind) total += leg.amount;
  }
  return Math.round(total * 100) / 100;
}
const currency = computed(() => event.value?.localCurrency ?? event.value?.currency ?? todaysSales.value[0]?.currency ?? account.value?.profile.defaultCurrency ?? 'CHF');
const todayTotal = computed(() => sum(todaysSales.value));
const todayCash = computed(() => sum(todaysSales.value, 'cash'));
const todayCard = computed(() => sum(todaysSales.value, 'card'));
const eventTotal = computed(() => sum(eventSales.value));
const lastSale = computed(() => todaysSales.value.reduce<number>((m, t) => Math.max(m, t.timestamp), 0));

/** Top sellers today, by units. */
const bestToday = computed(() => {
  const units = new Map<string, { title: string; qty: number }>();
  for (const t of todaysSales.value) {
    for (const item of t.items) {
      const cur = units.get(item.title) ?? { title: item.title, qty: 0 };
      cur.qty += item.qty;
      units.set(item.title, cur);
    }
  }
  return [...units.values()].sort((a, b) => b.qty - a.qty).slice(0, 3);
});

// ── Coming up ───────────────────────────────────────────────────────────────
const upcoming = computed(() =>
  visibleEvents.value
    .filter((e) => e.dateStart && (e.dateEnd ?? e.dateStart)! >= today)
    .sort((a, b) => a.dateStart!.localeCompare(b.dateStart!))
    .slice(0, 4),
);

function daysUntil(iso: string): string {
  const d = Math.round((new Date(`${iso}T00:00:00`).getTime() - startOfDay.getTime()) / 86_400_000);
  if (d < 0) return 'now';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d < 14) return `in ${d} days`;
  return `in ${Math.round(d / 7)} weeks`;
}

function range(e: { dateStart?: string; dateEnd?: string }): string {
  const f = (s: string): string => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (!e.dateStart) return '';
  return e.dateEnd && e.dateEnd !== e.dateStart ? `${f(e.dateStart)} – ${f(e.dateEnd)}` : f(e.dateStart);
}

// ── Stock ───────────────────────────────────────────────────────────────────
const LOW = 3;
const lowStock = computed(() =>
  inventoryRows()
    .filter((r) => r.counted && r.free <= LOW)
    .sort((a, b) => a.free - b.free)
    .slice(0, 6),
);
const uncounted = computed(() => inventoryRows().filter((r) => !r.counted).length);
const productCount = computed(() => allProducts.value.length);

const syncLine = computed(() => {
  if (syncState.value === 'offline') return 'Offline — sales are kept on this device and sent when the connection returns.';
  if (syncState.value === 'error') return 'Last sync failed — tap Sync in the sidebar to retry.';
  return lastSyncAt.value ? `Synced ${new Date(lastSyncAt.value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.` : '';
});
</script>

<template>
  <section class="home">
    <header class="top">
      <div>
        <h1>{{ greeting }}{{ account ? `, ${account.accountName}` : '' }}</h1>
        <p class="lede">{{ syncLine }}</p>
      </div>
      <div class="actions">
        <router-link v-if="canSell" :to="{ name: 'pos:index' }" class="btn primary"><Icon name="shopping-cart" :size="16" /> Open the till</router-link>
        <router-link v-if="isAdmin" :to="{ name: 'catalog' }" class="btn"><Icon name="plus" :size="16" /> Product</router-link>
        <router-link v-if="isAdmin" :to="{ name: 'events' }" class="btn"><Icon name="calendar" :size="16" /> Event</router-link>
      </div>
    </header>

    <div class="grid">
      <!-- ── Today ───────────────────────────────────────────────────────── -->
      <article class="card wide">
        <header class="chead">
          <h2>Today</h2>
          <router-link v-if="event" :to="{ name: 'events' }" class="sub">at {{ event.name }}</router-link>
          <router-link v-else :to="{ name: 'events' }" class="sub warn"><Icon name="alert-triangle" :size="14" /> No active event — sales won't be filed against one</router-link>
        </header>
        <div class="figures">
          <div class="figure big">
            <span class="label">Taken today</span>
            <strong>{{ fmtPrice(todayTotal, currency) }}</strong>
            <small>{{ todaysSales.length }} sale{{ todaysSales.length === 1 ? '' : 's' }}{{ lastSale ? ` · last ${new Date(lastSale).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '' }}</small>
          </div>
          <div class="figure"><span class="label">Cash</span><strong>{{ fmtPrice(todayCash, currency) }}</strong></div>
          <div class="figure"><span class="label">Card</span><strong>{{ fmtPrice(todayCard, currency) }}</strong></div>
          <div v-if="event" class="figure"><span class="label">Whole event</span><strong>{{ fmtPrice(eventTotal, currency) }}</strong><small>{{ eventSales.length }} sales</small></div>
        </div>
        <div v-if="bestToday.length" class="best">
          <span class="label">Selling best</span>
          <ol>
            <li v-for="b in bestToday" :key="b.title"><span>{{ b.title }}</span><strong>{{ b.qty }}</strong></li>
          </ol>
        </div>
        <footer class="cfoot">
          <router-link :to="{ name: 'history' }">History <Icon name="chevron-right" :size="14" /></router-link>
          <router-link v-if="isAdmin && event" :to="{ name: 'cashup' }">Cash up <Icon name="chevron-right" :size="14" /></router-link>
        </footer>
      </article>

      <!-- ── Coming up ───────────────────────────────────────────────────── -->
      <article class="card">
        <header class="chead"><h2>Coming up</h2></header>
        <p v-if="!upcoming.length" class="empty">No upcoming events. <router-link :to="{ name: 'events' }">Plan one</router-link>.</p>
        <ul v-else class="list">
          <li v-for="e in upcoming" :key="e.id" :class="{ active: e.id === event?.id }">
            <div>
              <strong>{{ e.name }}</strong>
              <small>{{ range(e) }}{{ e.venue?.city ? ` · ${e.venue.city}` : '' }}</small>
            </div>
            <span class="when">{{ e.id === event?.id ? 'active' : daysUntil(e.dateStart!) }}</span>
          </li>
        </ul>
        <footer class="cfoot">
          <router-link :to="{ name: 'events' }">All events <Icon name="chevron-right" :size="14" /></router-link>
          <router-link v-if="hasRoute('customs:index')" :to="{ name: 'customs:index' }">Customs papers <Icon name="chevron-right" :size="14" /></router-link>
        </footer>
      </article>

      <!-- ── Stock ───────────────────────────────────────────────────────── -->
      <article class="card">
        <header class="chead"><h2>Stock</h2><span class="sub">{{ productCount }} product{{ productCount === 1 ? '' : 's' }}</span></header>
        <p v-if="!lowStock.length" class="empty">Nothing is running low.</p>
        <template v-else>
          <span class="label">Running low</span>
          <ul class="list">
            <li v-for="r in lowStock" :key="r.productId + r.variantId">
              <span>{{ r.label }}</span>
              <strong :class="{ bad: r.free <= 0 }">{{ r.free <= 0 ? 'none free' : `${r.free} free` }}</strong>
            </li>
          </ul>
        </template>
        <p v-if="uncounted" class="hint">{{ uncounted }} item{{ uncounted === 1 ? '' : 's' }} never counted.</p>
        <footer class="cfoot">
          <router-link :to="{ name: 'stock' }">Inventory <Icon name="chevron-right" :size="14" /></router-link>
          <router-link v-if="isAdmin" :to="{ name: 'catalog' }">Products <Icon name="chevron-right" :size="14" /></router-link>
        </footer>
      </article>
    </div>
  </section>
</template>

<style scoped>
.home { display: flex; flex-direction: column; gap: 1.25rem; }
.top { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.5rem; letter-spacing: -.01em; }
h2 { margin: 0; font-size: 1rem; }
.lede, .hint, .empty { color: var(--zfy-muted); margin: 0; font-size: .875rem; }
.actions { display: flex; gap: .5rem; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; gap: .4rem; min-height: 2.5rem; padding: .45rem .95rem; border-radius: 8px; border: 1px solid var(--zfy-line); background: var(--zfy-surface); color: inherit; text-decoration: none; font-weight: 500; font-size: .9rem; }
.btn:hover { background: var(--zfy-surface-2); }
.btn.primary { background: var(--zfy-accent); border-color: var(--zfy-accent); color: var(--zfy-on-accent); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1rem; }
.card { border: 1px solid var(--zfy-line); border-radius: 12px; background: var(--zfy-surface); padding: 1rem; display: flex; flex-direction: column; gap: .75rem; }
.card.wide { grid-column: 1 / -1; }
.chead { display: flex; align-items: baseline; gap: .75rem; flex-wrap: wrap; }
.sub { color: var(--zfy-muted); font-size: .85rem; text-decoration: none; display: inline-flex; align-items: center; gap: .3rem; }
.sub.warn { color: var(--zfy-warning-ink); }
.label { font-size: .7rem; letter-spacing: .06em; text-transform: uppercase; color: var(--zfy-muted); }
.figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .75rem; }
.figure { display: flex; flex-direction: column; gap: .1rem; padding: .6rem .8rem; border-radius: 10px; background: var(--zfy-bg); }
.figure strong { font-size: 1.25rem; font-variant-numeric: tabular-nums; }
.figure.big strong { font-size: 1.75rem; color: var(--zfy-accent-ink); }
.figure small { color: var(--zfy-muted); font-size: .75rem; }
.best { display: flex; flex-direction: column; gap: .3rem; }
.best ol { margin: 0; padding: 0 0 0 1.2rem; display: flex; flex-direction: column; gap: .15rem; font-size: .9rem; }
.best li { display: flex; justify-content: space-between; gap: 1rem; }
.best strong { font-variant-numeric: tabular-nums; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.list li { display: flex; justify-content: space-between; align-items: center; gap: .75rem; font-size: .9rem; }
.list li > div { display: flex; flex-direction: column; min-width: 0; }
.list small { color: var(--zfy-muted); font-size: .78rem; }
.list li.active strong { color: var(--zfy-accent-ink); }
.when { font-size: .78rem; color: var(--zfy-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.list li.active .when { color: var(--zfy-accent-ink); font-weight: 600; }
.bad { color: var(--zfy-danger); }
.cfoot { margin-top: auto; padding-top: .5rem; border-top: 1px solid var(--zfy-line); display: flex; gap: 1rem; flex-wrap: wrap; }
.cfoot a { display: inline-flex; align-items: center; gap: .15rem; font-size: .85rem; color: var(--zfy-accent-ink); text-decoration: none; }
.cfoot a:hover { text-decoration: underline; }
</style>
