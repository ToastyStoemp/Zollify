import { describe, expect, it } from 'vitest';
import type { EventStock, Product, SalesEvent, Transaction } from '@zollify/shared';
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

describe('buildCustomsDeState - combining sales from other events (same trip, two shows)', () => {
  const event2: SalesEvent = { ...event, id: 'ev2', name: 'Con 2' };

  const stock: EventStock[] = [
    { eventId: 'ev1', productId: 'p1', variantId: '', broughtQty: 10, updatedAt: 1 },
    // Same physical stock re-claimed at the second event after event 1 sold
    // some of it - NOT additional stock. Summing this with ev1's 10 would
    // double-count units that only crossed the border once.
    { eventId: 'ev2', productId: 'p1', variantId: '', broughtQty: 4, updatedAt: 1 },
  ];

  const tx1: Transaction = {
    id: 't1', eventId: 'ev1', deviceId: 'd1', timestamp: 1, method: 'cash', payments: [], discounts: [],
    total: 10, currency: 'EUR', items: [{ pid: 'p1', vid: null, title: 'Thing', qty: 1, unitPrice: 10, lineTotal: 10 }],
  };
  const tx2: Transaction = {
    id: 't2', eventId: 'ev2', deviceId: 'd1', timestamp: 2, method: 'cash', payments: [], discounts: [],
    total: 10, currency: 'EUR', items: [{ pid: 'p1', vid: null, title: 'Thing', qty: 2, unitPrice: 10, lineTotal: 20 }],
  };

  it('without combinedEventIds, only this event\'s own sales and stock count', () => {
    const state = buildCustomsDeState(event, [product({ price: 10 })], stock, [tx1, tx2]);
    const p = state.products[0]!;
    expect(p.amount).toBe(10);
    expect(p.soldQty).toBe(1);
    expect(p.soldValue).toBe(10);
  });

  it('with the other event combined, sold qty/value sum across both, but brought stays this event\'s own', () => {
    const state = buildCustomsDeState(event, [product({ price: 10 })], stock, [tx1, tx2], ['ev2']);
    const p = state.products[0]!;
    expect(p.amount).toBe(10); // event 2's own claim (4) never gets added in
    expect(p.soldQty).toBe(3); // 1 (ev1) + 2 (ev2)
    expect(p.soldValue).toBe(30); // 10 (ev1) + 20 (ev2)
  });

  it('combining from the other direction (viewing event 2) still only uses event 2\'s own brought stock', () => {
    const state = buildCustomsDeState(event2, [product({ price: 10 })], stock, [tx1, tx2], ['ev1']);
    const p = state.products[0]!;
    expect(p.amount).toBe(4);
    expect(p.soldQty).toBe(3);
    expect(p.soldValue).toBe(30);
  });
});
