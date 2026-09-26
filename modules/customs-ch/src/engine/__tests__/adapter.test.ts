import { describe, expect, it } from 'vitest';
import type { Product, SalesEvent, Transaction } from '@zollify/shared';
import { buildCustomsState } from '../adapter';

const event: SalesEvent = {
  id: 'ev1', name: 'Con', venue: {}, currency: 'CHF', status: 'active', updatedAt: 1,
};

function product(over: Partial<Product>): Product {
  return {
    id: 'p1', title: 'Thing', forSale: true, unlisted: false, price: 10,
    variants: [], sortOrder: 0, updatedAt: 1, ...over,
  };
}

const rateOf = (p: Product) => {
  const cp = buildCustomsState(event, [p], [], []).products[0]!;
  return { vatRate: cp.vatRate, tariffRate: cp.tariffRate };
};

describe('buildCustomsState - HS-code-derived rates', () => {
  it('fills VAT + duty rate from the HS code when the product has no override', () => {
    // 4901.99.00 (books) is the reduced-rate line: 2.6%.
    expect(rateOf(product({ tariffNo: '4901.99.00' }))).toEqual({ vatRate: 2.6, tariffRate: 2.6 });
    // 4911.91.00 (art prints) is the standard line: 8.1%.
    expect(rateOf(product({ tariffNo: '4911.91.00' }))).toEqual({ vatRate: 8.1, tariffRate: 8.1 });
  });

  it('keeps an explicit override instead of the HS-code value', () => {
    expect(rateOf(product({ tariffNo: '4911.91.00', vatRate: 3.7, tariffRate: 0 }))).toEqual({
      vatRate: 3.7,
      tariffRate: 0,
    });
  });

  it('leaves rates unset when there is no (or an unknown) HS code', () => {
    expect(rateOf(product({}))).toEqual({ vatRate: undefined, tariffRate: undefined });
    expect(rateOf(product({ tariffNo: '9999.99.99' }))).toEqual({ vatRate: undefined, tariffRate: undefined });
  });
});

describe('buildCustomsState - Swiss documents declare in the event\'s local currency', () => {
  const euroEvent: SalesEvent = { ...event, currency: 'EUR' };

  it('leaves the price and currency as the base currency when no local pricing is set up', () => {
    const state = buildCustomsState(euroEvent, [product({ price: 20 })], [], []);
    expect(state.meta.currency).toBe('EUR');
    expect(state.products[0]!.price).toBe(20);
  });

  it('converts to the local currency and labels the document with it', () => {
    const chfEvent: SalesEvent = { ...euroEvent, localCurrency: 'CHF', exchangeRate: 0.95, roundingIncrement: 0.5 };
    const state = buildCustomsState(chfEvent, [product({ price: 20 })], [], []);
    expect(state.meta.currency).toBe('CHF');
    // 20 * 0.95 = 19, rounded to the nearest 0.5 -> 19.
    expect(state.products[0]!.price).toBe(19);
  });

  it('an explicit local price override wins over the computed rate', () => {
    const chfEvent: SalesEvent = {
      ...euroEvent, localCurrency: 'CHF', exchangeRate: 0.95, roundingIncrement: 0.5,
      localPriceOverrides: { 'p1:': 18 },
    };
    const state = buildCustomsState(chfEvent, [product({ price: 20 })], [], []);
    expect(state.products[0]!.price).toBe(18);
  });

  it('an override on a variant with no price of its own still applies (not the product-level rate)', () => {
    // Real bug: a variant that inherits the product's price (no v.price of its
    // own) has its override checked against undefined instead of the price it
    // actually resolves to, so the override was silently never found.
    const chfEvent: SalesEvent = {
      ...euroEvent, localCurrency: 'CHF', exchangeRate: 0.9, roundingIncrement: 5,
      localPriceOverrides: { 'p1:v1': 12 },
    };
    const state = buildCustomsState(chfEvent, [product({ price: 12, variants: [{ id: 'v1', name: 'A' }] })], [], []);
    // Auto-converted would be 12*0.9=10.8, rounded to the nearest 5 -> 10.
    // The override (12) must win instead.
    expect(state.products[0]!.variants![0]!.price).toBe(12);
  });

  it('sold value is the amount actually charged (local currency), not the base-currency figure', () => {
    const chfEvent: SalesEvent = { ...euroEvent, localCurrency: 'CHF', exchangeRate: 0.95, roundingIncrement: 0 };
    const tx: Transaction = {
      id: 't1', eventId: 'ev1', deviceId: 'd1', timestamp: 1, method: 'cash', payments: [], discounts: [],
      total: 19, currency: 'CHF', baseCurrency: 'EUR', baseTotal: 20,
      items: [{ pid: 'p1', vid: null, title: 'Thing', qty: 1, unitPrice: 19, lineTotal: 19, baseUnitPrice: 20, baseLineTotal: 20 }],
    };
    const state = buildCustomsState(chfEvent, [product({ price: 20 })], [], [tx]);
    expect(state.products[0]!.soldValue).toBe(19);
  });
});
