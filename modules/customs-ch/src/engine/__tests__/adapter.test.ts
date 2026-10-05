import { describe, expect, it } from 'vitest';
import type { EventStock, Product, SalesEvent, Transaction } from '@zollify/shared';
import { buildCustomsState } from '../adapter';

const event: SalesEvent = {
  id: 'ev1', name: 'Con', venue: {}, currency: 'CHF', status: 'active', updatedAt: 1,
};

const claimed = (...ids: string[]): EventStock[] =>
  ids.map((productId) => ({ eventId: 'ev1', productId, variantId: '', broughtQty: 10, updatedAt: 1 }));

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
    const state = buildCustomsState(chfEvent, [product({ price: 20 })], claimed('p1'), [tx]);
    expect(state.products[0]!.soldValue).toBe(19);
  });
});

describe('buildCustomsState - discounted sales', () => {
  it('spreads a transaction-level discount across its lines instead of declaring the full list price', () => {
    // Two items at 10 each, a 5 bundle discount off the 20 subtotal -> 25%
    // off every line: 7.5 each exactly, split in whole units as 8 + 7 so the
    // documents show whole numbers and still add up to the 15 paid.
    const tx: Transaction = {
      id: 't1', eventId: 'ev1', deviceId: 'd1', timestamp: 1, method: 'cash', payments: [],
      discounts: [{ name: 'Bundle', amount: 5 }],
      total: 15, currency: 'CHF',
      items: [
        { pid: 'p1', vid: null, title: 'A', qty: 1, unitPrice: 10, lineTotal: 10 },
        { pid: 'p2', vid: null, title: 'B', qty: 1, unitPrice: 10, lineTotal: 10 },
      ],
    };
    const state = buildCustomsState(event, [product({ id: 'p1', price: 10 }), product({ id: 'p2', price: 10 })], claimed('p1', 'p2'), [tx]);
    expect(state.products.find((p) => p.id === 'p1')!.soldValue).toBe(8);
    expect(state.products.find((p) => p.id === 'p2')!.soldValue).toBe(7);
  });
});

describe('buildCustomsState - combining sales from other events (same trip, two shows)', () => {
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
    total: 10, currency: 'CHF', items: [{ pid: 'p1', vid: null, title: 'Thing', qty: 1, unitPrice: 10, lineTotal: 10 }],
  };
  const tx2: Transaction = {
    id: 't2', eventId: 'ev2', deviceId: 'd1', timestamp: 2, method: 'cash', payments: [], discounts: [],
    total: 10, currency: 'CHF', items: [{ pid: 'p1', vid: null, title: 'Thing', qty: 2, unitPrice: 10, lineTotal: 20 }],
  };

  it('without combinedEventIds, only this event\'s own sales and stock count', () => {
    const state = buildCustomsState(event, [product({ price: 10 })], stock, [tx1, tx2]);
    const p = state.products[0]!;
    expect(p.amount).toBe(10);
    expect(p.soldQty).toBe(1);
    expect(p.soldValue).toBe(10);
  });

  it('with the other event combined, sold qty/value sum across both, but brought stays this event\'s own', () => {
    const state = buildCustomsState(event, [product({ price: 10 })], stock, [tx1, tx2], ['ev2']);
    const p = state.products[0]!;
    expect(p.amount).toBe(10); // event 2's own claim (4) never gets added in
    expect(p.soldQty).toBe(3); // 1 (ev1) + 2 (ev2)
    expect(p.soldValue).toBe(30); // 10 (ev1) + 20 (ev2)
  });

  it('names every linked event and spans from the first start to the last end', () => {
    const a: SalesEvent = { ...event, dateStart: '2026-05-01', dateEnd: '2026-05-03' };
    const b: SalesEvent = { ...event2, dateStart: '2026-05-08', dateEnd: '2026-05-10' };
    const state = buildCustomsState(b, [product({ price: 10 })], stock, [tx1, tx2], ['ev1'], [a, b]);
    expect(state.meta.event).toBe('Con / Con 2');
    expect(state.meta.eventDateStart).toBe('2026-05-01');
    expect(state.meta.eventDateEnd).toBe('2026-05-10');
  });

  it('keeps this event\'s own name and dates when nothing is linked', () => {
    const a: SalesEvent = { ...event, dateStart: '2026-05-01', dateEnd: '2026-05-03' };
    const state = buildCustomsState(a, [product({ price: 10 })], stock, [tx1], [], [a, event2]);
    expect(state.meta.event).toBe('Con');
    expect(state.meta.eventDateStart).toBe('2026-05-01');
    expect(state.meta.eventDateEnd).toBe('2026-05-03');
  });

  it('combining from the other direction (viewing event 2) still only uses event 2\'s own brought stock', () => {
    const state = buildCustomsState(event2, [product({ price: 10 })], stock, [tx1, tx2], ['ev1']);
    const p = state.products[0]!;
    expect(p.amount).toBe(4);
    expect(p.soldQty).toBe(3);
    expect(p.soldValue).toBe(30);
  });
});

describe('buildCustomsState - selling more than was claimed', () => {
  const sale = (id: string, qty: number, lineTotal: number, vid: string | null = null): Transaction => ({
    id, eventId: 'ev1', deviceId: 'd1', timestamp: 1, method: 'cash', payments: [], discounts: [],
    total: lineTotal, currency: 'CHF', items: [{ pid: 'p1', vid, title: 'Thing', qty, unitPrice: lineTotal / qty, lineTotal }],
  });

  it('ignores sold units beyond the claimed quantity', () => {
    const stock: EventStock[] = [{ eventId: 'ev1', productId: 'p1', variantId: '', broughtQty: 2, updatedAt: 1 }];
    const state = buildCustomsState(event, [product({ price: 10 })], stock, [sale('t1', 2, 20), sale('t2', 1, 10)]);
    const p = state.products[0]!;
    expect(p.amount).toBe(2);
    expect(p.soldQty).toBe(2);
    expect(p.soldValue).toBe(20);
  });

  it('counts no sales at all for a product that was never claimed', () => {
    const state = buildCustomsState(event, [product({ price: 10 })], [], [sale('t1', 1, 10)]);
    expect(state.products[0]!.soldQty).toBe(0);
    expect(state.products[0]!.soldValue).toBe(0);
  });

  it('caps each variant against its own claimed quantity', () => {
    const stock: EventStock[] = [
      { eventId: 'ev1', productId: 'p1', variantId: 'v1', broughtQty: 1, updatedAt: 1 },
      { eventId: 'ev1', productId: 'p1', variantId: 'v2', broughtQty: 5, updatedAt: 1 },
    ];
    const p1 = product({ price: 10, variants: [{ id: 'v1', name: 'A' }, { id: 'v2', name: 'B' }] });
    const state = buildCustomsState(event, [p1], stock, [sale('t1', 3, 30, 'v1'), sale('t2', 2, 20, 'v2')]);
    const [a, b] = state.products[0]!.variants!;
    expect(a!.soldQty).toBe(1);
    expect(a!.soldValue).toBe(10);
    expect(b!.soldQty).toBe(2);
    expect(b!.soldValue).toBe(20);
  });
});
