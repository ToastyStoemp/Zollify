import { describe, expect, it } from 'vitest';
import { OrderInputSchema, TradeCustomerSchema, TradeDetailsSchema, addWorkingDays, catalogueCards, tiersForPrice, expectedShipDate, nextOrderStatuses, orderTotals, orderableQty, reservedByItem, tierPriceFor, unitPriceFor } from '../wholesale';

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

describe('variants to the trade', () => {
  const print = {
    id: 'p-print',
    title: 'Harbour print',
    sku: 'HP',
    price: 20,
    imageId: 'img-print',
    variants: [
      { id: 'a4', name: 'A4', sku: 'HP-A4' },
      { id: 'a3', name: 'A3', sku: 'HP-A3', price: 30 },
      { id: 'a2', name: 'A2', price: 45, unlisted: true },
    ],
  };
  const keychain = {
    id: 'p-zodiac',
    title: 'Zodiac keychain',
    price: 8,
    imageId: 'img-zodiac',
    variants: [
      { id: 'chicken', name: 'Chicken', sku: 'ZK-CH', imageId: 'img-chicken' },
      { id: 'dog', name: 'Dog', sku: 'ZK-DO', imageId: 'img-dog' },
    ],
  };
  const tiers = [{ minQty: 10, price: 10 }, { minQty: 50, price: 9 }];

  it('gives a variant with its own price the same discount off it', () => {
    expect(tiersForPrice(tiers, 20, 30)).toEqual([{ minQty: 10, price: 15 }, { minQty: 50, price: 13.5 }]);
    expect(tiersForPrice(tiers, 20, 20)).toBe(tiers);
    // Nothing to scale from: the tiers stand as entered.
    expect(tiersForPrice(tiers, 0, 30)).toBe(tiers);
    expect(unitPriceFor(tiersForPrice(tiers, 20, 30), 12, 30, 0)).toBe(15);
  });

  it('shows sizes of one print as rows on one card, each at its own price', () => {
    const cards = catalogueCards(print, { tiers });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.title).toBe('Harbour print');
    expect(cards[0]!.rows.map((r) => [r.label, r.sku, r.listPrice, r.tiers[0]!.price])).toEqual([
      ['A4', 'HP-A4', 20, 10],
      ['A3', 'HP-A3', 30, 15],
    ]);
  });

  it('shows variants with photos of their own as items of their own', () => {
    const cards = catalogueCards(keychain, {});
    expect(cards.map((c) => [c.title, c.imageId, c.sku, c.rows.length])).toEqual([
      ['Zodiac keychain · Chicken', 'img-chicken', 'ZK-CH', 1],
      ['Zodiac keychain · Dog', 'img-dog', 'ZK-DO', 1],
    ]);
  });

  it('follows the choice made for the product', () => {
    expect(catalogueCards(keychain, { variantDisplay: 'options' })).toHaveLength(1);
    const separate = catalogueCards(print, { tiers, variantDisplay: 'separate' });
    expect(separate.map((c) => c.title)).toEqual(['Harbour print · A4', 'Harbour print · A3']);
    // A size with no photo of its own shows the print's.
    expect(separate[1]!.imageId).toBe('img-print');
    expect(separate[1]!.rows[0]!.tiers[0]!.price).toBe(15);
  });

  it('keeps a product without variants as one card at its price', () => {
    const cards = catalogueCards({ id: 'p', title: 'Sticker', price: 3, variants: [] }, {});
    expect(cards).toEqual([{ productId: 'p', title: 'Sticker', imageId: undefined, sku: '', rows: [{ variantId: null, label: '', sku: '', listPrice: 3, tiers: [] }] }]);
  });

  it('defaults to automatic for products saved before the choice existed', () => {
    expect(TradeDetailsSchema.parse({}).variantDisplay).toBe('auto');
  });
});
