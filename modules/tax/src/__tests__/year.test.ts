import { describe, expect, it } from 'vitest';
import type { SalesEvent, Transaction } from '@zollify/shared';
import { yearChange, yearReview, yearsWithData, type YearExpense } from '../year';

/** A year's figures from sales, the ledger's costs, and nothing typed in. */

const ev = (id: string, extra: Partial<SalesEvent> = {}): SalesEvent => ({ id, name: id, venue: {}, currency: 'EUR', status: 'closed', updatedAt: 1, ...extra }) as SalesEvent;
const at = (day: string): number => new Date(`${day}T12:00:00`).getTime();
let n = 0;
const tx = (eventId: string, day: string, items: { pid: string; vid?: string | null; qty: number; price: number; title?: string; variantLabel?: string }[], extra: Partial<Transaction> = {}): Transaction => {
  const lines = items.map((i) => ({ pid: i.pid, vid: i.vid ?? null, title: i.title ?? i.pid, ...(i.variantLabel ? { variantLabel: i.variantLabel } : {}), qty: i.qty, unitPrice: i.price, lineTotal: i.qty * i.price }));
  return { id: `t${++n}`, eventId, deviceId: 'd', timestamp: at(day), method: 'cash', payments: [], items: lines, discounts: [], total: lines.reduce((s, l) => s + l.lineTotal, 0), currency: 'EUR', ...extra } as Transaction;
};
const exp = (eventId: string, date: string, category: string, amount: number, currency = 'EUR'): YearExpense => ({ eventId, date, category, amount, currency });

const events = [ev('con', { name: 'FurCon 2026', dateStart: '2026-05-01', dateEnd: '2026-05-03' }), ev('fair', { name: 'Small Fair' }), ev('shop', { name: 'Shop', kind: 'store' })];
const sales = [
  tx('con', '2026-05-01', [{ pid: 'pin', qty: 20, price: 10 }, { pid: 'print', qty: 10, price: 20, title: 'Harbour', variantLabel: 'A3' }]),
  tx('con', '2026-05-02', [{ pid: 'pin', qty: 2, price: 10 }], { revertedAt: 1 }),
  tx('fair', '2026-09-19', [{ pid: 'sticker', qty: 1, price: 2 }]),
  tx('fair', '2026-09-19', [{ pid: 'sticker', qty: 1, price: 0 }], { method: 'free' }),
  tx('shop', '2026-12-31', [{ pid: 'pin', qty: 1, price: 10 }], { tax: { rates: [19] } } as Partial<Transaction>),
  tx('con', '2025-05-03', [{ pid: 'pin', qty: 5, price: 10 }]),
  tx('se', '2026-07-10', [{ pid: 'pin', qty: 3, price: 100 }], { currency: 'SEK', baseCurrency: 'EUR', baseTotal: 27, exchangeRate: 11.11 }),
];
const costs = [exp('con', '2026-04-20', 'booth', 150), exp('con', '2026-05-01', 'food', 15), exp('', '2026-01-10', 'insurance', 60), exp('con', '2025-04-20', 'booth', 120), exp('fair', '2026-09-19', 'booth', 300, 'CHF')];

describe('a year in review', () => {
  const review = yearReview(2026, events, sales, costs);
  const eur = review.blocks[0]!;

  it('adds up the year, VAT off and reverted sales out', () => {
    // 400 (con) + 2 (fair) + 0 (given away) + 10 − 1.60 VAT (shop) + 27 (SEK sale as booked) = 437.40
    expect(eur.currency).toBe('EUR');
    expect(eur.revenue).toBe(437.4);
    expect(eur.vat).toBe(1.6);
    expect(eur.sales).toBe(5);
    expect(eur.units).toBe(36);
    expect(eur.givenAway).toBe(1);
    expect(eur.byMonth[4]).toBe(400);
    expect(eur.byMonth[11]).toBe(8.4);
  });

  it('costs are the ledger\'s, by the date paid, by category', () => {
    expect(eur.expenses).toBe(225);
    expect(eur.byCategory).toEqual({ booth: 150, food: 15, insurance: 60 });
    expect(eur.profit).toBe(212.4);
  });

  it('ranks the events by profit and names the sellers', () => {
    expect(eur.events.map((e) => [e.name, e.revenue, e.expenses, e.profit])).toEqual([
      ['FurCon 2026', 400, 165, 235],
      ['se', 27, 0, 27],
      ['Shop', 8.4, 0, 8.4],
      ['Small Fair', 2, 0, 2],
    ]);
    expect(eur.events.find((e) => e.name === 'Shop')?.kind).toBe('store');
    expect(eur.products.slice(0, 2)).toEqual([
      { key: 'pin:', title: 'pin', units: 24, revenue: 237 },
      { key: 'print:', title: 'Harbour · A3', units: 10, revenue: 200 },
    ]);
  });

  it('keeps another currency apart', () => {
    expect(review.blocks).toHaveLength(2);
    expect(review.blocks[1]).toMatchObject({ currency: 'CHF', revenue: 0, expenses: 300, profit: -300, events: [{ name: 'Small Fair', expenses: 300 }] });
  });

  it('knows which years have anything, and how one compares to the last', () => {
    expect(yearsWithData(sales, costs, '2026-10-27')).toEqual([2026, 2025]);
    expect(yearsWithData([], [], '2024-01-01')).toEqual([2024]);
    const last = yearReview(2025, events, sales, costs).blocks[0]!;
    expect(last).toMatchObject({ revenue: 50, expenses: 120, profit: -70 });
    expect(yearChange(eur.revenue, last.revenue)).toBe(7.75);
    expect(yearChange(10, 0)).toBeNull();
    expect(yearChange(10, undefined)).toBeNull();
  });
});
