import { describe, expect, it } from 'vitest';
import type { Product, SalesEvent, Transaction } from '@zollify/shared';
import { buildCustomsDeState } from '../adapter';

const event: SalesEvent = {
  id: 'ev1', name: 'Con', venue: {}, currency: 'EUR', status: 'active', updatedAt: 1,
};

function product(over: Partial<Product>): Product {
  return {
    id: 'p1', title: 'Thing', forSale: true, unlisted: false, price: 10,
    variants: [], sortOrder: 0, updatedAt: 1, ...over,
  };
}

describe('buildCustomsDeState - discounted sales', () => {
  it('spreads a transaction-level discount across its lines instead of declaring the full list price', () => {
    // Two items at 10 each, a 5 bundle discount off the 20 subtotal -> 25%
    // off every line, so each item's declared value is 7.5, not 10.
    const tx: Transaction = {
      id: 't1', eventId: 'ev1', deviceId: 'd1', timestamp: 1, method: 'cash', payments: [],
      discounts: [{ name: 'Bundle', amount: 5 }],
      total: 15, currency: 'EUR',
      items: [
        { pid: 'p1', vid: null, title: 'A', qty: 1, unitPrice: 10, lineTotal: 10 },
        { pid: 'p2', vid: null, title: 'B', qty: 1, unitPrice: 10, lineTotal: 10 },
      ],
    };
    const state = buildCustomsDeState(event, [product({ id: 'p1', price: 10 }), product({ id: 'p2', price: 10 })], [], [tx]);
    expect(state.products.find((p) => p.id === 'p1')!.soldValue).toBe(7.5);
    expect(state.products.find((p) => p.id === 'p2')!.soldValue).toBe(7.5);
  });

  it('uses the base-currency line value when the sale was charged in a converted local currency', () => {
    const tx: Transaction = {
      id: 't1', eventId: 'ev1', deviceId: 'd1', timestamp: 1, method: 'cash', payments: [], discounts: [],
      total: 19, currency: 'CHF', baseCurrency: 'EUR', baseTotal: 20,
      items: [{ pid: 'p1', vid: null, title: 'Thing', qty: 1, unitPrice: 19, lineTotal: 19, baseUnitPrice: 20, baseLineTotal: 20 }],
    };
    const state = buildCustomsDeState(event, [product({ price: 20 })], [], [tx]);
    expect(state.products[0]!.soldValue).toBe(20);
  });
});
