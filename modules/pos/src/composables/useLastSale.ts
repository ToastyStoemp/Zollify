import { ref } from 'vue';
import { useRouter } from 'vue-router';
import type { SaleEvent } from '@zollify/sdk';
import { sdk } from '../runtime';
import type { Toast } from './useToast';

/** Last sale: undo or reprint without leaving the counter. */
export function useLastSale(toast: Toast) {
  const router = useRouter();
  const lastSale = ref<{ id: string; total: number; currency: string; units: number } | null>(null);
  let lastSaleTimer: ReturnType<typeof setTimeout> | undefined;
  function showLastSale(sale: SaleEvent): void {
    // The transaction row lands a tick later; the sale itself has all the bar needs.
    lastSale.value = { id: sale.saleId, total: sale.total, currency: sale.currency, units: sale.lines.reduce((s, l) => s + l.qty, 0) };
    // The bar answers "did that go through?"; after that it is in the way of
    // the next customer. Undo and the receipt stay reachable from History.
    clearTimeout(lastSaleTimer);
    lastSaleTimer = setTimeout(() => { lastSale.value = null; }, 8000);
  }
  async function undoLast(): Promise<void> {
    if (!lastSale.value) return;
    await sdk().data.transactions.revert(lastSale.value.id);
    lastSale.value = null;
    toast('Sale reverted - stock restored');
  }
  function receipt(): void {
    if (lastSale.value) void router.push({ name: 'pos:receipt', params: { saleId: lastSale.value.id } });
  }
  return { lastSale, showLastSale, undoLast, receipt };
}
