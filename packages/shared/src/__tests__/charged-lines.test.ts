import { describe, expect, it } from 'vitest';
import type { TxItem } from '../types';
import { chargedLineTotals, receiptBreakdown } from '../charged-lines';

const item = (lineTotal: number, qty = 1): TxItem => ({ pid: 'p', vid: null, title: 't', qty, unitPrice: lineTotal / qty, lineTotal });

describe('chargedLineTotals', () => {
  it('leaves a sale in the book currency alone', () => {
    expect(chargedLineTotals({ items: [item(40, 2), item(5)], total: 45, currency: 'CHF', discounts: [] })).toEqual([40, 5]);
  });

  it('shows a converted sale in what the customer paid, adding up exactly', () => {
    // CHF 40 + 5 charged as a rounded EUR 47.
    const out = chargedLineTotals({ items: [item(40, 2), item(5)], total: 47, currency: 'EUR', baseCurrency: 'CHF', baseTotal: 45, discounts: [] });
    expect(out).toEqual([41.78, 5.22]);
    expect(Math.round(out.reduce((a, b) => a + b, 0) * 100)).toBe(4700);
  });

  it('puts the rounding remainder on one line, not a stray cent everywhere', () => {
    const out = chargedLineTotals({ items: [item(10), item(10), item(10)], total: 50, currency: 'EUR', baseCurrency: 'CHF', baseTotal: 30, discounts: [] });
    expect(Math.round(out.reduce((a, b) => a + b, 0) * 100)).toBe(5000);
    expect(out.filter((v) => v === 16.67)).toHaveLength(2);
  });

  it('keeps separately listed discounts out of the lines', () => {
    const out = chargedLineTotals({ items: [item(20), item(20)], total: 38, currency: 'EUR', baseCurrency: 'CHF', baseTotal: 40, discounts: [{ name: 'Bundle', amount: 4 }] });
    expect(out).toEqual([21, 21]);
  });

  it('treats a missing base total as unconverted rather than dividing by zero', () => {
    expect(chargedLineTotals({ items: [item(12)], total: 12, currency: 'EUR', baseCurrency: 'CHF', baseTotal: 0, discounts: [] })).toEqual([12]);
  });
});

describe('receiptBreakdown', () => {
  it('uses the till snapshot as shown: list prices, named discounts', () => {
    const out = receiptBreakdown({
      items: [item(36, 2), item(5)], // lines already carry the spread discount
      total: 41,
      currency: 'CHF',
      discounts: [],
      asCharged: { listTotals: [40, 5], discounts: [{ name: 'Bundle deal', amount: 4 }] },
    });
    expect(out).toEqual({ lines: [40, 5], discounts: [{ name: 'Bundle deal', amount: 4 }] });
  });

  it('keeps hand-set local prices exactly, rather than rescaling book prices', () => {
    const out = receiptBreakdown({
      items: [item(40, 2), item(5)],
      total: 47,
      currency: 'EUR',
      baseCurrency: 'CHF',
      baseTotal: 45,
      discounts: [],
      asCharged: { listTotals: [42, 5], discounts: [] },
    });
    expect(out.lines).toEqual([42, 5]);
  });

  it('brings back an unrecorded spread discount as one line, so the receipt adds up', () => {
    const out = receiptBreakdown({ items: [{ ...item(36, 2), unitPrice: 20 }, item(5)], total: 41, currency: 'CHF', discounts: [] });
    expect(out).toEqual({ lines: [40, 5], discounts: [{ name: 'Discount', amount: 4 }] });
  });

  it('does the same in the charged currency for a converted sale', () => {
    // CHF 40 list less CHF 4 = CHF 36 of goods, charged as EUR 38.
    const out = receiptBreakdown({ items: [{ ...item(36, 2), unitPrice: 20 }], total: 38, currency: 'EUR', baseCurrency: 'CHF', baseTotal: 36, discounts: [] });
    const lines = Math.round(out.lines.reduce((a, b) => a + b, 0) * 100);
    const off = Math.round(out.discounts.reduce((a, d) => a + d.amount, 0) * 100);
    expect(lines - off).toBe(3800);
    expect(out.discounts[0]!.amount).toBe(4.22);
  });

  it('leaves separately listed (older) discounts as they were', () => {
    const out = receiptBreakdown({ items: [item(20), item(20)], total: 36, currency: 'CHF', discounts: [{ name: 'Fair', amount: 4 }] });
    expect(out).toEqual({ lines: [20, 20], discounts: [{ name: 'Fair', amount: 4 }] });
  });

  it('has nothing to add for an undiscounted sale', () => {
    expect(receiptBreakdown({ items: [item(40, 2)], total: 40, currency: 'CHF', discounts: [] })).toEqual({ lines: [40], discounts: [] });
  });
});
