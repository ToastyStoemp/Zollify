import { describe, expect, it } from 'vitest';
import { baseValueOf, needsRateLookup, owedByCurrency, toBaseFactor } from '../index';

// A EUR 10 print charged as SEK 115 at a pricing rate of 11.5.
const sale = { currency: 'SEK', baseCurrency: 'EUR', baseTotal: 10, total: 115 };

describe('a sale in the base currency', () => {
  it('is worth the charged amount at the day rate the till recorded', () => {
    expect(baseValueOf({ ...sale, marketRate: { rate: 11.13, at: 1 } }, 'EUR')).toBe(10.33);
    expect(needsRateLookup({ ...sale, marketRate: { rate: 11.13, at: 1 } }, 'EUR')).toBe(false);
  });

  it('falls back to a rate looked up for its date, then to the catalogue figure', () => {
    expect(needsRateLookup(sale, 'EUR')).toBe(true);
    expect(baseValueOf(sale, 'EUR', 1 / 11.2)).toBe(10.27);
    expect(baseValueOf(sale, 'EUR')).toBe(10);
  });

  it('an unconverted sale is what it is', () => {
    expect(toBaseFactor({ currency: 'EUR', total: 20 }, 'EUR')).toBe(1);
    expect(needsRateLookup({ currency: 'EUR' }, 'EUR')).toBe(false);
  });

  it('a sale kept in another book currency needs a looked-up rate, never its own day rate', () => {
    expect(needsRateLookup({ currency: 'SEK', marketRate: { rate: 1, at: 1 } }, 'EUR')).toBe(true);
    expect(baseValueOf({ currency: 'CHF', total: 100 }, 'EUR', 1.05)).toBe(105);
  });
});

describe('what a commission customer still owes', () => {
  it('is one amount per currency, cancelled commissions left out', () => {
    expect(
      owedByCurrency([
        { status: 'accepted', balance: 200, currency: 'EUR' },
        { status: 'accepted', balance: 150, currency: 'CHF' },
        { status: 'cancelled', balance: 80, currency: 'EUR' },
        { status: 'delivered', balance: 0, currency: 'DKK' },
      ] as never),
    ).toEqual([
      { currency: 'CHF', amount: 150 },
      { currency: 'EUR', amount: 200 },
    ]);
  });
});
