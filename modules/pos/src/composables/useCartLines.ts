import { computed } from 'vue';
import { round2 } from '@zollify/shared';
import { cart, chargedUnitPrice } from '../cart';

/** The cart's lines with what each is charged, per unit and in all, in the currency the customer pays in. */
export function useCartLines() {
  return computed(() =>
    cart.lines.map((l) => {
      const chargedUnit = chargedUnitPrice(l);
      return { ...l, chargedUnit, chargedTotal: round2(chargedUnit * l.qty) };
    }),
  );
}
