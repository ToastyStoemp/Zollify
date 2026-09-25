import { describe, expect, it } from 'vitest';
import { calcCoreProduct, countryToCode, hasStock } from '../index';

describe('countryToCode', () => {
  it('resolves a full country name via the shared COUNTRY_CODES table, not a hand-rolled subset', () => {
    // customs-de's own copy of this function only knew four countries and
    // fell back to "first two letters uppercased" for anything else, which
    // is wrong for most countries - this one would have come back "AU".
    expect(countryToCode('Austria')).toBe('AT');
  });

  it('still resolves the countries every caller already relied on', () => {
    expect(countryToCode('Switzerland')).toBe('CH');
    expect(countryToCode('Germany')).toBe('DE');
  });

  it('passes an already-valid 2-letter code straight through', () => {
    expect(countryToCode('FR')).toBe('FR');
  });
});

describe('calcCoreProduct / hasStock', () => {
  it('sums variant amounts instead of reading a flat, non-variant-aware amount field', () => {
    const p = { amount: 0, variants: [{ amount: 12, price: 8, weightG: 20 }, { amount: 3, price: 8, weightG: 20 }] };
    expect(calcCoreProduct(p).amount).toBe(15);
    expect(hasStock(p)).toBe(true);
  });

  it('reports no stock for an unlisted product even with a nonzero amount', () => {
    expect(hasStock({ amount: 5, unlisted: true })).toBe(false);
  });

  it('reports no stock for a zero-amount product', () => {
    expect(hasStock({ amount: 0 })).toBe(false);
  });

  it('a whole-product value override wins over price * amount for a non-variant product', () => {
    const c = calcCoreProduct({ amount: 4, price: 10 }, { totalValueOverride: 999 });
    expect(c.totalValue).toBe(999);
  });
});
