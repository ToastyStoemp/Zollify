import type { Ref } from 'vue';
import type { SalesEvent } from '@zollify/shared';
import type { PrintState } from '../lib/after-sale';
import { loadReceiptConfig, printReceipt, printableReceipt, printingAvailable } from '../receipt';
import { sdk } from '../runtime';
import type { Toast } from './useToast';

export interface ReceiptPrintDeps {
  activeEvent: Readonly<Ref<SalesEvent | null>>;
  toast: Toast;
  /** Told of every change, so a screen showing that sale can follow the print. */
  onState: (saleId: string, state: PrintState) => void;
}

/** Printing a sale's receipt on this device's printer, by hand or straight after the sale. */
export function useReceiptPrint({ activeEvent, toast, onState }: ReceiptPrintDeps) {
  /** Prints the receipt on the paired printer when Settings asks for it; never blocks the till. */
  async function autoPrint(saleId: string): Promise<void> {
    const config = await loadReceiptConfig().catch(() => null);
    if (!config?.autoPrint || !(await printingAvailable().catch(() => false))) return;
    await printSale(saleId);
  }

  /** Print state per sale, so the thank-you screen can show an auto-print's progress too. */
  const printing = new Map<string, PrintState>();
  function setPrintState(saleId: string, state: PrintState): void {
    printing.set(saleId, state);
    onState(saleId, state);
  }

  /** Prints one sale's receipt on this device's printer; reports trouble as a toast, never throws. */
  async function printSale(saleId: string): Promise<void> {
    if (printing.get(saleId) === 'printing') return;
    setPrintState(saleId, 'printing');
    try {
      // The row is written by core a tick after the event fires.
      let tx = sdk().data.transactions.get(saleId);
      for (let i = 0; !tx && i < 10; i++) {
        await new Promise((r) => setTimeout(r, 100));
        tx = sdk().data.transactions.get(saleId);
      }
      if (!tx) throw new Error('sale not recorded yet');
      const result = await printReceipt(await printableReceipt(tx, activeEvent.value?.name ?? '', activeEvent.value?.venue?.country));
      setPrintState(saleId, result.printed ? 'printed' : 'failed');
      if (!result.printed) toast(`Receipt: ${result.error ?? 'print failed'}`, 'bad');
    } catch (err) {
      setPrintState(saleId, 'failed');
      toast(`Receipt: ${err instanceof Error ? err.message : String(err)}`, 'bad');
    }
  }

  /** Where that sale's print stands; 'idle' when none was started. */
  const printState = (saleId: string): PrintState => printing.get(saleId) ?? 'idle';
  return { autoPrint, printSale, printState };
}
