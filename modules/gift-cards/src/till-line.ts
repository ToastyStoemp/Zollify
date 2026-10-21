import { fmtPrice, round2 } from '@zollify/shared';

/**
 * What to do when the seller taps "Add to the sale" for a gift card. Pure, so
 * the rules are tested without a till.
 */

export type Decision =
  | { kind: 'invalid'; message: string }
  /** Nothing can be added: wrong currency, a card that cannot be spent. */
  | { kind: 'blocked'; message: string }
  | { kind: 'add' }
  /** The cart already holds this amount. */
  | { kind: 'unchanged'; message: string }
  /** A different amount is in the cart: ask, then swap it. */
  | { kind: 'replace'; title: string; message: string; confirm: string };

export interface SellInput {
  amount: number;
  maxValue: number;
  currency: string;
}

/** Selling a card: any amount up to the limit the admin set. */
export function decideSell(input: SellInput): Decision {
  const { amount, maxValue, currency } = input;
  if (!(amount > 0)) return { kind: 'invalid', message: 'Enter the amount to put on the card.' };
  if (round2(amount) > maxValue) return { kind: 'invalid', message: `A card can hold at most ${fmtPrice(maxValue, currency)} - an admin can change that under Settings → Gift cards.` };
  return { kind: 'add' };
}

export interface RedeemInput {
  amount: number;
  /** What is on the card, as this device knows it. */
  balance: number;
  /** Why the card cannot be spent, when it cannot (see giftCardRefusal). */
  refusal: string | null;
  cardCurrency: string;
  tillCurrency: string;
  /** What the sale comes to right now, before this card; null on a shell that cannot say. */
  tillTotal: number | null;
  /** The amount of this card's line already in the cart, when there is one. */
  inCart: number | null;
}

/** The most a card can put towards the sale right now: what is on it, and no more than the sale comes to. */
export function suggestedRedeem(input: Pick<RedeemInput, 'balance' | 'tillTotal' | 'inCart'>): number {
  const owed = input.tillTotal == null ? input.balance : round2(input.tillTotal + (input.inCart ?? 0));
  return round2(Math.max(0, Math.min(input.balance, owed)));
}

export function decideRedeem(input: RedeemInput): Decision {
  const { amount, balance, refusal, cardCurrency, tillCurrency, tillTotal, inCart } = input;
  if (refusal) return { kind: 'blocked', message: refusal };
  if (cardCurrency !== tillCurrency) {
    return {
      kind: 'blocked',
      message: `This card is in ${cardCurrency}, but the till is working in ${tillCurrency}, so it cannot be spent on this sale. Open the till for an event or store in ${cardCurrency}.`,
    };
  }
  if (!(amount > 0)) return { kind: 'invalid', message: 'Enter the amount to take from the card.' };
  if (round2(amount) > balance) return { kind: 'invalid', message: `Only ${fmtPrice(balance, cardCurrency)} is on this card.` };
  if (tillTotal != null) {
    const owed = round2(tillTotal + (inCart ?? 0));
    if (owed <= 0) return { kind: 'blocked', message: 'There is nothing in the sale for the card to pay for - add the items first.' };
    if (round2(amount) > owed) return { kind: 'invalid', message: `The sale only comes to ${fmtPrice(owed, tillCurrency)}.` };
  }
  if (inCart === null) return { kind: 'add' };
  if (round2(inCart) === round2(amount)) return { kind: 'unchanged', message: `The sale already takes ${fmtPrice(amount, cardCurrency)} from this card.` };
  return {
    kind: 'replace',
    title: 'Change the amount?',
    message: `The sale already takes ${fmtPrice(inCart, cardCurrency)} from this card. Take ${fmtPrice(amount, cardCurrency)} instead?`,
    confirm: 'Change',
  };
}
