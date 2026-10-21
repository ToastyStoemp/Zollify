import { describe, expect, it } from 'vitest';
import type { EventStock, Product, SalesEvent, Transaction } from '@zollify/shared';
import { buildCarnetList, carnetCsv, defaultCarnetState, generalListHtml, readCarnetState, returnCheckHtml } from '../engine';

const event = { id: 'ev', name: 'LondonCon', venue: { country: 'GB' }, currency: 'EUR', status: 'closed', updatedAt: 1, dateStart: '2026-09-05', dateEnd: '2026-09-06' } as SalesEvent;
const products = [
  { id: 'pin', title: 'Fox pin', type: 'Pins', sku: 'PIN-1', price: 10, cost: 2, weightG: 12, material: 'Zinc alloy', originCountry: 'CN', variants: [], sortOrder: 1, forSale: true, unlisted: false, updatedAt: 1 },
  { id: 'print', title: 'Forest', type: 'Prints', price: 25, weightG: 30, year: 2025, variants: [{ id: 'a4', name: 'A4', price: 25, weightG: 30 }, { id: 'a3', name: 'A3', price: 40, cost: 8 }], sortOrder: 2, forSale: true, unlisted: false, updatedAt: 1 },
  { id: 'plush', title: 'Plush', type: 'Plush', price: 30, variants: [], sortOrder: 3, forSale: true, unlisted: false, updatedAt: 1 },
] as unknown as Product[];
const stock: EventStock[] = [
  { eventId: 'ev', productId: 'pin', variantId: '', broughtQty: 50, updatedAt: 1 },
  { eventId: 'ev', productId: 'print', variantId: 'a4', broughtQty: 10, updatedAt: 1 },
  { eventId: 'ev', productId: 'print', variantId: 'a3', broughtQty: 5, updatedAt: 1 },
  { eventId: 'other', productId: 'plush', variantId: '', broughtQty: 3, updatedAt: 1 },
];
const tx = (id: string, eventId: string, items: { pid: string; vid: string | null; qty: number; price: number }[], reverted = false): Transaction =>
  ({ id, eventId, deviceId: 'd', timestamp: 1, method: 'cash', payments: [], discounts: [], currency: 'EUR', items: items.map((i) => ({ pid: i.pid, vid: i.vid, title: i.pid, qty: i.qty, unitPrice: i.price, lineTotal: i.qty * i.price })), total: items.reduce((s, i) => s + i.qty * i.price, 0), ...(reverted ? { revertedAt: 2 } : {}) }) as Transaction;
const sales = [
  tx('s1', 'ev', [{ pid: 'pin', vid: null, qty: 20, price: 10 }, { pid: 'print', vid: 'a4', qty: 2, price: 25 }]),
  tx('s2', 'ev', [{ pid: 'pin', vid: null, qty: 5, price: 10 }], true),
  tx('s3', 'ev', [{ pid: 'print', vid: 'a3', qty: 9, price: 40 }]),
  tx('s4', 'elsewhere', [{ pid: 'pin', vid: null, qty: 100, price: 10 }]),
];

describe('buildCarnetList', () => {
  it('numbers what the event claims, by type, with weight, value, origin, sold and due back', () => {
    const list = buildCarnetList(event, products, stock, sales, defaultCarnetState(), 'DE');
    expect(list.rows.map((r) => [r.no, r.description, r.pieces, r.weightKg, r.value, r.origin, r.sold, r.returning])).toEqual([
      [1, 'Fox pin · Zinc alloy', 50, 0.6, 500, 'CN', 20, 30],
      [2, 'Forest · A4 · 2025', 10, 0.3, 250, 'DE', 2, 8],
      // Sold more than brought: only what crossed counts. A variant without a weight takes the product's.
      [3, 'Forest · A3 · 2025', 5, 0.15, 200, 'DE', 5, 0],
    ]);
    expect(list.totals).toEqual({ pieces: 65, weightKg: 1.05, value: 950, sold: 27, soldValue: 450, returning: 38 });
    expect(list.issues).toEqual([]);
    const bare = buildCarnetList(event, [{ ...products[2]!, price: 0 }], [{ eventId: 'ev', productId: 'plush', variantId: '', broughtQty: 2, updatedAt: 1 }], [], defaultCarnetState(), 'DE');
    expect(bare.issues).toEqual(['Plush: no weight.', 'Plush: no value.']);
    expect(list.currency).toBe('EUR');
  });

  it('values at cost when asked and a cost is known, else at price', () => {
    const list = buildCarnetList(event, products, stock, sales, { ...defaultCarnetState(), valueBasis: 'cost' }, 'DE');
    expect(list.rows.map((r) => [r.valuedAt, r.unitValue])).toEqual([['cost', 2], ['price', 25], ['cost', 8]]);
  });

  it('counts sales at combined events toward the same list', () => {
    const list = buildCarnetList(event, products, stock, sales, { ...defaultCarnetState(), combinedEventIds: ['elsewhere'] }, 'DE');
    expect(list.rows[0]).toMatchObject({ sold: 50, returning: 0 });
  });
});

describe('documents', () => {
  const meta = { holder: 'Ink & Charcoal', eventName: 'LondonCon', dateStart: '2026-09-05', dateEnd: '2026-09-06', countries: 'GB' };
  it('the CSV has the six columns and a total', () => {
    const csv = carnetCsv(buildCarnetList(event, products, stock, sales, defaultCarnetState(), 'DE'));
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Item No,Trade description of goods and marks and numbers,Number of pieces,Weight (kg),Value (EUR),Country of origin');
    expect(lines[1]).toBe('1,Fox pin · Zinc alloy [PIN-1],50,0.600,500.00,CN');
    expect(lines[lines.length - 1]).toBe(',TOTAL,65,1.050,950.00,');
  });
  it('the general list and return check are self-contained pages that escape what they print', () => {
    const state = { ...defaultCarnetState(), number: 'DE/B 12345', validUntil: '2027-09-01', notes: '<b>not html</b>' };
    const list = buildCarnetList(event, [{ ...products[0]!, title: 'Fox <pin>' }], stock, sales, state, 'DE');
    const html = generalListHtml(list, state, meta);
    expect(html).toContain('Fox &lt;pin&gt;');
    expect(html).toContain('Carnet DE/B 12345');
    expect(html).toContain('&lt;b&gt;not html&lt;/b&gt;');
    expect(html).not.toContain('<b>not html');
    const back = returnCheckHtml(list, state, meta);
    expect(back).toContain('Due back');
    expect(back).toContain('>30<');
  });
  it('reads the state off an event without trusting its shape', () => {
    expect(readCarnetState({ carnet: { number: 'X', countries: ['GB', 7], valueBasis: 'nope', combinedEventIds: 'no' } } as never)).toMatchObject({ number: 'X', countries: ['GB'], valueBasis: 'price', combinedEventIds: [] });
    expect(readCarnetState({})).toEqual(defaultCarnetState());
  });
});
