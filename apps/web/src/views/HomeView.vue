<script setup lang="ts">
import { computed, defineAsyncComponent, markRaw, onMounted, onUnmounted, ref, watch } from 'vue';
import type { CalendarEntry } from '@zollify/sdk';
import { contributions } from '../boot';
import { useRouter } from 'vue-router';
import {
  activeEvent,
  availabilityFor,
  allProducts,
  currentAccount,
  inventoryRows,
  lastSyncAt,
  recentTransactions,
  syncState,
  visibleEvents,
} from '@zollify/platform';
import { fmtPrice, isStore, localIsoDay, seesSalesTotals, sellsAt } from '@zollify/shared';
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
/** Events, stores or both - what the account runs decides the shortcuts here. */
const runs = computed(() => sellsAt(account.value?.profile, visibleEvents.value.some((e) => isStore(e))));
/** Where the active event or store is managed. */
const placesRoute = computed(() => ({ name: event.value && isStore(event.value) ? 'stores' : runs.value.events ? 'events' : 'stores' }));
/** Staff see takings only when the owner allows it (Settings → Team). */
const showTotals = computed(() => seesSalesTotals(account.value));

// Ticked every minute so a tab left open overnight rolls over to the new day
// instead of keeping yesterday's "today" until the next reload.
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 60_000);
});
onUnmounted(() => clearInterval(clock));
const today = computed(() => localIsoDay(now.value));
const startOfDay = computed(() => {
  const d = new Date(now.value);
  d.setHours(0, 0, 0, 0);
  return d;
});

const greeting = computed(() => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
});

// ── Today at the active event ───────────────────────────────────────────────
const event = activeEvent;

const todaysSales = computed(() =>
  recentTransactions.value.filter((t) => !t.revertedAt && t.timestamp >= startOfDay.value.getTime() && (!event.value || t.eventId === event.value.id)),
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
    .filter((e) => e.dateStart && (e.dateEnd ?? e.dateStart)! >= today.value)
    .sort((a, b) => a.dateStart!.localeCompare(b.dateStart!))
    .slice(0, 4),
);

function daysUntil(iso: string): string {
  const d = Math.round((new Date(`${iso}T00:00:00`).getTime() - startOfDay.value.getTime()) / 86_400_000);
  if (d < 0) return 'now';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d < 14) return `in ${d} days`;
  return `in ${Math.round(d / 7)} weeks`;
}

function range(e: { dateStart?: string; dateEnd?: string }): string {
  const f = (s: string): string => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (!e.dateStart) return '';
  return e.dateEnd && e.dateEnd !== e.dateStart ? `${f(e.dateStart)} - ${f(e.dateEnd)}` : f(e.dateStart);
}

// ── Calendar ─────────────────────────────────────────────────────────────────
const calMonth = ref(new Date(startOfDay.value.getFullYear(), startOfDay.value.getMonth(), 1));
function shiftMonth(delta: number): void {
  calMonth.value = new Date(calMonth.value.getFullYear(), calMonth.value.getMonth() + delta, 1);
}
const calMonthLabel = computed(() => calMonth.value.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
const weekdayLabels = computed(() => {
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  const monday = new Date(2024, 0, 1); // a known Monday
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return fmt.format(d);
  });
});

// Stable across days so the same event lands at the same index in every
// day it touches - filtering a fixed order preserves relative order, which
// is what keeps a multi-day event's segments vertically aligned from one
// day cell to the next so the "connect the days" styling below lines up.
const sortedEvents = computed(() => [...visibleEvents.value].sort((a, b) => (a.dateStart ?? '').localeCompare(b.dateStart ?? '') || a.id.localeCompare(b.id)));

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return localIsoDay(d);
}

interface CalEventSpan {
  event: (typeof visibleEvents.value)[number];
  /** True when this event also covers the day before/after - drawn as one continuous bar rather than a separate pill per day. */
  continuesLeft: boolean;
  continuesRight: boolean;
}
interface CalDay {
  iso: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  events: CalEventSpan[];
  /** What modules put on this day - an artist's setup at a store, say. */
  entries: CalendarEntry[];
}

/**
 * Entries from modules for the days on screen. Asked again when the month
 * changes or a module comes or goes; a source that fails is just left out.
 */
const moduleEntries = ref<CalendarEntry[]>([]);
function gridRange(): { from: string; to: string } {
  const first = calMonth.value;
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(start.getDate() + 41);
  return { from: localIsoDay(start), to: localIsoDay(end) };
}
let asked = 0;
async function loadEntries(): Promise<void> {
  const mine = ++asked;
  const range = gridRange();
  const results = await Promise.all(contributions.calendarSources.map((c) => c.source(range).catch(() => [] as CalendarEntry[])));
  if (mine === asked) moduleEntries.value = results.flat();
}
watch([calMonth, () => contributions.calendarSources.length], () => void loadEntries(), { immediate: true });
/** Cards modules add (low stock at the stores an artist consigns with…), for this role. */
const moduleCards = computed(() =>
  account.value
    ? contributions.homeCardsFor(account.value.role).map((c) => ({ id: c.id, comp: markRaw(defineAsyncComponent(c.component as () => Promise<never>)) }))
    : [],
);
function openEntry(e: CalendarEntry): void {
  if (e.link) void router.push(e.link);
}
const calendarWeeks = computed<CalDay[][]>(() => {
  const first = calMonth.value;
  const gridStart = new Date(first);
  gridStart.setDate(1 - ((first.getDay() + 6) % 7)); // back up to the Monday on/before the 1st
  const weeks: CalDay[][] = [];
  const cursor = new Date(gridStart);
  for (let w = 0; w < 6; w++) {
    const days: CalDay[] = [];
    for (let i = 0; i < 7; i++) {
      const iso = localIsoDay(cursor);
      const prevIso = addDays(iso, -1);
      const nextIso = addDays(iso, 1);
      const events = sortedEvents.value
        .filter((e) => e.dateStart && iso >= e.dateStart && iso <= (e.dateEnd ?? e.dateStart)!)
        .map((e) => ({
          event: e,
          // Never bridge across a week row wrap (i===0/6) - the previous/next
          // day there isn't the visually adjacent cell.
          continuesLeft: i > 0 && e.dateStart! <= prevIso && (e.dateEnd ?? e.dateStart)! >= prevIso,
          continuesRight: i < 6 && e.dateStart! <= nextIso && (e.dateEnd ?? e.dateStart)! >= nextIso,
        }));
      const entries = moduleEntries.value.filter((x) => x.date === iso).sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
      days.push({ iso, day: cursor.getDate(), inMonth: cursor.getMonth() === first.getMonth(), isToday: iso === today.value, events, entries });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(days);
  }
  return weeks;
});

// ── Stock ───────────────────────────────────────────────────────────────────
const LOW = 3;
/**
 * With an event open: what it can still sell (its claim, or the pool). With
 * none: what the booth owns outright. "Free" would be wrong here - a fully
 * claimed item has nothing free and is not running low.
 */
const lowStock = computed(() => {
  const ev = event.value;
  const rows = ev
    ? availabilityFor(ev.id).filter((r) => r.claimed !== null || r.onHand > 0).map((r) => ({ key: r.productId + r.variantId, label: r.label, left: r.available }))
    : inventoryRows().filter((r) => r.counted).map((r) => ({ key: r.productId + r.variantId, label: r.label, left: r.free + r.claimed }));
  return rows.filter((r) => r.left <= LOW).sort((a, b) => a.left - b.left).slice(0, 6);
});
const uncounted = computed(() => inventoryRows().filter((r) => !r.counted).length);
const productCount = computed(() => allProducts.value.length);

const syncLine = computed(() => {
  if (syncState.value === 'offline') return 'Offline - sales are kept on this device and sent when the connection returns.';
  if (syncState.value === 'error') return 'Last sync failed - tap Sync in the sidebar to retry.';
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
        <router-link v-if="isAdmin && runs.events" :to="{ name: 'events' }" class="btn"><Icon name="calendar" :size="16" /> Event</router-link>
        <router-link v-if="isAdmin && runs.stores && !runs.events" :to="{ name: 'stores' }" class="btn"><Icon name="store" :size="16" /> Store</router-link>
      </div>
    </header>

    <div class="grid">
      <!-- ── Today ───────────────────────────────────────────────────────── -->
      <article class="card wide">
        <header class="chead">
          <h2>Today</h2>
          <router-link v-if="event" :to="placesRoute" class="sub">at {{ event.name }}</router-link>
          <router-link v-else :to="placesRoute" class="sub warn"><Icon name="alert-triangle" :size="14" /> {{ runs.events ? "No active event - sales won't be filed against one" : "No store open - sales won't be filed against one" }}</router-link>
        </header>
        <p v-if="!showTotals" class="hint">Sales totals are kept for the owner. Ring up sales in the till; your own sales are under History.</p>
        <div v-if="showTotals" class="figures">
          <div class="figure big">
            <span class="label">Taken today</span>
            <strong>{{ fmtPrice(todayTotal, currency) }}</strong>
            <small>{{ todaysSales.length }} sale{{ todaysSales.length === 1 ? '' : 's' }}{{ lastSale ? ` · last ${new Date(lastSale).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '' }}</small>
          </div>
          <div class="figure"><span class="label">Cash</span><strong>{{ fmtPrice(todayCash, currency) }}</strong></div>
          <div class="figure"><span class="label">Card</span><strong>{{ fmtPrice(todayCard, currency) }}</strong></div>
          <div v-if="event" class="figure"><span class="label">{{ isStore(event) ? "Since it opened" : "Whole event" }}</span><strong>{{ fmtPrice(eventTotal, currency) }}</strong><small>{{ eventSales.length }} sales</small></div>
        </div>
        <div v-if="showTotals && bestToday.length" class="best">
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

      <!-- ── Calendar ────────────────────────────────────────────────────── -->
      <article class="card wide">
        <header class="chead cal-head">
          <h2>{{ calMonthLabel }}</h2>
          <div class="cal-nav">
            <button type="button" class="icon-btn" @click="shiftMonth(-1)" aria-label="Previous month"><Icon name="chevron-left" :size="16" /></button>
            <button type="button" class="icon-btn" @click="calMonth = new Date(startOfDay.getFullYear(), startOfDay.getMonth(), 1)" aria-label="This month">Today</button>
            <button type="button" class="icon-btn" @click="shiftMonth(1)" aria-label="Next month"><Icon name="chevron-right" :size="16" /></button>
          </div>
        </header>
        <div class="calendar">
          <div class="cal-weekday" v-for="w in weekdayLabels" :key="w">{{ w }}</div>
          <template v-for="week in calendarWeeks" :key="week[0]!.iso">
            <!-- Only a day that actually has something to show links out - an
                 empty day (most of the grid) would otherwise be a tab stop
                 and a click target that lands on the exact same generic
                 events list as every other empty day. -->
            <component
              :is="d.events.length ? 'router-link' : 'div'"
              v-for="d in week"
              :key="d.iso"
              :to="d.events.length ? { name: 'events' } : undefined"
              class="cal-day"
              :class="{ 'out-month': !d.inMonth, today: d.isToday, 'has-events': d.events.length || d.entries.length }"
            >
              <span class="cal-date">{{ d.day }}</span>
              <span v-if="d.events.length || d.entries.length" class="cal-names">
                <span
                  v-for="e in d.events.slice(0, 2)"
                  :key="e.event.id"
                  class="cal-name"
                  :class="[e.event.status, { left: e.continuesLeft, right: e.continuesRight }]"
                  :title="`${e.event.name} · ${e.event.status}`"
                  ><Icon v-if="!e.continuesLeft" name="calendar" :size="10" class="cal-ico" />{{ e.event.name }}</span
                >
                <!-- Module entries (setups…) share the two visible lines with events. -->
                <span
                  v-for="x in d.entries.slice(0, Math.max(0, 2 - d.events.length))"
                  :key="x.id"
                  class="cal-entry"
                  :class="x.tone ?? 'normal'"
                  :title="x.time ? `${x.time} · ${x.title}` : x.title"
                  role="link"
                  tabindex="0"
                  @click.stop.prevent="openEntry(x)"
                  @keydown.enter.stop.prevent="openEntry(x)"
                  ><Icon :name="x.icon ?? 'clock'" :size="10" class="cal-ico" /><b v-if="x.time" class="cal-time">{{ x.time }}</b>{{ x.title }}</span
                >
                <span v-if="d.events.length + d.entries.length > 2" class="cal-more">+{{ d.events.length + d.entries.length - 2 }} more</span>
              </span>
            </component>
          </template>
        </div>
      </article>

      <!-- ── Coming up ───────────────────────────────────────────────────── -->
      <article v-if="runs.events" class="card">
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
          <router-link v-if="hasRoute('customs-hub:index') && (hasRoute('customs-ch:index') || hasRoute('customs-de:index'))" :to="{ name: 'customs-hub:index' }">Customs papers <Icon name="chevron-right" :size="14" /></router-link>
        </footer>
      </article>

      <!-- ── Stock ───────────────────────────────────────────────────────── -->
      <article class="card">
        <header class="chead"><h2>Stock</h2><span class="sub">{{ productCount }} product{{ productCount === 1 ? '' : 's' }}</span></header>
        <p v-if="!lowStock.length" class="empty">Nothing is running low.</p>
        <template v-else>
          <span class="label">Running low{{ event ? ` at ${event.name}` : '' }}</span>
          <ul class="list">
            <li v-for="r in lowStock" :key="r.key">
              <span>{{ r.label }}</span>
              <strong :class="{ bad: r.left <= 0 }">{{ r.left <= 0 ? 'sold out' : `${r.left} left` }}</strong>
            </li>
          </ul>
        </template>
        <p v-if="uncounted" class="hint">{{ uncounted }} item{{ uncounted === 1 ? '' : 's' }} never counted.</p>
        <footer class="cfoot">
          <router-link :to="{ name: 'stock' }">Inventory <Icon name="chevron-right" :size="14" /></router-link>
          <router-link v-if="isAdmin" :to="{ name: 'catalog' }">Products <Icon name="chevron-right" :size="14" /></router-link>
        </footer>
      </article>

      <!-- ── Cards from modules ──────────────────────────────────────────── -->
      <article v-for="c in moduleCards" :key="c.id" class="card"><component :is="c.comp" /></article>
    </div>
  </section>
</template>

<style scoped>
.card .hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .86rem; }
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
.figure { display: flex; flex-direction: column; gap: .1rem; padding: .6rem .8rem; border-radius: 10px; background: var(--zfy-bg); max-width: 16rem; }
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
.cal-head { justify-content: space-between; }
.cal-nav { display: flex; align-items: center; gap: .3rem; }
.icon-btn { display: inline-flex; align-items: center; gap: .25rem; border: 1px solid var(--zfy-line); background: var(--zfy-bg); color: inherit; border-radius: 8px; padding: .3rem .55rem; font-size: .78rem; cursor: pointer; }
.icon-btn:hover { background: var(--zfy-surface-2); }
.cal-entry { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .68rem; line-height: 1.35; padding: 0 .3rem; border-radius: 4px; border-left: 3px solid var(--zfy-warning); background: var(--zfy-bg); color: var(--zfy-ink); cursor: pointer; }
.cal-ico { display: inline-block; vertical-align: -1px; margin-right: .25em; opacity: .8; }
.cal-time { font-weight: 600; margin-right: .3em; }
.cal-entry.attention { border-left-color: var(--zfy-danger); background: var(--zfy-signal-soft); font-weight: 600; }
.cal-entry.muted { color: var(--zfy-muted); text-decoration: line-through; }
.calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: .25rem; }
.cal-weekday { text-align: center; font-size: .72rem; letter-spacing: .04em; text-transform: uppercase; color: var(--zfy-muted); padding-bottom: .25rem; }
.cal-day {
  display: flex; flex-direction: column; align-items: center; gap: .2rem; min-height: 4.4rem; padding: .35rem .3rem;
  border-radius: 8px; text-decoration: none; color: inherit;
  /* A grid item's default min-width is auto (its content's width), not 0 -
     a long event name in .cal-name would otherwise keep this column wider
     than its 1fr share instead of letting text-overflow ellipsis it,
     pushing the whole calendar past the card's edge. */
  min-width: 0;
}
.cal-day.out-month { color: var(--zfy-muted); opacity: .5; }
.cal-day.has-events { background: var(--zfy-bg); }
.cal-day.has-events:hover { background: var(--zfy-surface-2); }
.cal-day.today .cal-date { background: var(--zfy-accent); color: var(--zfy-on-accent); border-radius: 999px; padding: 0 .4rem; }
.cal-date { font-size: .85rem; font-variant-numeric: tabular-nums; }
.cal-names { display: flex; flex-direction: column; gap: .15rem; width: 100%; }
.cal-name {
  display: block; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: .68rem; line-height: 1.3; padding: .05rem .35rem; border-radius: 4px; text-align: left;
  border-left: 2px solid var(--zfy-muted); background: var(--zfy-surface-2);
}
.cal-name.active { border-left-color: var(--zfy-accent); color: var(--zfy-accent-ink); font-weight: 600; }
.cal-name.planned { border-left-color: var(--zfy-warning-ink, #8a5a1e); }
.cal-name.closed { border-left-color: var(--zfy-line); color: var(--zfy-muted); }
/* Continuation into the next/previous day of the same event: square off
   that side and eat this cell's own padding on it, so the pill touches its
   neighbour instead of reading as a separate box - the coloured accent bar
   only marks the event's actual start, not every day it spans.
   `width: calc()`, not margin, does the extending: .cal-name has a fixed
   width (100%), and a negative margin-RIGHT on a fixed-width block box
   doesn't move its own right edge at all (it only shrinks the gap to
   whatever comes after it) - only margin-left visibly moves anything,
   because it shifts the box's start position. Growing the width is what
   actually pushes an edge outward on either side. */
.cal-name.left { border-left: none; border-top-left-radius: 0; border-bottom-left-radius: 0; margin-left: -.3rem; width: calc(100% + .3rem); padding-left: .1rem; }
.cal-name.right { border-top-right-radius: 0; border-bottom-right-radius: 0; width: calc(100% + .3rem); padding-right: .1rem; }
.cal-name.left.right { width: calc(100% + .6rem); }
.cal-more { font-size: .65rem; color: var(--zfy-muted); text-align: left; padding: 0 .35rem; }
.cfoot { margin-top: auto; padding-top: .5rem; border-top: 1px solid var(--zfy-line); display: flex; gap: 1rem; flex-wrap: wrap; }
.cfoot a { display: inline-flex; align-items: center; gap: .15rem; font-size: .85rem; color: var(--zfy-accent-ink); text-decoration: none; }
.cfoot a:hover { text-decoration: underline; }
</style>
