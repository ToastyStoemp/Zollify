import { describe, expect, it } from 'vitest';
import type { Transaction, TxDiscount, TxItem } from '@zollify/shared';
import { calcCoreProduct, capSoldToBrought, countryToCode, declaredLineValues, discountFraction, hasStock } from '../index';

function txItem(over: Partial<TxItem>): TxItem {
  return { pid: 'p', vid: null, title: 'Item', qty: 1, unitPrice: 10, lineTotal: 10, ...over };
}

function tx(items: TxItem[], discounts: TxDiscount[] = []): Transaction {
  return {
    id: 't', eventId: 'e', deviceId: 'd', timestamp: 0, method: 'cash',
    payments: [], items, discounts, total: items.reduce((s, i) => s + i.lineTotal, 0), currency: 'CHF',
  };
}

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

  it('excludes an unlisted variant\'s stock from amount/weight/value, even with real brought stock', () => {
    // Deliberate business-rule choice, not a legacy-parity one - see the
    // doc comment on calcCoreProduct.
    const p = {
      variants: [
        { amount: 5, price: 10, weightG: 100 },
        { amount: 2, price: 250, weightG: 500, unlisted: true },
      ],
    };
    const c = calcCoreProduct(p);
    expect(c.amount).toBe(5);
    expect(c.totalValue).toBe(50);
    expect(c.totalWeightKg).toBe(0.5);
  });
});

describe('discountFraction', () => {
  it('is zero for a sale with no discount', () => {
    expect(discountFraction(tx([txItem({ lineTotal: 100 })]))).toBe(0);
  });

  it('is the discount as a share of the pre-discount subtotal', () => {
    // 100 subtotal, 25 off -> every line keeps 75% of its own value.
    const t = tx([txItem({ lineTotal: 60 }), txItem({ lineTotal: 40 })], [{ name: 'Bundle', amount: 25 }]);
    expect(discountFraction(t)).toBeCloseTo(0.25);
  });

  it('never goes negative or above 1, even with a discount larger than the subtotal', () => {
    const t = tx([txItem({ lineTotal: 10 })], [{ name: 'Oops', amount: 50 }]);
    expect(discountFraction(t)).toBe(1);
  });

  it('is zero for an empty sale rather than dividing by zero', () => {
    expect(discountFraction(tx([]))).toBe(0);
  });
});

describe('declaredLineValues', () => {
  const sale = (over: Partial<Transaction>): Transaction => ({
    id: 't', eventId: 'e', deviceId: 'd', timestamp: 1, method: 'cash', payments: [], discounts: [],
    items: [], total: 0, currency: 'CHF', ...over,
  });
  const item = (unitPrice: number, lineTotal: number, qty = 1) => ({ pid: 'p', vid: null, title: 'x', qty, unitPrice, lineTotal });

  it('uses the till\'s own split when it was recorded', () => {
    // Two pins in a "2 for 22" bundle plus a sticker sheet that wasn't in it.
    const t = sale({
      items: [item(12, 11), item(12, 11), item(7, 7)], total: 29,
      asCharged: { listTotals: [12, 12, 7], lineDiscounts: [1, 1, 0], discounts: [{ name: 'Enamel', amount: 2, lines: [0, 1] }] },
    });
    expect(declaredLineValues(t, 'charged')).toEqual([11, 11, 7]);
  });

  it('older sales: splits what was paid over list prices, in whole units', () => {
    // Recorded before the till kept the split: the 2 off was spread over the basket.
    const t = sale({ items: [item(12, 11.23), item(12, 11.23), item(7, 6.54)], total: 29, asCharged: { listTotals: [12, 12, 7], discounts: [] } });
    const out = declaredLineValues(t, 'charged');
    expect(out.every(Number.isInteger)).toBe(true);
    expect(out.reduce((a, b) => a + b, 0)).toBe(29);
  });

  it('declares the charged currency, not the book one, for a converted sale', () => {
    // Lines are kept in EUR (144.38), the customer paid 145 CHF.
    const t = sale({
      items: [item(80, 74.52), item(40, 37.26), item(35, 32.6)], total: 145,
      currency: 'CHF', baseCurrency: 'EUR', baseTotal: 144.38, exchangeRate: 0.94,
      asCharged: { listTotals: [80, 40, 35], discounts: [{ name: 'Discount', amount: 10 }] },
    });
    expect(declaredLineValues(t, 'charged').reduce((a, b) => a + b, 0)).toBe(145);
    expect(declaredLineValues(t, 'book').reduce((a, b) => a + b, 0)).toBe(144);
  });

  it('an imported sale with its discount listed separately', () => {
    const t = sale({ items: [item(40, 40), item(30, 30), item(30, 30)], total: 75, discounts: [{ name: 'Bundle', amount: 25 }] });
    expect(declaredLineValues(t, 'charged')).toEqual([30, 23, 22]);
  });

  it('whole units even when one line\'s price has cents', () => {
    // A print at 80 plus a hand-priced frame at 31.86, paid 110 together.
    const t = sale({ items: [item(80, 80), item(31.86, 31.86)], total: 110 });
    const out = declaredLineValues(t, 'charged');
    expect(out.every(Number.isInteger)).toBe(true);
    expect(out.reduce((a, b) => a + b, 0)).toBe(110);
  });

  it('leaves an undiscounted sale exactly as charged', () => {
    const t = sale({ items: [item(15, 15), item(50, 50)], total: 65 });
    expect(declaredLineValues(t, 'charged')).toEqual([15, 50]);
  });
});

describe('capSoldToBrought', () => {
  it('keeps a whole value whole when scaling down to the claimed quantity', () => {
    expect(capSoldToBrought({ qty: 3, value: 100 }, 2)).toEqual({ qty: 2, value: 67 });
  });

  it('rounds other values to the cent', () => {
    expect(capSoldToBrought({ qty: 3, value: 10.5 }, 2)).toEqual({ qty: 2, value: 7 });
    expect(capSoldToBrought({ qty: 3, value: 10.25 }, 1)).toEqual({ qty: 1, value: 3.42 });
  });
});
