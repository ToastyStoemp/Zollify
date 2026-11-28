import { computed, onUnmounted, ref } from 'vue';
import { seesSalesTotals } from '@zollify/shared';
import { sdk } from '../runtime';

/** Shared till: who is selling, and handing the till on. */
export function useSeller() {
  const sellerAccount = ref(sdk().account());
  const offSeller = sdk().onAccountChange((a) => (sellerAccount.value = a));
  onUnmounted(offSeller);
  const canLock = computed(() => sdk().lock?.available() ?? false);
  /** Staff see the day's takings only when the owner allows it. */
  const showTotals = computed(() => seesSalesTotals(sellerAccount.value));
  const seller = computed(() => (sellerAccount.value?.email ?? '').split('@')[0] ?? '');
  function lockTill(): void {
    void sdk().lock?.lock();
  }
  return { canLock, showTotals, seller, lockTill };
}
