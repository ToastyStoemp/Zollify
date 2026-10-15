import { fmtPrice, round2 } from '@zollify/shared';

/**
 * What to do when the seller taps "Add to the sale" for a commission. Pure, so
 * the rules are tested without a till: the cart holds one line per commission,
 * and a line that is already there is offered for replacement, not refused.
 */

export interface ChargeInput {
  amount: number;
  commissionCurrency: string;
  tillCurrency: string;
  /** The amount of this commission's line already in the cart, when there is one. */
  inCart: number | null;
}

export type ChargeDecision =
  | { kind: 'invalid'; message: string }
  /** The till works in another currency; nothing can be added. */
  | { kind: 'blocked'; message: string }
  | { kind: 'add' }
  /** The cart already holds this amount. */
  | { kind: 'unchanged'; message: string }
  /** A different amount is in the cart: ask, then swap it. */
  | { kind: 'replace'; title: string; message: string; confirm: string };

export function decideCharge(input: ChargeInput): ChargeDecision {
  const { amount, commissionCurrency, tillCurrency, inCart } = input;
  if (!(amount > 0)) return { kind: 'invalid', message: 'Enter an amount to charge.' };
  if (commissionCurrency !== tillCurrency) {
    return {
      kind: 'blocked',
      message: `This commission is in ${commissionCurrency}, but the till is working in ${tillCurrency}, so it cannot be added to this sale. Open the till for an event or store in ${commissionCurrency}.`,
    };
  }
  if (inCart === null) return { kind: 'add' };
  if (round2(inCart) === round2(amount)) return { kind: 'unchanged', message: `The sale already has ${fmtPrice(amount, commissionCurrency)} for this commission.` };
  return {
    kind: 'replace',
    title: 'Change the amount?',
    message: `The sale already has ${fmtPrice(inCart, commissionCurrency)} for this commission. Replace it with ${fmtPrice(amount, commissionCurrency)}?`,
    confirm: 'Replace',
  };
}
