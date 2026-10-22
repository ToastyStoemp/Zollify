import { z } from 'zod';
import { round2 } from './money';

/**
 * Gift cards: a balance a customer pays for now and spends later, at any of
 * the account's tills. Pure types and rules here so the server, the owner's
 * screens and the till agree on what a code looks like and what a card is
 * worth.
 *
 * What a card holds is never stored. Selling or topping up a card is an
 * ordinary sale line that points at it (`load`), and spending it is a
 * settling line that points at it (`redeem`, negative), so the balance is
 * summed from the till's own sales every time it is asked for - like stock,
 * so reverting a sale puts the money back with no compensating write.
 */

export const GIFT_CARD_MODULE_ID = 'gift-cards';
/** `ref.kind` of a sale line that puts money on a card (sold, or topped up). */
export const GIFT_CARD_LOAD_REF_KIND = 'load';
/** `ref.kind` of a sale line that spends a card; its amount is negative. */
export const GIFT_CARD_REDEEM_REF_KIND = 'redeem';

/**
 * Codes: "ZG" and 16 characters from an alphabet without 0/O, 1/I/L, so a
 * code read out over the phone or typed from a card survives. 31^16 is
 * about 2^79 - not guessable. "ZG" tells a code apart from a staff badge
 * ("ZS") and a product's short barcode at the till.
 */
export const GIFT_CARD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const GIFT_CARD_CODE_LENGTH = 16;
export const GIFT_CARD_PREFIX = 'ZG';
const GIFT_CARD_PATTERN = new RegExp(`^${GIFT_CARD_PREFIX}[${GIFT_CARD_ALPHABET}]{${GIFT_CARD_CODE_LENGTH}}$`);

/** The one spelling a code is stored and compared in: upper case, no dashes or spaces. */
export const normaliseGiftCardCode = (input: string): string => input.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const isGiftCardCode = (input: string): boolean => GIFT_CARD_PATTERN.test(normaliseGiftCardCode(input));

/** "ZG-ABCD-EFGH-JKMN-PQRS": how a code is printed and shown. */
export function formatGiftCardCode(code: string): string {
  const c = normaliseGiftCardCode(code);
  if (!GIFT_CARD_PATTERN.test(c)) return code;
  return [GIFT_CARD_PREFIX, ...(c.slice(GIFT_CARD_PREFIX.length).match(/.{4}/g) ?? [])].join('-');
}

/** "ZG-····-····-····-PQRS": enough to tell cards apart in a list, not enough to spend one. */
export function maskGiftCardCode(code: string): string {
  const c = normaliseGiftCardCode(code);
  if (!GIFT_CARD_PATTERN.test(c)) return code;
  return `${GIFT_CARD_PREFIX}-····-····-····-${c.slice(-4)}`;
}

/** A code from 16 numbers in [0, 31) - the server feeds it random ones. */
export function giftCardCodeFrom(indexes: number[]): string {
  if (indexes.length !== GIFT_CARD_CODE_LENGTH) throw new Error(`A gift card code needs ${GIFT_CARD_CODE_LENGTH} characters.`);
  return GIFT_CARD_PREFIX + indexes.map((i) => GIFT_CARD_ALPHABET[((i % GIFT_CARD_ALPHABET.length) + GIFT_CARD_ALPHABET.length) % GIFT_CARD_ALPHABET.length]).join('');
}

const money = z.number().finite().min(0).max(100_000);
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'A currency is three letters, like EUR.');

export const GiftCardSettingsSchema = z.object({
  /** Months a card can be spent after it was issued; 0 = never expires. */
  expiryMonths: z.number().int().min(0).max(120).default(0),
  /** The most a single card may be sold for at the till. */
  maxValue: z.number().finite().min(1).max(100_000).default(500),
});
export type GiftCardSettings = z.infer<typeof GiftCardSettingsSchema>;

export const GiftCardCreateSchema = z.object({
  /** What the card is sold for (loaded by the sale that follows), or granted outright. */
  value: money.min(0.01, 'Enter an amount.'),
  currency: currency.default('EUR'),
  /** Who it is for, an occasion - shown to staff only. */
  note: z.string().trim().max(200).default(''),
  /**
   * Put the value on the card without a sale - goodwill, a prize, a refund.
   * Admin only: it is money the business gives away.
   */
  granted: z.boolean().default(false),
});
export type GiftCardCreateInput = z.infer<typeof GiftCardCreateSchema>;

export const GiftCardNoteSchema = z.object({ note: z.string().trim().max(200).default('') });

export interface GiftCard {
  id: string;
  code: string;
  currency: string;
  /** The face value asked at issue. Informational: what is on the card comes from sales. */
  value: number;
  /** Credited without a sale (see GiftCardCreateSchema.granted). */
  granted: number;
  note: string;
  createdAt: number;
  createdBy: string | null;
  /** Set when an admin took the card out of use; whatever was on it is lost to the holder. */
  voidedAt: number | null;
  /** After this the card cannot be spent; null = never. Set from the settings at issue. */
  expiresAt: number | null;
}

/** A sale line that put money on the card or spent it, found by following the sale lines that point at it. */
export interface GiftCardMovement {
  saleId: string;
  at: number;
  kind: 'load' | 'redeem';
  /** Positive for a load, negative for a redemption. */
  amount: number;
  label: string;
}

export interface GiftCardTotals {
  /** Granted plus every load that stands (a reverted sale no longer counts). */
  loaded: number;
  /** Spent so far, as a positive figure. */
  redeemed: number;
  /** What can still be spent; never negative. */
  balance: number;
  movements: GiftCardMovement[];
}

export function giftCardTotals(card: Pick<GiftCard, 'granted'>, movements: GiftCardMovement[]): GiftCardTotals {
  const sorted = [...movements].sort((a, b) => a.at - b.at);
  const loaded = round2(card.granted + sorted.filter((m) => m.kind === 'load').reduce((s, m) => s + m.amount, 0));
  const redeemed = round2(-sorted.filter((m) => m.kind === 'redeem').reduce((s, m) => s + m.amount, 0));
  return { loaded, redeemed, balance: round2(Math.max(0, loaded - redeemed)), movements: sorted };
}

/** When a card issued at `createdAt` stops working under the settings; null = never. */
export function giftCardExpiry(createdAt: number, expiryMonths: number): number | null {
  if (!(expiryMonths > 0)) return null;
  const d = new Date(createdAt);
  d.setMonth(d.getMonth() + expiryMonths);
  return d.getTime();
}

export type GiftCardState =
  /** Can be spent. */
  | 'active'
  /** Issued, but the sale that loads it has not reached the server (or was reverted). */
  | 'unloaded'
  /** Spent down to nothing. */
  | 'empty'
  | 'expired'
  | 'void';

export function giftCardState(card: Pick<GiftCard, 'voidedAt' | 'expiresAt'>, totals: Pick<GiftCardTotals, 'loaded' | 'balance'>, now = Date.now()): GiftCardState {
  if (card.voidedAt) return 'void';
  if (card.expiresAt && card.expiresAt <= now) return 'expired';
  if (totals.loaded <= 0) return 'unloaded';
  if (totals.balance <= 0) return 'empty';
  return 'active';
}

export const GIFT_CARD_STATE_LABEL: Record<GiftCardState, string> = {
  active: 'Active',
  unloaded: 'Not loaded yet',
  empty: 'Used up',
  expired: 'Expired',
  void: 'Void',
};

/** Why a card cannot be spent right now, in the seller's words; null when it can. */
export function giftCardRefusal(state: GiftCardState): string | null {
  switch (state) {
    case 'active':
      return null;
    case 'unloaded':
      return 'This card has not been loaded yet - the sale that sold it has not synced, or was reverted.';
    case 'empty':
      return 'This card has been used up.';
    case 'expired':
      return 'This card has expired.';
    case 'void':
      return 'This card was voided.';
  }
}

export interface GiftCardPeriodRow {
  currency: string;
  /** Loaded in the period: sold, topped up and granted. */
  issued: number;
  /** Spent in the period. */
  redeemed: number;
  /** Still on cards at the end of the period (voided and expired cards left out). */
  outstanding: number;
  /** On cards that were voided or expired by the end of the period with money still on them. */
  lapsed: number;
}

/**
 * What the books need per period: a card sold is a liability until it is
 * spent, so the figures are issued, redeemed and what is still owed to card
 * holders at the period's end. `from` and `to` are epoch ms, half-open.
 */
export function giftCardPeriod(cards: { card: GiftCard; movements: GiftCardMovement[] }[], from: number, to: number): GiftCardPeriodRow[] {
  const rows = new Map<string, GiftCardPeriodRow>();
  const row = (currency: string): GiftCardPeriodRow => {
    const r = rows.get(currency) ?? { currency, issued: 0, redeemed: 0, outstanding: 0, lapsed: 0 };
    rows.set(currency, r);
    return r;
  };
  for (const { card, movements } of cards) {
    const r = row(card.currency);
    const inPeriod = (at: number) => at >= from && at < to;
    if (inPeriod(card.createdAt)) r.issued += card.granted;
    for (const m of movements) {
      if (!inPeriod(m.at)) continue;
      if (m.kind === 'load') r.issued += m.amount;
      else r.redeemed -= m.amount;
    }
    // The card as it stood at the end of the period.
    const upTo = movements.filter((m) => m.at < to);
    const granted = card.createdAt < to ? card.granted : 0;
    const left = giftCardTotals({ granted }, upTo).balance;
    if (left <= 0) continue;
    const lapsed = (card.voidedAt != null && card.voidedAt < to) || (card.expiresAt != null && card.expiresAt < to);
    if (lapsed) r.lapsed += left;
    else r.outstanding += left;
  }
  return [...rows.values()].map((r) => ({ ...r, issued: round2(r.issued), redeemed: round2(r.redeemed), outstanding: round2(r.outstanding), lapsed: round2(r.lapsed) })).sort((a, b) => a.currency.localeCompare(b.currency));
}
