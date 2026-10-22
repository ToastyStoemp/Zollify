import { describe, expect, it } from 'vitest';
import { OrderInputSchema, TradeCustomerSchema, TradeDetailsSchema, addWorkingDays, expectedShipDate, nextOrderStatuses, orderTotals, orderableQty, reservedByItem, tierPriceFor, unitPriceFor } from '../wholesale';

const tiers = [{ minQty: 10, price: 8 }, { minQty: 50, price: 6.5 }, { minQty: 1, price: 9 }];

describe('prices', () => {
  it('take the highest tier reached, else the list price, less the customer discount', () => {
    expect(tierPriceFor(tiers, 1, 12)).toBe(9);
    expect(tierPriceFor(tiers, 49, 12)).toBe(8);
    expect(tierPriceFor(tiers, 50, 12)).toBe(6.5);
    expect(tierPriceFor([], 50, 12)).toBe(12);
    expect(tierPriceFor([{ minQty: 10, price: 8 }], 5, 12)).toBe(12);
    expect(unitPriceFor(tiers, 50, 12, 10)).toBe(5.85);
    expect(unitPriceFor(tiers, 50, 12, 0)).toBe(6.5);
  });

  it('round a quantity up to the minimum and to whole packs', () => {
    expect(orderableQty(3, { moq: 12, packSize: 6 })).toBe(12);
    expect(orderableQty(13, { moq: 12, packSize: 6 })).toBe(18);
    expect(orderableQty(7, { moq: 1, packSize: 1 })).toBe(7);
    expect(orderableQty(0, { moq: 1, packSize: 1 })).toBe(1);
  });

  it('sum an order to the cent', () => {
    expect(orderTotals([{ qty: 3, unitPrice: 0.1 }, { qty: 3, unitPrice: 0.2 }])).toEqual({ units: 6, total: 0.9 });
  });
});

describe('dates', () => {
  it('count working days only', () => {
    // 2026-10-23 is a Friday.
    expect(addWorkingDays(new Date('2026-10-23T12:00:00'), 1)).toBe('2026-10-26');
    expect(addWorkingDays(new Date('2026-10-23T12:00:00'), 0)).toBe('2026-10-23');
    expect(addWorkingDays(new Date('2026-10-23T12:00:00'), 6)).toBe('2026-11-02');
  });
  it('an order ships when its slowest line is ready', () => {
    const lead = (id: string): number => ({ pin: 2, print: 10 })[id] ?? 0;
    expect(expectedShipDate(new Date('2026-10-23T12:00:00').getTime(), lead, [{ productId: 'pin' }, { productId: 'print' }])).toBe('2026-11-06');
    expect(expectedShipDate(new Date('2026-10-23T12:00:00').getTime(), lead, [{ productId: 'other' }])).toBe('2026-10-23');
  });
});

describe('orders', () => {
  it('move draft to confirmed to packed to shipped to invoiced to paid, out to cancelled until shipped', () => {
    expect(nextOrderStatuses('draft')).toEqual(['confirmed', 'cancelled']);
    expect(nextOrderStatuses('packed')).toEqual(['shipped', 'cancelled']);
    expect(nextOrderStatuses('shipped')).toEqual(['invoiced', 'paid']);
    expect(nextOrderStatuses('paid')).toEqual([]);
    expect(nextOrderStatuses('cancelled')).toEqual([]);
  });
  it('confirmed and packed orders reserve their units per item', () => {
    const line = (productId: string, variantId: string | null, qty: number) => ({ productId, variantId, title: 't', variantLabel: '', sku: '', qty, unitPrice: 1 });
    const r = reservedByItem([
      { status: 'confirmed', lines: [line('pin', null, 5), line('print', 'a4', 2)] },
      { status: 'packed', lines: [line('pin', null, 3)] },
      { status: 'draft', lines: [line('pin', null, 100)] },
      { status: 'shipped', lines: [line('pin', null, 100)] },
    ]);
    expect([...r.entries()]).toEqual([['pin:', 8], ['print:a4', 2]]);
  });
  it('schemas refuse nonsense', () => {
    expect(TradeDetailsSchema.parse({})).toMatchObject({ enabled: true, tiers: [], moq: 1, packSize: 1, leadDays: 0 });
    expect(TradeDetailsSchema.safeParse({ tiers: [{ minQty: 0, price: 1 }] }).success).toBe(false);
    expect(TradeCustomerSchema.safeParse({ company: '' }).success).toBe(false);
    expect(TradeCustomerSchema.parse({ company: 'Plush & Co', country: 'be', email: 'A@B.CO' })).toMatchObject({ country: 'BE', email: 'a@b.co', currency: 'EUR', discountPct: 0 });
    expect(OrderInputSchema.safeParse({ customerId: '', lines: [] }).success).toBe(false);
    expect(OrderInputSchema.safeParse({ customerId: 'c', lines: [{ productId: 'p', title: 'T', qty: 0, unitPrice: 1 }] }).success).toBe(false);
  });
});
