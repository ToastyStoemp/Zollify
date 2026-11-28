<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { SaleEvent } from '@zollify/sdk';
import { Icon, ModalShell } from '@zollify/ui';
import { itemCount, loadTestMode, total } from '../cart';
import AfterSaleOverlay from '../components/AfterSaleOverlay.vue';
import CartPanel from '../components/CartPanel.vue';
import CatalogGrid from '../components/CatalogGrid.vue';
import DiscountModal from '../components/DiscountModal.vue';
import MiscItemModal from '../components/MiscItemModal.vue';
import PaymentModal from '../components/PaymentModal.vue';
import ScannerModal from '../components/ScannerModal.vue';
import TillBanners from '../components/TillBanners.vue';
import TillHeader from '../components/TillHeader.vue';
import TypeDrillModal from '../components/TypeDrillModal.vue';
import VariantPickerModal from '../components/VariantPickerModal.vue';
import { useAddToCart } from '../composables/useAddToCart';
import { useAfterSale } from '../composables/useAfterSale';
import { useBarcodeScanner } from '../composables/useBarcodeScanner';
import { useCatalogBrowse } from '../composables/useCatalogBrowse';
import { useCustomerDisplay } from '../composables/useCustomerDisplay';
import { useFollowTillEvent } from '../composables/useFollowTillEvent';
import { useLastSale } from '../composables/useLastSale';
import { usePaymentFlow } from '../composables/usePaymentFlow';
import { useReceiptPrint } from '../composables/useReceiptPrint';
import { useScanSubmit } from '../composables/useScanSubmit';
import { useSeller } from '../composables/useSeller';
import { useStock } from '../composables/useStock';
import { useTerminal } from '../composables/useTerminal';
import { useTillActions } from '../composables/useTillActions';
import { useTillEvent } from '../composables/useTillEvent';
import { useTillMoney } from '../composables/useTillMoney';
import { useToast } from '../composables/useToast';
import { receiptUrl as receiptUrlFor } from '../lib/after-sale';
import { backfillBranding } from '../lib/branding';
import { provideTillTiles } from '../lib/till-tiles';
import { defaultProviderId } from '../payments/registry';
import { sdk } from '../runtime';

/**
 * The till - ZollTool's POS, screen for screen.
 *
 * Products are browsed by type (one card per type, tap to drill in) or as a
 * flat grid; a search box takes a scanner. Every payment is confirmed on
 * screen: cash counts what was handed over and shows the change, card asks
 * for confirmation (or drives the terminal), split takes both. The last sale
 * can be undone from the counter.
 *
 * This file is what the till is made of, top to bottom: each part's state and
 * rules live in a composable (../composables), each part of the screen in a
 * component (../components). What is left here is how they meet - above all
 * finish(), what happens the moment a sale is paid.
 */

const search = ref('');
const { notice, toast } = useToast();

const { activeEvent, tillCheck, sellLock, sellBlocked, lockedBy, takerToSell, sellAtTaker, forceSell, sellAtToday } = useTillEvent(toast);
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

const { currency, money, price, fromPrice } = useTillMoney();

const { stockLabel, productInCart, productLeft } = useStock(activeEvent);

const { atStore, sellsStores, viewMode, viewModes, currentMode, setViewMode, openArtist, openArtistName, grouped, entries, openType, typeProducts } = useCatalogBrowse({ search, products, activeEvent, productLeft, productInCart });

// ── Shared till: who is selling, and handing the till on ──────────────────
const { canLock, showTotals, seller, lockTill } = useSeller();

// ── Adding ──────────────────────────────────────────────────────────────────
const { variantPicker, add, bundleQtys, addBundle } = useAddToCart(products);
provideTillTiles({ stockLabel, productInCart, productLeft, bundleQtys, price, fromPrice });
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

// ── Last sale: undo or reprint without leaving the counter ─────────────────
const { lastSale, showLastSale, undoLast, receipt } = useLastSale(toast);

// ── Payment ─────────────────────────────────────────────────────────────────
const pay = usePaymentFlow({ toast, activeEvent, sellBlocked, lockedBy, provider, providerId, hasTerminal, refreshTerminalStatus, onPaid: finish });
const { payment, givesAway, startPayment } = pay;
/** The flow as the payment sheet reads it: refs unwrapped. */
const paySheet = reactive(pay);
const { followTillEvent } = useFollowTillEvent(activeEvent, payment, toast);

/** A sale went through: close the sheets, say so, tell the customer display, and offer the receipt. */
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
      <TillHeader
        v-model:search="search"
        :event="activeEvent"
        :show-totals="showTotals"
        :at-store="atStore"
        :sells-stores="sellsStores"
        :can-lock="canLock"
        :seller="seller"
        :has-terminal="hasTerminal"
        :terminal-label="provider.label"
        :terminal-connected="terminalConnected"
        :view-modes="viewModes"
        :view-mode="viewMode"
        :current-mode="currentMode"
        @lock="lockTill"
        @check-terminal="tapTerminalState"
        @set-mode="setViewMode"
        @submit="submitSearch"
        @scan="openScanner"
      />
      <TillBanners
        :event="activeEvent"
        :sell-lock="sellLock"
        :locked-by="lockedBy"
        :taker-to-sell="takerToSell"
        :till-check="tillCheck"
        :notice="notice"
        :last-sale="lastSale"
        @sell-at-taker="sellAtTaker"
        @force-sell="forceSell"
        @sell-at-today="sellAtToday"
        @receipt="receipt"
        @undo="undoLast"
        @dismiss-last-sale="lastSale = null"
      />
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

    <ScannerModal v-if="scannerOpen" :error="scannerError" :info="scannerInfo" :can-switch="cameraDevices.length > 1" :set-video="setScannerVideo" @switch="cycleCamera" @close="closeScanner" />

    <!-- ── A screen another module put on the till ───────────────────────── -->
    <ModalShell v-if="openAction" :title="openAction.action.label" @close="openAction = null">
      <component :is="openAction.view" :focus="openAction.focus ?? undefined" @close="openAction = null" />
    </ModalShell>

    <MiscItemModal v-if="showMisc" @notify="toast" @close="showMisc = false" />
    <DiscountModal v-if="showDiscount" @notify="toast" @close="showDiscount = false" />

    <PaymentModal v-if="payment.phase !== 'idle'" :flow="paySheet" :provider="provider" :has-terminal="hasTerminal" />

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
/* Only the till's frame is styled here: the two columns, the floor, and the cart bar.
   Everything else is styled in the component that draws it. */
.pos { display: grid; grid-template-columns: 1fr 20rem; gap: 0; min-height: calc(100dvh - 3rem); margin: -1.5rem; }
.floor { display: flex; flex-direction: column; min-width: 0; }
.cartbar { display: none; }

@media (max-width: 860px) {
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
     all real content.
     NOTE for whoever merges the :has() -> class change from the other
     branch: the two :has(.cartbar) rules below are the only ones, and
     .cartbar is still rendered by this file (not by a child component). */
  .pos:not(:has(.cartbar)) { min-height: auto; }
  .floor { display: flex; flex-direction: column; }
  /* Same gating as .pos above and for the same reason - only .floor:has(.cartbar) needs the forced height. */
  .floor:has(.cartbar) { min-height: calc(100dvh - 3.1rem - var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) - var(--zfy-bottom-nav, 0px)); }
  /* Sticks just above the shell's tab bar, whose height the shell publishes. */
  .cartbar { display: flex; justify-content: space-between; margin: auto 1rem .75rem; min-height: 3rem; font-size: 1rem; position: sticky; bottom: calc(var(--zfy-bottom-nav, 0px) + .5rem); z-index: 3; box-shadow: 0 8px 24px -10px var(--zfy-shadow, rgba(20,26,34,.4)); }
  .cartbar span { display: inline-flex; align-items: center; gap: .4rem; }
}
</style>
