import { onUnmounted, watch, type Ref } from 'vue';
import type { SalesEvent } from '@zollify/shared';
import { appliedDiscounts, cart, customDiscountCharged, total } from '../cart';
import { sdk } from '../runtime';
import { useCartLines } from './useCartLines';
import { useTillMoney } from './useTillMoney';

/** Customer display: mirrors the cart on the account's other screens, and holds the "paid" state after a sale. */
export function useCustomerDisplay(activeEvent: Readonly<Ref<SalesEvent | null>>) {
  const { currency } = useTillMoney();
  const lines = useCartLines();
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  function publish(paid?: { total: number; receiptUrl?: string }): void {
    sdk().display.publish({
      deviceName: '',
      eventName: activeEvent.value?.name ?? '',
      currency: currency.value,
      lines: paid ? [] : lines.value.map((l) => ({ title: l.name, variantLabel: l.variantLabel ?? undefined, qty: l.qty, lineTotal: l.chargedTotal })),
      discounts: paid
        ? []
        : [...appliedDiscounts.value.map((r) => ({ name: r.rule.name, amount: r.amount })), ...(cart.custom && customDiscountCharged.value > 0 ? [{ name: cart.custom.name, amount: customDiscountCharged.value }] : [])],
      total: paid ? paid.total : total.value,
      paid,
      ts: Date.now(),
    });
  }
  watch(
    () => [cart.lines.map((l) => `${l.lineId}:${l.qty}`).join(','), cart.custom?.value, total.value],
    () => {
      clearTimeout(publishTimer);
      publishTimer = setTimeout(() => {
        // Don't clobber the post-sale thank-you with the emptied cart.
        if (Date.now() < thankYouUntil && !cart.lines.length) return;
        publish();
      }, 150);
    },
  );
  // Sends are fire-and-forget; a heartbeat re-publishes so a dropped frame self-heals within one interval.
  let thankYouUntil = 0;
  const heartbeat = setInterval(() => {
    if (Date.now() < thankYouUntil) return;
    publish();
  }, 15_000);
  onUnmounted(() => clearTimeout(publishTimer));
  onUnmounted(() => clearInterval(heartbeat));

  /** Drops a cart update still waiting to go out, so it cannot land after the paid state. */
  function cancelPending(): void {
    clearTimeout(publishTimer);
  }
  /** Shows the sale as paid and keeps it there for `holdMs`, against the cart updates and the heartbeat. */
  function showPaid(paid: { total: number; receiptUrl?: string }, holdMs: number): void {
    thankYouUntil = Date.now() + holdMs;
    publish(paid);
  }
  return { cancelPending, showPaid };
}
