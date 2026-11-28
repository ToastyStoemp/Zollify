<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, reactive, ref, shallowRef, watch, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Product } from '@zollify/shared';
import { baseValueOf, cashShortcutAmounts, fmtPrice, round2, splitCashPortionAmounts } from '@zollify/shared';
import type { SaleEvent, TillAction } from '@zollify/sdk';
import { Icon, ModalShell } from '@zollify/ui';
import {
  addMisc,
  addModuleLine,
  findModuleLine,
  replaceModuleLine,
  appliedDiscounts,
  chargeTotals,
  chargedUnitPrice,
  customDiscountCharged,
  localPrice,
  baseTotal,
  cardFx,
  cardInBase,
  cardSettlement,
  cart,
  cancelCheckout,
  checkout,
  clear,
  inCart,
  isConverting,
  itemCount,
  loadCardFx,
  loadMarketFx,
  marketFx,
  setCartEvent,
  setCustomDiscount,
  setQty,
  subtotal,
  toCharged,
  total,
  GIVEN_AWAY,
  loadTestMode,
  sandboxAccount,
  shellTestMode,
  testMode,
} from '../cart';
import { GIVEN_AWAY_LABEL } from '../lib/given-away';
import { defaultProviderId } from '../payments/registry';
import { typeColor, visibleTileActions } from '../search';
import { loadReceiptConfig, printReceipt, printableReceipt, printingAvailable, vatRateLabel } from '../receipt';
import { allocateDiscounts } from '../discounts';
import { backfillBranding, screenLogo } from '../lib/branding';
import { tillLinkFrom } from '../lib/till-link';
import { provideTillTiles } from '../lib/till-tiles';
import { dismissLateApproval, lateApprovalText, lateApprovals } from '../lib/late-approvals';
import { singleFlight } from '../lib/single-flight';
import { sdk } from '../runtime';
import { afterSalePrefs, receiptUrl as receiptUrlFor, saleTaxFor, type PrintState } from '../lib/after-sale';
import AfterSaleOverlay from '../components/AfterSaleOverlay.vue';
import CartPanel from '../components/CartPanel.vue';
import CatalogGrid from '../components/CatalogGrid.vue';
import DiscountModal from '../components/DiscountModal.vue';
import MiscItemModal from '../components/MiscItemModal.vue';
import TypeDrillModal from '../components/TypeDrillModal.vue';
import VariantPickerModal from '../components/VariantPickerModal.vue';
import { useBarcodeScanner } from '../composables/useBarcodeScanner';
import { useCartLines } from '../composables/useCartLines';
import { useCatalogBrowse, type ViewMode } from '../composables/useCatalogBrowse';
import ScannerModal from '../components/ScannerModal.vue';
import { useAfterSale } from '../composables/useAfterSale';
import { useAddToCart } from '../composables/useAddToCart';
import { useCustomerDisplay } from '../composables/useCustomerDisplay';
import { useFollowTillEvent } from '../composables/useFollowTillEvent';
import { useLastSale } from '../composables/useLastSale';
import { useReceiptPrint } from '../composables/useReceiptPrint';
import { usePaymentFlow } from '../composables/usePaymentFlow';
import { useScanSubmit } from '../composables/useScanSubmit';
import { useSeller } from '../composables/useSeller';
import { useStock } from '../composables/useStock';
import { useTillActions } from '../composables/useTillActions';
import { useTerminal } from '../composables/useTerminal';
import { useTillEvent } from '../composables/useTillEvent';
import { useTillMoney } from '../composables/useTillMoney';
import { useToast } from '../composables/useToast';

/**
 * The till - ZollTool's POS, screen for screen.
 *
 * Products are browsed by type (one card per type, tap to drill in) or as a
 * flat grid; a search box takes a scanner. Every payment is confirmed on
 * screen: cash counts what was handed over and shows the change, card asks
 * for confirmation (or drives the terminal), split takes both. The last sale
 * can be undone from the counter.
 */

const router = useRouter();
const search = ref('');
const { notice, toast } = useToast();

const { activeEvent, tillCheck, sellLock, sellBlocked, lockedBy, takerToSell, sellAtTaker, forceSell, sellAtToday } = useTillEvent(toast);
const fmtDay = (iso: string | null): string => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const products = computed(() => sdk().data.products.forSale());
const { providerId, provider, hasTerminal, terminalConnected, refreshTerminalStatus, tapTerminalState, startStatusPolling } = useTerminal(toast);
const customMethods = ref<string[]>([]);

onMounted(async () => {
  // Ready before the first sale, so its thank-you screen has the logo at once.
  void refreshLogo();
  void backfillBranding();
  providerId.value = (await sdk().config.get<string>('activeProvider')) ?? defaultProviderId();
  void loadTestMode();
  customMethods.value = (await sdk().config.get<string[]>('customMethods')) ?? [];
  cameraDeviceId.value = (await sdk().config.get<string>('cameraDeviceId')) ?? null;
  followTillEvent();
  void refreshTerminalStatus();
  startStatusPolling();
});

const { currency, money, price, fromPrice, onCard, cardRateLabel } = useTillMoney();

const { stockLabel, productInCart, productLeft } = useStock(activeEvent);

const { atStore, sellsStores, viewMode, viewModes, currentMode, setViewMode, openArtist, openArtistName, grouped, entries, openType, typeProducts } = useCatalogBrowse({ search, products, activeEvent, productLeft, productInCart });

// ── Shared till: who is selling, and handing the till on ──────────────────
const { canLock, showTotals, seller, lockTill } = useSeller();

// ── Adding ──────────────────────────────────────────────────────────────────
const { variantPicker, add, bundleQtys, addBundle } = useAddToCart(products);
provideTillTiles({ stockLabel, productInCart, productLeft, bundleQtys });
const { justAddedId, submitSearch } = useScanSubmit({ search, products, toast, add, canLock, seller });

// ── Barcode scanner (camera) ─────────────────────────────────────────────────
const { scannerOpen, scannerError, scannerInfo, setScannerVideo, cameraDeviceId, cameraDevices, openScanner, closeScanner, cycleCamera } = useBarcodeScanner({ search, submitSearch, toast });

// ── Cart, and the sheets its buttons open ──────────────────────────────────
const showCartSheet = ref(false);
const showDiscount = ref(false);
const showMisc = ref(false);

// ── What other modules add to the till (a workshop place, say) ─────────────
const { tillButtons, tillTiles, openAction, runAction } = useTillActions({ search, viewMode, openArtist, activeEvent, currency, toast });

// ── Customer display: mirror the cart on the account's other screens ───────
const display = useCustomerDisplay(activeEvent);

// ── Today ───────────────────────────────────────────────────────────────────
const today = computed(() => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  let count = 0;
  let revenue = 0;
  // In test mode the till sells into the test event: today is its test sales.
  const sales = testMode.value && shellTestMode() ? shellTestMode()!.sales() : sdk().data.transactions.recent();
  for (const tx of sales) {
    if (tx.revertedAt || tx.timestamp < start.getTime() || (activeEvent.value && tx.eventId !== activeEvent.value.id)) continue;
    count++;
    revenue += baseValueOf(tx, tx.baseCurrency ?? tx.currency);
  }
  return { count, revenue };
});

// ── Last sale: undo or reprint without leaving the counter ─────────────────
const { lastSale, showLastSale, undoLast, receipt } = useLastSale(toast);

// ── Payment ─────────────────────────────────────────────────────────────────
const pay = usePaymentFlow({ toast, activeEvent, sellBlocked, lockedBy, provider, providerId, hasTerminal, refreshTerminalStatus, onPaid: finish });
const { payment, cashShortcuts, splitCashShortcuts, change, splitState, confirmDisabled, title, givesAway, sendingLog, logSent, startPayment, connectReader, sendLog, retryCard, completeByHand, confirmPayment, cancelPayment } = pay;
const { followTillEvent } = useFollowTillEvent(activeEvent, payment, toast);


function finish(sale: SaleEvent, message: string, test = false): void {
  payment.phase = 'idle';
  showCartSheet.value = false;
  if (test) {
    // Nothing was recorded: no sale bar, no receipt link (the sale is not on the server), no paper.
    toast(`${message} - TEST, not recorded`);
    display.showPaid({ total: sale.total }, 6000);
    void showAfterSale(sale, undefined);
    return;
  }
  showLastSale(sale);
  toast(message);
  display.cancelPending();
  // Every display gets the link; each decides from its own settings whether
  // to show it. It only travels the account's own live channel.
  const receiptUrl = receiptUrlFor(sale.receiptToken);
  // Hold the paid state long enough for a customer to scan the code.
  display.showPaid({ total: sale.total, receiptUrl }, receiptUrl ? 30_000 : 6000);
  void showAfterSale(sale, receiptUrl);
  void autoPrint(sale.saleId);
}

// ── After the sale: thank-you and receipt QR on this screen, and the receipt on paper ──
const { autoPrint, printSale, printState } = useReceiptPrint({ activeEvent, toast, onState: (saleId, state) => notePrintState(saleId, state) });
const { afterSale, refreshLogo, showAfterSale, printFromAfterSale, dismissAfterSale, notePrintState } = useAfterSale({ printSale, printState });
</script>

<template>
  <div class="pos">
    <section class="floor">
      <header class="bar">
        <router-link :to="{ name: 'events' }" class="quiet iconbtn" aria-label="Events"><Icon name="arrow-left" :size="16" /></router-link>
        <div class="event">
          <h1 v-if="activeEvent">{{ activeEvent.name }}</h1>
          <h1 v-else class="warn">No active event</h1>
          <small v-if="activeEvent && showTotals">Today {{ today.count }} sale{{ today.count === 1 ? '' : 's' }} · {{ fmtPrice(today.revenue, cart.baseCurrency) }}</small>
          <small v-else-if="activeEvent">{{ atStore ? 'Selling at the store' : 'Selling at this event' }}{{ today.count ? ` · ${today.count} sale${today.count === 1 ? '' : 's'} today` : '' }}</small>
          <small v-else>Open one under {{ sellsStores ? 'Stores or Events' : 'Events' }} - every sale is filed against one.</small>
        </div>
        <router-link v-if="!testMode && sandboxAccount()" :to="{ name: 'settings', query: { panel: 'core.security' } }" class="testmode" title="A test account: cards go to the pretend terminal and nothing here is real money.">TEST ACCOUNT</router-link>
        <router-link v-if="testMode" :to="{ name: 'settings', query: { panel: 'pos.payments' } }" class="testmode" :title="shellTestMode() ? 'Test mode - sales go to the test event, never to your takings. Tap to switch it off.' : 'Test mode - sales are not recorded. Tap to switch it off under Card terminal.'">{{ shellTestMode() ? 'TEST MODE - test event' : 'TEST MODE - nothing is recorded' }}</router-link>
        <router-link v-if="activeEvent" :to="{ name: 'history', query: { event: activeEvent.id, from: 'pos' } }" class="quiet iconbtn" aria-label="Sales history"><Icon name="bar-chart" :size="16" /></router-link>
        <button v-if="canLock" type="button" class="quiet seller" :title="`Selling as ${seller} - tap to lock the till`" :aria-label="`Lock the till (selling as ${seller})`" @click="lockTill"><Icon name="lock" :size="16" /><span class="lock-label">Lock</span><span class="seller-name">{{ seller }}</span></button>
        <button v-if="hasTerminal" type="button" class="quiet terminal" :title="`${provider.label} - tap to re-check`" @click="tapTerminalState">
          <Icon name="credit-card" :size="16" /><span :class="['dot', terminalConnected === true ? 'on' : terminalConnected === false ? 'off' : 'checking']"></span>
        </button>
        <!-- Narrow screens: the browse modes as one icon beside the terminal (the pills below are hidden there). A native
             select under the icon, so the device's own picker opens on tap. -->
        <label class="quiet iconbtn mode-pick" :title="`Showing: ${currentMode.label}`">
          <Icon :name="currentMode.icon" :size="16" />
          <select :value="viewMode" :aria-label="`Browse by (showing ${currentMode.label})`" @change="setViewMode(($event.target as HTMLSelectElement).value as ViewMode)">
            <option v-for="m in viewModes" :key="m.id" :value="m.id">{{ m.label }}</option>
          </select>
        </label>
        <div class="search-group">
          <input v-model="search" class="search" type="search" placeholder="Search / scan…" aria-label="Search or scan" @keydown.enter.prevent="submitSearch" />
          <button type="button" class="quiet iconbtn" aria-label="Scan barcode" title="Scan barcode" @click="openScanner"><Icon name="scan" :size="16" /></button>
        </div>
        <div class="modes">
          <button v-for="m in viewModes" :key="m.id" type="button" :class="['pill', { active: viewMode === m.id }]" @click="setViewMode(m.id)">{{ m.label }}</button>
        </div>
      </header>

      <div v-if="sellLock && !sellLock.forced" class="stale locked" role="alert">
        <Icon name="lock" :size="16" />
        <span><strong>Sell 🔒 {{ activeEvent?.name }}.</strong> {{ lockedBy }} took over what was left here, so sales here would come out of its stock.</span>
        <button v-if="takerToSell" type="button" class="primary" @click="sellAtTaker">Sell at {{ takerToSell.name }}</button>
        <span v-else-if="sellLock.by.length === 1" class="hint">Ask an admin for access to {{ sellLock.by[0]!.name }}.</span>
        <button v-if="sellLock.canForce" type="button" class="danger" @click="forceSell(true)">Force sales</button>
      </div>
      <div v-else-if="sellLock?.forced" class="stale" role="status">
        <Icon name="alert-triangle" :size="16" />
        <span><strong>Sell 🔒 forced open.</strong> {{ lockedBy }} took this event's leftovers; what you sell here may come out of its stock.</span>
        <button type="button" @click="forceSell(false)">Lock again</button>
      </div>
      <div v-else-if="tillCheck.ended" class="stale" role="alert">
        <Icon name="alert-triangle" :size="16" />
        <span><strong>{{ activeEvent?.name }} {{ activeEvent?.status === 'closed' ? 'is closed' : `ended ${fmtDay(tillCheck.endedOn)}` }}.</strong> Sales you ring up now still go to it.</span>
        <button v-if="tillCheck.runningToday" type="button" class="primary" @click="sellAtToday">Sell at {{ tillCheck.runningToday.name }}</button>
        <router-link v-else :to="{ name: 'events' }" class="btn">Pick an event</router-link>
      </div>

      <div v-for="a in lateApprovals" :key="a.id" class="stale locked" role="alert">
        <Icon name="alert-triangle" :size="16" />
        <span><strong>{{ lateApprovalText(a) }}</strong></span>
        <button type="button" class="danger" @click="dismissLateApproval(a.id)">Dealt with</button>
      </div>
      <p v-if="notice" :class="['notice', notice.kind]" role="status">{{ notice.text }}</p>

      <div v-if="lastSale" class="last">
        <Icon name="check" :size="16" />
        <span>{{ fmtPrice(lastSale.total, lastSale.currency) }} · {{ lastSale.units }} item{{ lastSale.units === 1 ? '' : 's' }}</span>
        <span class="spacer"></span>
        <button type="button" class="quiet" @click="receipt"><Icon name="printer" :size="14" /> Receipt</button>
        <button type="button" class="quiet undo" @click="undoLast"><Icon name="undo" :size="14" /> Undo</button>
        <button type="button" class="quiet" aria-label="Dismiss" @click="lastSale = null"><Icon name="x" :size="14" /></button>
      </div>

      <CatalogGrid
        :entries="entries"
        :action-tiles="tillTiles"
        :inside-artist="grouped && viewMode === 'artists' && openArtist !== null ? openArtistName : null"
        :search="search"
        :just-added-id="justAddedId"
        @open-artist="openArtist = $event"
        @open-type="openType = $event"
        @add="add($event, null)"
        @bundle="(pid, q) => addBundle(pid, null, q)"
        @action="runAction"
      />

      <button v-if="itemCount" type="button" class="primary cartbar" @click="showCartSheet = true">
        <span><Icon name="shopping-cart" :size="16" /> {{ itemCount }} item{{ itemCount !== 1 ? 's' : '' }}</span>
        <span>{{ money(total) }}</span>
      </button>
    </section>

    <CartPanel
      :sheet="showCartSheet"
      :action-buttons="tillButtons"
      :custom-methods="customMethods"
      :sell-blocked="sellBlocked"
      :gives-away="givesAway"
      @close="showCartSheet = false"
      @discount="showDiscount = true"
      @misc="showMisc = true"
      @action="runAction"
      @pay="startPayment"
    />

    <TypeDrillModal v-if="openType" :type="openType" :products="typeProducts" :just-added-id="justAddedId" @add="add($event, null)" @bundle="(pid, q) => addBundle(pid, null, q)" @close="openType = null" />
    <VariantPickerModal v-if="variantPicker" :product="variantPicker" @add="add(variantPicker!.id, $event)" @bundle="(vid, q) => addBundle(variantPicker!.id, vid, q)" @close="variantPicker = null" />

    <!-- ── Barcode scanner ───────────────────────────────────────────────── -->
    <ScannerModal v-if="scannerOpen" :error="scannerError" :info="scannerInfo" :can-switch="cameraDevices.length > 1" :set-video="setScannerVideo" @switch="cycleCamera" @close="closeScanner" />

    <!-- ── A screen another module put on the till ───────────────────────── -->
    <ModalShell v-if="openAction" :title="openAction.action.label" @close="openAction = null">
      <component :is="openAction.view" :focus="openAction.focus ?? undefined" @close="openAction = null" />
    </ModalShell>

    <MiscItemModal v-if="showMisc" @notify="toast" @close="showMisc = false" />
    <DiscountModal v-if="showDiscount" @notify="toast" @close="showDiscount = false" />

    <!-- ── Payment ───────────────────────────────────────────────────────── -->
    <ModalShell v-if="payment.phase !== 'idle'" :title="title" @close="cancelPayment">
      <div class="paybody">
        <p class="amount">{{ money(payment.total) }}</p>
        <p v-if="cardInBase && payment.method === 'card'" class="oncard">
          <template v-if="onCard(payment.total)"><span>Card: <strong>{{ onCard(payment.total) }}</strong></span><small>{{ cardRateLabel }}</small></template>
          <template v-else>No {{ cart.baseCurrency }}/{{ cart.currency }} rate on this device yet</template>
        </p>

        <template v-if="payment.phase === 'needsLogin'">
          <p class="warn strong">{{ provider.label }} isn't signed in</p>
          <p class="hint">Log in to take this card payment on the reader, or record the card another way.</p>
        </template>

        <template v-else-if="payment.phase === 'terminal'">
          <p class="pulse">Present card to terminal…</p>
          <p class="hint">{{ provider.label }}</p>
        </template>

        <template v-else-if="payment.phase === 'failed'">
          <p class="bad strong">Card payment didn't go through</p>
          <p v-if="payment.error" class="hint">{{ payment.error }}</p>
          <p class="hint">Retry the card, or complete the sale by hand if it was paid another way.</p>
          <button type="button" class="quiet" :disabled="sendingLog" @click="sendLog">{{ sendingLog ? 'Sending…' : logSent ? 'Log sent' : 'Send log to support' }}</button>
        </template>

        <template v-else-if="payment.method === 'cash'">
          <div class="chips">
            <button type="button" class="chip exact" @click="payment.cashReceived = payment.total.toFixed(2)">Exact</button>
            <button v-for="a in cashShortcuts" :key="a" type="button" class="chip" @click="payment.cashReceived = String(a)">{{ a }}</button>
          </div>
          <label class="field"><span>Received</span><input v-model="payment.cashReceived" type="number" inputmode="decimal" class="big" /></label>
          <p>Change: <strong :class="change < -0.001 ? 'bad' : 'good'">{{ change < -0.001 ? '− ' + money(-change) : change < 0.001 ? 'No change' : money(change) }}</strong></p>
        </template>

        <template v-else-if="payment.method === 'split'">
          <div class="two">
            <label class="field"><span>Cash</span><input v-model="payment.splitCash" type="number" inputmode="decimal" /></label>
            <label class="field"><span>Card</span><input v-model="payment.splitCard" type="number" inputmode="decimal" /></label>
          </div>
          <div class="chips">
            <button type="button" class="chip exact" @click="payment.splitCash = Math.max(0, payment.total - (Number(payment.splitCard) || 0)).toFixed(2)">Cash remainder</button>
            <button v-for="a in splitCashShortcuts" :key="a" type="button" class="chip" @click="payment.splitCash = String(a)">{{ a }}</button>
            <button type="button" class="chip cardc" @click="payment.splitCard = Math.max(0, payment.total - (Number(payment.splitCash) || 0)).toFixed(2)">Card remainder</button>
          </div>
          <p>{{ splitState.label }}: <strong :class="splitState.cls">{{ money(splitState.amount) }}</strong></p>
          <p v-if="cart.busy && hasTerminal" class="pulse">Present card to terminal…</p>
          <p v-if="cardInBase && Number(payment.splitCard) > 0 && onCard(Number(payment.splitCard))" class="hint">Charge <strong>{{ onCard(Number(payment.splitCard)) }}</strong> on the card · {{ cardRateLabel }}</p>
        </template>

        <template v-else-if="payment.method === GIVEN_AWAY">
          <p>Nothing to pay - the items leave stock and the sale is kept on record as given away.</p>
        </template>

        <template v-else>
          <p>Confirm the {{ payment.method === 'card' ? 'card' : payment.method }} payment was completed{{ payment.method === 'card' && !hasTerminal ? ' on the terminal' : '' }}.</p>
        </template>
      </div>
      <template #footer>
        <div class="actions">
          <button type="button" @click="cancelPayment">Cancel</button>
          <button v-if="payment.phase === 'confirm'" type="button" :class="['primary', 'confirm', payment.method]" :disabled="confirmDisabled || cart.busy" @click="confirmPayment">{{ payment.method === GIVEN_AWAY ? 'Give away' : 'Confirm sale' }}</button>
          <button v-if="payment.phase === 'failed'" type="button" class="primary" @click="retryCard">Retry card</button>
          <button v-if="payment.phase === 'terminal' || payment.phase === 'failed' || payment.phase === 'needsLogin'" type="button" @click="completeByHand">{{ payment.phase === 'needsLogin' ? 'Enter card by hand' : 'Complete by hand' }}</button>
          <button v-if="payment.phase === 'needsLogin' && provider.configure" type="button" class="primary" @click="connectReader">Log in</button>
        </div>
      </template>
    </ModalShell>

    <AfterSaleOverlay
      v-if="afterSale"
      aria-label="Sale complete"
      :thank-you="afterSale.thankYou"
      :total="afterSale.total"
      :receipt-url="afterSale.receiptUrl"
      :logo="afterSale.logo"
      :can-print="afterSale.canPrint"
      :print="afterSale.print"
      close-label="Next sale"
      @print="printFromAfterSale"
      @close="dismissAfterSale"
    />
  </div>
</template>

<style scoped>
.pos { display: grid; grid-template-columns: 1fr 20rem; gap: 0; min-height: calc(100dvh - 3rem); margin: -1.5rem; }
.floor { display: flex; flex-direction: column; min-width: 0; }
.testmode { font-size: .72rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #fff; background: var(--zfy-danger, #c6512f); border-radius: 999px; padding: .25rem .7rem; text-decoration: none; white-space: nowrap; }
.stale { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin: .6rem 1rem 0; padding: .6rem .8rem; border-radius: 10px; border: 1px solid var(--zfy-warning, #d99a2b); color: var(--zfy-warning-ink, #8a5a00); font-size: .875rem; }
.stale span { flex: 1; min-width: 12rem; }
.stale .btn { text-decoration: none; font-weight: 600; color: inherit; }
.stale.locked { border-color: var(--zfy-danger, #c6512f); color: var(--zfy-danger, #c6512f); }
.stale .danger { color: var(--zfy-danger, #c6512f); border-color: currentColor; }
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
.notice { margin: .5rem 1rem 0; padding: .45rem .75rem; border-radius: 8px; font-size: .85rem; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.notice.bad { background: var(--zfy-signal-soft, #f6e5df); color: var(--zfy-danger, #c6512f); }
.last { display: flex; align-items: center; gap: .5rem; padding: .4rem 1rem; font-size: .85rem; color: var(--zfy-accent-ink, #0a5a4a); background: var(--zfy-accent-soft, #deeee9); border-bottom: 1px solid var(--zfy-line, #d6dde4); }
.last .spacer { flex: 1; }
.last button { min-height: 1.8rem; padding: .1rem .5rem; font-size: .8rem; display: inline-flex; align-items: center; gap: .3rem; }
.last .undo { color: var(--zfy-warning-ink, #8a5a1e); }
.empty, .hint { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1rem; font-size: .9rem; }
.muted { color: var(--zfy-muted, #5a6472); }
.warn { color: var(--zfy-warning-ink, #8a5a1e); }
.bad { color: var(--zfy-danger, #c6512f); }
.good { color: var(--zfy-accent-ink, #0a5a4a); }
.strong { font-weight: 600; }
.cartbar { display: none; }

.confirm { min-height: 2.8rem; font-weight: 700; color: #fff; border: 0; }
.confirm.cash { background: #0e7c66; }
.confirm.card { background: #2f6fb8; }
.confirm.split { background: #b8742f; }
.confirm.free { background: #8a4fb8; }
.confirm:hover:not(:disabled) { filter: brightness(1.08); }

.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.field { display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; text-align: left; }
.field .big { font-size: 1.2rem; }
.actions { display: flex; justify-content: flex-end; gap: .5rem; }
.paybody { display: flex; flex-direction: column; gap: .8rem; text-align: center; }
.paybody p { margin: 0; }
.amount { font-size: 2rem; font-weight: 800; letter-spacing: -.01em; }
.oncard { display: flex; flex-direction: column; margin: -.25rem 0 0; font-size: 1rem; }
.oncard small { color: var(--zfy-muted, #5a6472); font-size: .75rem; }
.pulse { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .pulse, .dot.checking { animation: none; } }
.chips { display: flex; justify-content: center; gap: .4rem; flex-wrap: wrap; }
.chip { min-height: 2.2rem; padding: .2rem .8rem; font-weight: 600; }
.chip.exact { color: var(--zfy-accent-ink, #0a5a4a); border-color: var(--zfy-accent, #0e7c66); background: var(--zfy-accent-soft, #deeee9); }
.chip.cardc { color: #2f6fb8; border-color: #2f6fb8; }

@media (max-width: 860px) {
  /* Narrow: the lock icon alone; the seller stays in the title and label. */
  .seller .lock-label, .seller .seller-name { display: none; }
  /* Cancels .content's own padding (a bleed-to-edges trick, not new) - the
     bottom value now also cancels the --zfy-bottom-nav clearance .content
     added for pages that don't otherwise account for the fixed tab bar.
     POS already handles that clearance itself (.floor / .cartbar below),
     so left as plain -1rem this would double-reserve it - confirmed live,
     a 62px scrollable gap below the tab bar with nothing in it. */
  .pos { grid-template-columns: 1fr; margin: -1rem -1rem calc(-1rem - var(--zfy-bottom-nav, 0px)) -1rem; }
  /* .pos's own base rule (min-height: 100dvh - 3rem) is what was actually
     forcing this, not .floor - .floor is a CSS Grid item and grid items
     default to align-items: stretch, so it stretched to fill .pos's forced
     height regardless of any min-height set on .floor itself. That height
     only ever existed so .cartbar could dock at the screen bottom via
     margin-top: auto even with a short product list - useless overhead
     with an empty cart (.cartbar is v-if="itemCount", so it isn't rendered
     at all then). Confirmed live: with an empty cart this left genuinely
     blank space below a short product list, reachable by scrolling past
     all real content. */
  .pos:not(:has(.cartbar)) { min-height: auto; }
  .floor { display: flex; flex-direction: column; }
  /* Same gating as .pos above and for the same reason - only .floor:has(.cartbar) needs the forced height. */
  .floor:has(.cartbar) { min-height: calc(100dvh - 3.1rem - var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) - var(--zfy-bottom-nav, 0px)); }
  /* Sticks just above the shell's tab bar, whose height the shell publishes. */
  .cartbar { display: flex; justify-content: space-between; margin: auto 1rem .75rem; min-height: 3rem; font-size: 1rem; position: sticky; bottom: calc(var(--zfy-bottom-nav, 0px) + .5rem); z-index: 3; box-shadow: 0 8px 24px -10px var(--zfy-shadow, rgba(20,26,34,.4)); }
  .cartbar span { display: inline-flex; align-items: center; gap: .4rem; }
  .search-group { margin-left: 0; width: 100%; order: 3; }
  /* Pills fold into one icon beside the terminal state: a row less above the products. */
  .modes { display: none; }
  .mode-pick { display: inline-flex; }
  .bar { padding: .5rem .75rem; gap: .5rem; }
  .search { flex: 1; }
}
</style>
