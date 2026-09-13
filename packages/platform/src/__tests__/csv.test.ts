import { describe, expect, it } from 'vitest';
import type { Transaction } from '@zollify/shared';
import { csvFilename, transactionsToCsv } from '../core/csv';

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 's1',
    eventId: 'ev-1',
    deviceId: 'dev-1',
    timestamp: 1_700_000_000_000,
    method: 'cash',
    payments: [{ kind: 'cash', amount: 10, provider: 'manual', txRef: 'r1' }],
    items: [{ pid: 'p1', vid: null, title: 'Print', qty: 1, unitPrice: 10, lineTotal: 10 }],
    discounts: [],
    total: 10,
    currency: 'CHF',
    ...over,
  } as Transaction;
}

function rows(csv: string): string[] {
  return csv.split('\r\n');
}

describe('transactionsToCsv', () => {
  it('writes a header and one row per line item', () => {
    // Per item, not per sale: collapsing a basket into one row throws away
    // what was actually sold, which is the point of the export.
    const csv = transactionsToCsv([
      tx({
        items: [
          { pid: 'p1', vid: null, title: 'A', qty: 1, unitPrice: 5, lineTotal: 5 },
          { pid: 'p2', vid: 'v1', title: 'B', qty: 2, unitPrice: 3, lineTotal: 6 },
        ],
      }),
    ]);

    const lines = rows(csv);
    expect(lines[0]).toContain('sale_id');
    expect(lines).toHaveLength(3);
  });

  it('orders oldest first, unlike the History screen', () => {
    const csv = transactionsToCsv([
      tx({ id: 'newer', timestamp: 2000 }),
      tx({ id: 'older', timestamp: 1000 }),
    ]);

    const lines = rows(csv);
    expect(lines[1]).toContain('older');
    expect(lines[2]).toContain('newer');
  });

  it('neutralises spreadsheet formulas', () => {
    // Excel and Sheets execute a leading =, +, - or @. A product genuinely
    // named "=Sale" must not run when the file is opened.
    const csv = transactionsToCsv([
      tx({ items: [{ pid: 'p', vid: null, title: '=SUM(A1:A9)', qty: 1, unitPrice: 1, lineTotal: 1 }] }),
    ]);

    expect(csv).toContain("'=SUM(A1:A9)");
    expect(csv).not.toMatch(/,=SUM/);
  });

  it('quotes fields containing commas, quotes or newlines', () => {
    const csv = transactionsToCsv([
      tx({ items: [{ pid: 'p', vid: null, title: 'Print, "large"', qty: 1, unitPrice: 1, lineTotal: 1 }] }),
    ]);

    expect(csv).toContain('"Print, ""large"""');
  });

  it('keeps reverted sales in the file', () => {
    // An accountant needs to see the refund, not a gap where a sale used to be.
    const csv = transactionsToCsv([tx({ id: 'gone', revertedAt: 1_700_000_100_000 })]);

    expect(csv).toContain('gone');
    expect(csv).toContain('2023-11-14T22:15:00.000Z');
  });

  it('carries the conversion columns for a converted sale', () => {
    const csv = transactionsToCsv([
      tx({ currency: 'SEK', total: 108, baseCurrency: 'CHF', baseTotal: 10, exchangeRate: 10.8 }),
    ]);

    expect(csv).toContain('SEK');
    expect(csv).toContain('CHF');
    expect(csv).toContain('10.8');
  });

  it('writes an empty file with only a header when there is nothing to export', () => {
    expect(rows(transactionsToCsv([]))).toHaveLength(1);
  });
});

describe('csvFilename', () => {
  it('names the scope and sorts by date', () => {
    expect(csvFilename('Zurich Comic Con')).toMatch(/^zollify-sales-zurich-comic-con-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csvFilename(null)).toMatch(/^zollify-sales-all-events-/);
  });
});
