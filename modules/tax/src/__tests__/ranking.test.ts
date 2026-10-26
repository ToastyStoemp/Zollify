import { describe, expect, it } from 'vitest';
import type { Product, SalesEvent, Transaction } from '@zollify/shared';
import { deadStock, editionTables, lastAgainstSeries, rankEvents, soldAt, storeRows, toCsv, type EventFigures } from '../ranking';

const ev = (id: string, extra: Partial<SalesEvent> = {}): SalesEvent => ({ id, name: id, venue: {}, currency: 'EUR', status: 'closed', updatedAt: 1, ...extra }) as SalesEvent;
const at = (day: string, h = 12): number => new Date(`${day}T${String(h).padStart(2, '0')}:00:00`).getTime();
let n = 0;
const tx = (eventId: string, day: string, items: { pid: string; vid?: string | null; qty: number; price: number; title?: string }[], extra: Partial<Transaction> = {}): Transaction => {
  const lines = items.map((i) => ({ pid: i.pid, vid: i.vid ?? null, title: i.title ?? i.pid, qty: i.qty, unitPrice: i.price, lineTotal: i.qty * i.price }));
  return { id: `t${++n}`, eventId, deviceId: 'd', timestamp: at(day), method: 'cash', payments: [], items: lines, discounts: [], total: lines.reduce((s, l) => s + l.lineTotal, 0), currency: 'EUR', ...extra } as Transaction;
};
const fig = (revenue: number, expenses = 0, vat = 0, mixed = false): EventFigures => ({ revenue, vat, expenses, mixed });

const events = [
  ev('con-2025', { name: 'FurCon 2025', dateStart: '2025-05-02', dateEnd: '2025-05-04', seriesId: 's1', edition: '2025', venue: { country: 'DE' } }),
  ev('con-2026', { name: 'FurCon 2026', dateStart: '2026-05-01', dateEnd: '2026-05-03', seriesId: 's1', edition: '2026', venue: { country: 'DE' } }),
  ev('small-2025', { name: 'Small Fair 2025', dateStart: '2025-09-20', dateEnd: '2025-09-20' }),
  ev('small-2026', { name: 'Small Fair 2026', dateStart: '2026-09-19', dateEnd: '2026-09-19' }),
  ev('future', { name: 'Next', dateStart: '2027-01-01', dateEnd: '2027-01-02' }),
  ev('shop', { name: 'Shop', kind: 'store' }),
];
const sales = [
  tx('con-2025', '2025-05-02', [{ pid: 'pin', qty: 10, price: 10 }]),
  tx('con-2025', '2025-05-03', [{ pid: 'print', qty: 5, price: 20, title: 'Print' }]),
  tx('con-2026', '2026-05-01', [{ pid: 'pin', qty: 20, price: 10 }, { pid: 'print', qty: 10, price: 20, title: 'Print' }]),
  tx('con-2026', '2026-05-02', [{ pid: 'pin', qty: 2, price: 10 }], { revertedAt: 1 }),
  tx('small-2025', '2025-09-20', [{ pid: 'pin', qty: 3, price: 10 }]),
  tx('small-2026', '2026-09-19', [{ pid: 'sticker', qty: 1, price: 2 }]),
  tx('shop', '2026-09-01', [{ pid: 'pin', qty: 1, price: 10 }]),
  tx('shop', '2026-09-03', [{ pid: 'pin', qty: 1, price: 10 }]),
  // A gift card spent: not goods.
  tx('shop', '2026-09-03', [{ pid: 'module:gift', qty: 1, price: -5, title: 'Gift card' }, { pid: 'print', qty: 1, price: 20, title: 'Print' }]),
];
const figures = new Map<string, EventFigures>([
  ['con-2025', fig(200, 50, 20)],
  ['con-2026', fig(400, 100, 40)],
  ['small-2025', fig(30, 0, 0)],
  ['small-2026', fig(2, 0, 0, true)],
  ['shop', fig(35, 5, 0)],
]);
const TODAY = '2026-10-21';

describe('rankEvents', () => {
  it('ranks past events by profit per day, VAT off, reverted sales out, stores and future events left out', () => {
    const rows = rankEvents(events, sales, figures, TODAY);
    expect(rows.map((r) => r.eventId)).toEqual(['con-2026', 'con-2025', 'small-2025', 'small-2026']);
    expect(rows[0]).toMatchObject({ days: 3, revenue: 360, expenses: 100, profit: 260, perDay: 86.67, units: 30, sales: 1, avgSale: 360, country: 'DE', seriesId: 's1', edition: '2026' });
    expect(rows[1]).toMatchObject({ days: 3, revenue: 180, profit: 130, perDay: 43.33, units: 15, sales: 2, avgSale: 90 });
    // Mixed-currency costs: no profit, revenue per day stands in.
    expect(rows[3]).toMatchObject({ profit: null, perDay: 2, revenue: 2 });
  });

  it('an event with no ledger figures still ranks on its own sales, and an undated one counts the days it sold on', () => {
    const rows = rankEvents([ev('x', { name: 'Pop-up' })], [tx('x', '2026-03-01', [{ pid: 'pin', qty: 1, price: 10 }]), tx('x', '2026-03-02', [{ pid: 'pin', qty: 1, price: 10 }])], new Map(), TODAY);
    expect(rows[0]).toMatchObject({ revenue: 20, days: 2, perDay: 10, profit: 20 });
  });
});

describe('storeRows', () => {
  it('counts a store over a period on the days it sold, goods only', () => {
    const rows = storeRows(events, sales, figures, '2026-09-01', '2026-09-30');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'store', days: 2, units: 3, sales: 3, revenue: 35, profit: 30, perDay: 15 });
  });
});

describe('editionTables', () => {
  it('groups editions by series, or by name without the year, oldest first with the change against the one before', () => {
    const tables = editionTables(rankEvents(events, sales, figures, TODAY));
    expect(tables.map((t) => t.name)).toEqual(['Small Fair 2026', 'FurCon 2026']);
    const fur = tables[1]!;
    expect(fur.editions.map((e) => e.edition)).toEqual(['2025', '2026']);
    expect(fur.editions[0]).toMatchObject({ revenueChange: null, profitChange: null });
    expect(fur.editions[1]).toMatchObject({ revenueChange: 1, profitChange: 1, perDayChange: 1 });
    expect(fur.avgPerDay).toBe(65);
    // The unlinked fair pairs up by name; its 2026 edition has no profit, so no profit change.
    expect(tables[0]!.editions[1]).toMatchObject({ revenueChange: -0.93, profitChange: null });
  });
});

describe('soldAt', () => {
  it('lists items and types by revenue with their share, settling lines left out', () => {
    const products = new Map<string, Product>([
      ['pin', { id: 'pin', title: 'Pin', type: 'Pins', price: 10, variants: [] } as unknown as Product],
      ['print', { id: 'print', title: 'Print', type: 'Prints', price: 20, variants: [] } as unknown as Product],
    ]);
    const r = soldAt('con-2026', sales, products);
    expect(r.items.map((i) => [i.title, i.units, i.revenue, i.share])).toEqual([['pin', 20, 200, 0.5], ['Print', 10, 200, 0.5]]);
    expect(r.types.map((t) => t.title)).toEqual(['Pins', 'Prints']);
    const shop = soldAt('shop', sales, products);
    // Equal revenue: more units first.
    expect(shop.items.map((i) => i.title)).toEqual(['pin', 'Print']);
    expect(shop.items.reduce((s, i) => s + i.share, 0)).toBe(1);
  });
});

describe('deadStock', () => {
  const products = [
    { id: 'pin', title: 'Pin', type: 'Pins', price: 10, cost: 2, variants: [] },
    { id: 'print', title: 'Print', type: 'Prints', price: 20, variants: [{ id: 'a4', name: 'A4', price: 20 }, { id: 'a3', name: 'A3', price: 30, cost: 8 }] },
    { id: 'old', title: 'Old mug', type: 'Mugs', price: 15, variants: [] },
    { id: 'gone', title: 'Sold out thing', price: 5, variants: [] },
  ] as unknown as Product[];
  const counts: Record<string, number> = { 'pin:': 50, 'print:a4': 4, 'print:a3': 2, 'old:': 10, 'gone:': 0 };
  const stock = (pid: string, vid: string | null): number => counts[`${pid}:${vid ?? ''}`] ?? 0;

  it('finds items on hand that sold at none of the last N events nor in the last N months', () => {
    const rows = deadStock(products, events, sales, stock, { lastEvents: 2, months: 3, today: TODAY });
    // The pin sold at the shop in September and the print at FurCon 2026 (one of the last two events); A4/A3 never sold as variants.
    expect(rows.map((r) => r.title)).toEqual(['Old mug', 'Print · A4', 'Print · A3']);
    expect(rows[0]).toMatchObject({ inStock: 10, value: 150, valuedAt: 'price', lastSold: '' });
    expect(rows[2]).toMatchObject({ value: 16, valuedAt: 'cost' });
  });

  it('with a short window nearly everything is dead; with a long one nothing is', () => {
    expect(deadStock(products, events, sales, stock, { lastEvents: 0, months: 0, today: TODAY }).map((r) => r.title)).toContain('Pin');
    expect(deadStock(products, events, sales, stock, { lastEvents: 10, months: 24, today: TODAY }).map((r) => r.title)).toEqual(['Old mug', 'Print · A4', 'Print · A3']);
  });
});

describe('lastAgainstSeries', () => {
  it('names the last event that is over and its series average without it', () => {
    const r = lastAgainstSeries(rankEvents(events, sales, figures, TODAY), TODAY)!;
    expect(r.last.eventId).toBe('small-2026');
    expect(r.seriesName).toBe('Small Fair 2026');
    expect(r.seriesAvg).toBe(30);
    expect(lastAgainstSeries([], TODAY)).toBeNull();
  });
});

describe('toCsv', () => {
  it('writes a header and quotes what needs it', () => {
    expect(toCsv([{ key: 'name', label: 'Name' }, { key: 'n', label: 'N' }], [{ name: 'A, b', n: 1.5 }])).toBe('Name,N\n"A, b",1.5');
  });
});
