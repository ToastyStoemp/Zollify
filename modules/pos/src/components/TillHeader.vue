<script setup lang="ts">
import { computed } from 'vue';
import type { SalesEvent } from '@zollify/shared';
import { baseValueOf, fmtPrice } from '@zollify/shared';
import { Icon } from '@zollify/ui';
import { cart, sandboxAccount, shellTestMode, testMode } from '../cart';
import type { BrowseMode, ViewMode } from '../composables/useCatalogBrowse';
import { sdk } from '../runtime';

/**
 * The bar across the top of the till: where it is selling and what today came
 * to, the test-mode flag, who is selling, the terminal's state, the browse
 * modes and the search box. It shows and reports taps; the till acts on them.
 */
const props = defineProps<{
  event: SalesEvent | null;
  /** Staff see the day's takings only when the owner allows it. */
  showTotals: boolean;
  atStore: boolean;
  sellsStores: boolean;
  /** The till can be locked and handed on: show who is selling. */
  canLock: boolean;
  seller: string;
  hasTerminal: boolean;
  terminalLabel: string;
  /** null = still checking. */
  terminalConnected: boolean | null;
  viewModes: BrowseMode[];
  viewMode: ViewMode;
  currentMode: BrowseMode;
}>();
const emit = defineEmits<{ lock: []; checkTerminal: []; setMode: [mode: ViewMode]; submit: []; scan: [] }>();
/** What is typed or scanned into the search box. */
const search = defineModel<string>('search', { required: true });

// ── Today ───────────────────────────────────────────────────────────────────
const today = computed(() => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  let count = 0;
  let revenue = 0;
  // In test mode the till sells into the test event: today is its test sales.
  const sales = testMode.value && shellTestMode() ? shellTestMode()!.sales() : sdk().data.transactions.recent();
  for (const tx of sales) {
    if (tx.revertedAt || tx.timestamp < start.getTime() || (props.event && tx.eventId !== props.event.id)) continue;
    count++;
    revenue += baseValueOf(tx, tx.baseCurrency ?? tx.currency);
  }
  return { count, revenue };
});
</script>

<template>
  <header class="bar">
    <router-link :to="{ name: 'events' }" class="quiet iconbtn" aria-label="Events"><Icon name="arrow-left" :size="16" /></router-link>
    <div class="event">
      <h1 v-if="event">{{ event.name }}</h1>
      <h1 v-else class="warn">No active event</h1>
      <small v-if="event && showTotals">Today {{ today.count }} sale{{ today.count === 1 ? '' : 's' }} · {{ fmtPrice(today.revenue, cart.baseCurrency) }}</small>
      <small v-else-if="event">{{ atStore ? 'Selling at the store' : 'Selling at this event' }}{{ today.count ? ` · ${today.count} sale${today.count === 1 ? '' : 's'} today` : '' }}</small>
      <small v-else>Open one under {{ sellsStores ? 'Stores or Events' : 'Events' }} - every sale is filed against one.</small>
    </div>
    <router-link v-if="!testMode && sandboxAccount()" :to="{ name: 'settings', query: { panel: 'core.security' } }" class="testmode" title="A test account: cards go to the pretend terminal and nothing here is real money.">TEST ACCOUNT</router-link>
    <router-link v-if="testMode" :to="{ name: 'settings', query: { panel: 'pos.payments' } }" class="testmode" :title="shellTestMode() ? 'Test mode - sales go to the test event, never to your takings. Tap to switch it off.' : 'Test mode - sales are not recorded. Tap to switch it off under Card terminal.'">{{ shellTestMode() ? 'TEST MODE - test event' : 'TEST MODE - nothing is recorded' }}</router-link>
    <router-link v-if="event" :to="{ name: 'history', query: { event: event.id, from: 'pos' } }" class="quiet iconbtn" aria-label="Sales history"><Icon name="bar-chart" :size="16" /></router-link>
    <button v-if="canLock" type="button" class="quiet seller" :title="`Selling as ${seller} - tap to lock the till`" :aria-label="`Lock the till (selling as ${seller})`" @click="emit('lock')"><Icon name="lock" :size="16" /><span class="lock-label">Lock</span><span class="seller-name">{{ seller }}</span></button>
    <button v-if="hasTerminal" type="button" class="quiet terminal" :title="`${terminalLabel} - tap to re-check`" @click="emit('checkTerminal')">
      <Icon name="credit-card" :size="16" /><span :class="['dot', terminalConnected === true ? 'on' : terminalConnected === false ? 'off' : 'checking']"></span>
    </button>
    <!-- Narrow screens: the browse modes as one icon beside the terminal (the pills below are hidden there). A native
         select under the icon, so the device's own picker opens on tap. -->
    <label class="quiet iconbtn mode-pick" :title="`Showing: ${currentMode.label}`">
      <Icon :name="currentMode.icon" :size="16" />
      <select :value="viewMode" :aria-label="`Browse by (showing ${currentMode.label})`" @change="emit('setMode', ($event.target as HTMLSelectElement).value as ViewMode)">
        <option v-for="m in viewModes" :key="m.id" :value="m.id">{{ m.label }}</option>
      </select>
    </label>
    <div class="search-group">
      <input v-model="search" class="search" type="search" placeholder="Search / scan…" aria-label="Search or scan" @keydown.enter.prevent="emit('submit')" />
      <button type="button" class="quiet iconbtn" aria-label="Scan barcode" title="Scan barcode" @click="emit('scan')"><Icon name="scan" :size="16" /></button>
    </div>
    <div class="modes">
      <button v-for="m in viewModes" :key="m.id" type="button" :class="['pill', { active: viewMode === m.id }]" @click="emit('setMode', m.id)">{{ m.label }}</button>
    </div>
  </header>
</template>

<style scoped>
.testmode { font-size: .72rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #fff; background: var(--zfy-danger, #c6512f); border-radius: 999px; padding: .25rem .7rem; text-decoration: none; white-space: nowrap; }
.bar { display: flex; align-items: center; gap: .75rem; padding: .75rem 1rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); background: var(--zfy-surface, #fff); position: sticky; top: 0; z-index: 2; flex-wrap: wrap; }
.event { min-width: 0; display: flex; flex-direction: column; }
.iconbtn { display: inline-flex; align-items: center; min-height: 2rem; padding: .3rem; color: var(--zfy-muted, #5a6472); border-radius: 8px; }
.iconbtn:hover { background: var(--zfy-bg, #f1f4f6); color: var(--zfy-ink, #1a2230); }
.terminal { display: inline-flex; align-items: center; gap: .3rem; min-height: 2rem; padding: .3rem .5rem; }
.dot { width: .5rem; height: .5rem; border-radius: 50%; background: var(--zfy-muted, #5a6472); }
.dot.on { background: var(--zfy-accent, #0e7c66); }
.dot.off { background: var(--zfy-danger, #c6512f); }
.dot.checking { animation: pulse 1.4s ease-in-out infinite; }
.event h1 { margin: 0; font-size: 1rem; color: var(--zfy-accent-ink, #0a5a4a); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.event h1.warn { color: var(--zfy-warning-ink, #8a5a1e); }
.event small { color: var(--zfy-muted, #5a6472); font-size: .72rem; }
.seller { display: inline-flex; align-items: center; gap: .3rem; min-height: 2.2rem; padding: .1rem .55rem; font-size: .8rem; font-weight: 600; max-width: 9rem; }
.seller .lock-label { font-weight: 700; }
.seller span.seller-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: capitalize; }
.search-group { display: flex; align-items: center; gap: .2rem; margin-left: auto; max-width: 100%; }
.search { width: 14rem; max-width: 100%; }
.modes { display: flex; gap: .3rem; }
.mode-pick { display: none; position: relative; cursor: pointer; }
.mode-pick select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; font-size: 1rem; }
.pill { min-height: 2rem; padding: .2rem .8rem; border-radius: 999px; font-size: .8rem; }
.pill.active { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); border-color: var(--zfy-accent, #0e7c66); }
@keyframes pulse { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .dot.checking { animation: none; } }

@media (max-width: 860px) {
  /* Narrow: the lock icon alone; the seller stays in the title and label. */
  .seller .lock-label, .seller .seller-name { display: none; }
  .search-group { margin-left: 0; width: 100%; order: 3; }
  /* Pills fold into one icon beside the terminal state: a row less above the products. */
  .modes { display: none; }
  .mode-pick { display: inline-flex; }
  .bar { padding: .5rem .75rem; gap: .5rem; }
  .search { flex: 1; }
}
</style>
