import { describe, expect, it } from 'vitest';
import {
  GiftCardCreateSchema,
  GiftCardSettingsSchema,
  formatGiftCardCode,
  giftCardCodeFrom,
  giftCardExpiry,
  giftCardPeriod,
  giftCardState,
  giftCardTotals,
  isGiftCardCode,
  maskGiftCardCode,
  normaliseGiftCardCode,
  type GiftCard,
  type GiftCardMovement,
} from '../gift-cards';

const CODE = 'ZGABCDEFGHJKMNPQRS';
const card = (extra: Partial<GiftCard> = {}): GiftCard => ({ id: 'c1', code: CODE, currency: 'EUR', value: 50, granted: 0, note: '', createdAt: 1000, createdBy: null, voidedAt: null, expiresAt: null, ...extra });
const load = (amount: number, at = 2000): GiftCardMovement => ({ saleId: `s${at}`, at, kind: 'load', amount, label: 'Gift card' });
const spend = (amount: number, at = 3000): GiftCardMovement => ({ saleId: `s${at}`, at, kind: 'redeem', amount: -amount, label: 'Gift card' });

describe('codes', () => {
  it('are ZG plus 16 safe characters, typed any which way', () => {
    expect(isGiftCardCode(CODE)).toBe(true);
    expect(isGiftCardCode('zg-abcd-efgh-jkmn-pqrs')).toBe(true);
    expect(isGiftCardCode('ZG ABCD EFGH JKMN PQRS')).toBe(true);
    expect(normaliseGiftCardCode('zg-abcd efgh.jkmn/pqrs')).toBe(CODE);
    // Confusable characters are not in the alphabet, nor is a staff badge or a short code.
    expect(isGiftCardCode('ZGABCDEFGHJKMNPQR0')).toBe(false);
    expect(isGiftCardCode('ZGABCDEFGHJKMNPQRI')).toBe(false);
    expect(isGiftCardCode('ZS123456789012345678901234')).toBe(false);
    expect(isGiftCardCode('P0A1B2C')).toBe(false);
    expect(isGiftCardCode(CODE.slice(0, -1))).toBe(false);
  });

  it('format and mask for printing and lists, and leave nonsense alone', () => {
    expect(formatGiftCardCode(CODE)).toBe('ZG-ABCD-EFGH-JKMN-PQRS');
    expect(formatGiftCardCode('zg-abcd-efgh-jkmn-pqrs')).toBe('ZG-ABCD-EFGH-JKMN-PQRS');
    expect(maskGiftCardCode(CODE)).toBe('ZG-····-····-····-PQRS');
    expect(formatGiftCardCode('nope')).toBe('nope');
    expect(maskGiftCardCode('nope')).toBe('nope');
  });

  it('are built from 16 numbers, each mapped into the alphabet', () => {
    expect(giftCardCodeFrom(new Array(16).fill(0))).toBe('ZGAAAAAAAAAAAAAAAA');
    expect(giftCardCodeFrom(new Array(16).fill(30))).toBe('ZG9999999999999999');
    expect(isGiftCardCode(giftCardCodeFrom(Array.from({ length: 16 }, (_, i) => i * 7)))).toBe(true);
    expect(() => giftCardCodeFrom([1, 2, 3])).toThrow();
  });
});

describe('what a card is worth', () => {
  it('sums loads and redemptions to the cent, in time order, never below zero', () => {
    const t = giftCardTotals(card(), [spend(20.1, 3000), load(50, 2000), spend(10, 4000)]);
    expect(t).toMatchObject({ loaded: 50, redeemed: 30.1, balance: 19.9 });
    expect(t.movements.map((m) => m.at)).toEqual([2000, 3000, 4000]);
    expect(giftCardTotals(card(), [load(10), spend(25)]).balance).toBe(0);
    expect(giftCardTotals(card({ granted: 25 }), [spend(5)])).toMatchObject({ loaded: 25, balance: 20 });
  });

  it('says why a card cannot be spent', () => {
    const t = giftCardTotals(card(), [load(50)]);
    expect(giftCardState(card(), t, 5000)).toBe('active');
    expect(giftCardState(card(), giftCardTotals(card(), []), 5000)).toBe('unloaded');
    expect(giftCardState(card(), giftCardTotals(card(), [load(50), spend(50)]), 5000)).toBe('empty');
    expect(giftCardState(card({ expiresAt: 4000 }), t, 5000)).toBe('expired');
    expect(giftCardState(card({ expiresAt: 6000 }), t, 5000)).toBe('active');
    // Void wins over everything.
    expect(giftCardState(card({ voidedAt: 100, expiresAt: 4000 }), t, 5000)).toBe('void');
  });

  it('expires a whole number of months after issue, or never', () => {
    expect(giftCardExpiry(Date.UTC(2026, 0, 31, 12), 0)).toBeNull();
    const d = new Date(giftCardExpiry(Date.UTC(2026, 0, 15, 12), 12)!);
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(0);
  });
});

describe('schemas', () => {
  it('take an amount and currency and refuse nonsense', () => {
    expect(GiftCardCreateSchema.parse({ value: 25, currency: 'chf' })).toMatchObject({ value: 25, currency: 'CHF', note: '', granted: false });
    expect(GiftCardCreateSchema.safeParse({ value: 0 }).success).toBe(false);
    expect(GiftCardCreateSchema.safeParse({ value: -5 }).success).toBe(false);
    expect(GiftCardCreateSchema.safeParse({ value: 5, currency: 'euros' }).success).toBe(false);
    expect(GiftCardSettingsSchema.parse({})).toEqual({ expiryMonths: 0, maxValue: 500 });
    expect(GiftCardSettingsSchema.safeParse({ expiryMonths: 1.5 }).success).toBe(false);
  });
});

describe('the period report', () => {
  it('counts what was issued and spent in the period and what is still owed at its end', () => {
    const cards = [
      // Sold before the period, spent during it.
      { card: card({ id: 'a', createdAt: 500 }), movements: [load(50, 600), spend(20, 1500)] },
      // Sold during the period, untouched.
      { card: card({ id: 'b', createdAt: 1200 }), movements: [load(30, 1200)] },
      // Granted during the period, then voided during it with money on it.
      { card: card({ id: 'c', createdAt: 1300, granted: 10, voidedAt: 1400 }), movements: [] },
      // Sold after the period: not in it at all.
      { card: card({ id: 'd', createdAt: 5000 }), movements: [load(99, 5000)] },
      // Another currency.
      { card: card({ id: 'e', currency: 'CHF', createdAt: 1100 }), movements: [load(40, 1100), spend(40, 1600)] },
    ];
    expect(giftCardPeriod(cards, 1000, 2000)).toEqual([
      { currency: 'CHF', issued: 40, redeemed: 40, outstanding: 0, lapsed: 0 },
      { currency: 'EUR', issued: 40, redeemed: 20, outstanding: 60, lapsed: 10 },
    ]);
  });
});
