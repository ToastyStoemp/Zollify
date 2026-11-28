import { watch, type Ref } from 'vue';
import type { SalesEvent } from '@zollify/shared';
import { cart, loadCardFx, setCartEvent } from '../cart';
import { sdk } from '../runtime';
import type { PaymentState } from './usePaymentFlow';
import type { Toast } from './useToast';

/** Keeps the cart on the event the till sells at, without pulling it from under a payment. */
export function useFollowTillEvent(activeEvent: Readonly<Ref<SalesEvent | null>>, payment: PaymentState, toast: Toast) {
  /**
   * The cart follows the till's event. A payment already under way finishes on
   * the event it was rung up at; the switch lands as soon as it is done.
   */
  let eventPending = false;
  function followTillEvent(): void {
    if (payment.phase !== 'idle' || cart.busy) {
      eventPending = true;
      return;
    }
    eventPending = false;
    setCartEvent(activeEvent.value, sdk().account()?.profile.defaultCurrency ?? 'CHF');
    void loadCardFx();
  }
  watch(activeEvent, (next, prev) => {
    if (next === prev) return;
    const moved = (next?.id ?? null) !== cart.eventId;
    followTillEvent();
    if (moved && !eventPending && next && cart.lines.length) toast(`Now selling at ${next.name} - the cart is priced for it.`);
  });
  watch(() => payment.phase === 'idle' && !cart.busy, (free) => {
    if (free && eventPending) followTillEvent();
  });
  return { followTillEvent };
}
