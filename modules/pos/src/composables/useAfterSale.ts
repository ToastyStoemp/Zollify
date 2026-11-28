import { onUnmounted, ref, watch } from 'vue';
import { fmtPrice } from '@zollify/shared';
import type { SaleEvent } from '@zollify/sdk';
import { cart } from '../cart';
import { afterSalePrefs, type PrintState } from '../lib/after-sale';
import { screenLogo } from '../lib/branding';
import { printingAvailable } from '../receipt';

export interface AfterSaleDeps {
  printSale: (saleId: string) => Promise<void>;
  printState: (saleId: string) => PrintState;
}

// ── After the sale: thank-you and receipt QR on this screen ─────────────────
// Device-local choices (Settings → This device), independent of what any
// customer display on the account shows.
export function useAfterSale({ printSale, printState }: AfterSaleDeps) {
  const afterSale = ref<{
    saleId: string;
    thankYou: boolean;
    total: string;
    receiptUrl?: string;
    logo?: string;
    /** This device has a printer: the Carbon's built-in one, or a paired Bluetooth printer. */
    canPrint: boolean;
    print: PrintState;
  } | null>(null);
  let afterSaleTimer: ReturnType<typeof setTimeout> | undefined;
  function holdAfterSale(ms: number): void {
    clearTimeout(afterSaleTimer);
    afterSaleTimer = setTimeout(dismissAfterSale, ms);
  }
  /**
   * The logo as last seen, so the next thank-you screen has it at once. The
   * screen never waits for it: everything else it shows is on the device (the
   * receipt link is made here, before any sync), and a logo that arrives late
   * just appears.
   */
  let knownLogo: string | undefined;
  function refreshLogo(): Promise<string | undefined> {
    return screenLogo()
      .catch(() => undefined)
      .then((l) => (knownLogo = l ?? knownLogo));
  }
  async function showAfterSale(sale: SaleEvent, receiptUrl: string | undefined): Promise<void> {
    const [prefs, canPrint] = await Promise.all([afterSalePrefs(), printingAvailable().catch(() => false)]);
    const url = prefs.receiptQr ? receiptUrl : undefined;
    if (!prefs.thankYou && !url) return;
    // An auto-print may already be under way by the time this resolves.
    const print = printState(sale.saleId);
    afterSale.value = { saleId: sale.saleId, thankYou: prefs.thankYou, total: fmtPrice(sale.total, sale.currency), receiptUrl: url, logo: knownLogo, canPrint, print };
    if (!knownLogo) {
      void refreshLogo().then((l) => {
        if (l && afterSale.value?.saleId === sale.saleId) afterSale.value.logo = l;
      });
    }
    // Offering to print means waiting for an answer, same as a QR to scan.
    holdAfterSale(url || canPrint ? 30_000 : 4000);
  }
  async function printFromAfterSale(): Promise<void> {
    const shown = afterSale.value;
    if (!shown || shown.print === 'printing') return;
    // Don't vanish mid-print, and leave a moment to tear the paper off.
    holdAfterSale(30_000);
    await printSale(shown.saleId);
  }
  function dismissAfterSale(): void {
    clearTimeout(afterSaleTimer);
    afterSale.value = null;
  }
  // The next customer's first item is as good as a tap on "Next sale".
  watch(() => cart.lines.length, (n) => { if (n > 0) dismissAfterSale(); });
  onUnmounted(() => clearTimeout(afterSaleTimer));

  /** A print of the sale on screen moved on (an auto-print too): show it there. */
  function notePrintState(saleId: string, state: PrintState): void {
    if (afterSale.value?.saleId === saleId) afterSale.value.print = state;
  }
  return { afterSale, refreshLogo, showAfterSale, printFromAfterSale, dismissAfterSale, notePrintState };
}
