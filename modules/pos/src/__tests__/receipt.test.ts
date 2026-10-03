import { describe, expect, it } from 'vitest';
import type { Transaction } from '@zollify/shared';
import { buildReceiptLines } from '../receipt';

/**
 * A sale charged abroad keeps its lines in the booth's book currency and only
 * its total in what the customer paid. The paper has to be in what they paid
 * throughout - lines, total and payment alike.
 */

const sale = (extra: Partial<Transaction> = {}): Transaction => ({
  id: 'tx-0000-1234abcd',
  eventId: 'ev',
  deviceId: 'd',
  timestamp: Date.UTC(2026, 9, 3, 10, 0),
  method: 'cash',
  payments: [{ kind: 'cash', amount: 45 }],
  items: [
    { pid: 'p1', vid: null, title: 'Print', qty: 2, unitPrice: 20, lineTotal: 40 },
    { pid: 'p2', vid: null, title: 'Sticker', qty: 1, unitPrice: 5, lineTotal: 5 },
  ],
  discounts: [],
  total: 45,
  currency: 'CHF',
  ...extra,
});

const text = (tx: Transaction): string[] =>
  buildReceiptLines(tx, 'Con', { artist: {}, logoB64: '', footerText: '' })
    .filter((l) => l.kind === 'text')
    .map((l) => l.text ?? '');

const amountOn = (lines: string[], label: string): string => lines.find((l) => l.includes(label))!.trim().split(/\s{2,}/).pop()!;

describe('printed receipt amounts', () => {
  it('prints a home-currency sale exactly as recorded', () => {
    const lines = text(sale());
    expect(amountOn(lines, '2 x Print')).toBe('CHF 40.00');
    expect(lines).toContain('   à CHF 20.00');
  });

  it('prints a converted sale in the charged currency, lines adding up to the total', () => {
    // CHF 45 of goods charged as a rounded EUR 47.
    const lines = text(sale({ currency: 'EUR', total: 47, baseCurrency: 'CHF', baseTotal: 45, exchangeRate: 1.04, payments: [{ kind: 'cash', amount: 47 }] }));
    const print = amountOn(lines, '2 x Print');
    const sticker = amountOn(lines, '1 x Sticker');
    expect(print).toBe('EUR 41.78');
    expect(sticker).toBe('EUR 5.22');
    expect(lines).toContain('   à EUR 20.89');
    expect(amountOn(lines, 'TOTAL')).toBe('EUR 47.00');
    expect(lines.join('\n')).not.toContain('CHF');
  });

  it('prints a discounted sale as the till showed it: list prices, each discount, the total', () => {
    const lines = text(
      sale({
        // The bundle discount is spread into the stored line totals.
        items: [
          { pid: 'p1', vid: null, title: 'Print', qty: 2, unitPrice: 20, lineTotal: 36.8 },
          { pid: 'p2', vid: null, title: 'Sticker', qty: 1, unitPrice: 5, lineTotal: 4.2 },
        ],
        total: 41,
        payments: [{ kind: 'cash', amount: 41 }],
        asCharged: { listTotals: [40, 5], discounts: [{ name: 'Bundle deal', amount: 4 }] },
      }),
    );
    expect(amountOn(lines, '2 x Print')).toBe('CHF 40.00');
    expect(lines).toContain('   à CHF 20.00');
    expect(amountOn(lines, 'Subtotal')).toBe('CHF 45.00');
    expect(amountOn(lines, 'Bundle deal')).toBe('-CHF 4.00');
    expect(amountOn(lines, 'TOTAL')).toBe('CHF 41.00');
  });

  it('prints a discounted sale abroad at the local prices that were on screen', () => {
    const lines = text(
      sale({
        items: [{ pid: 'p1', vid: null, title: 'Print', qty: 2, unitPrice: 20, lineTotal: 36 }],
        currency: 'EUR',
        total: 38,
        baseCurrency: 'CHF',
        baseTotal: 36,
        payments: [{ kind: 'cash', amount: 38 }],
        asCharged: { listTotals: [42], discounts: [{ name: 'Weekend', amount: 4 }] },
      }),
    );
    expect(amountOn(lines, '2 x Print')).toBe('EUR 42.00');
    expect(lines).toContain('   à EUR 21.00');
    expect(amountOn(lines, 'Weekend')).toBe('-EUR 4.00');
    expect(amountOn(lines, 'TOTAL')).toBe('EUR 38.00');
    expect(lines.join('\n')).not.toContain('CHF');
  });

  it('still adds up for an older discounted sale that recorded no discount names', () => {
    const lines = text(
      sale({
        items: [{ pid: 'p1', vid: null, title: 'Print', qty: 2, unitPrice: 20, lineTotal: 36 }],
        total: 36,
        payments: [{ kind: 'cash', amount: 36 }],
      }),
    );
    expect(amountOn(lines, '2 x Print')).toBe('CHF 40.00');
    expect(amountOn(lines, 'Discount')).toBe('-CHF 4.00');
    expect(amountOn(lines, 'TOTAL')).toBe('CHF 36.00');
  });
});
