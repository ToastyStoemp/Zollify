import { describe, expect, it } from 'vitest';
import type { Transaction, TxItem } from '../types';
import { type ConsignorStatement, commissionFor, consignmentLines, consignmentStatements, isStore } from '../consignment';

const item = (pid: string, lineTotal: number, consignorId?: string, qty = 1): TxItem => ({
  pid,
  vid: null,
  title: pid,
  qty,
  unitPrice: lineTotal / qty,
  lineTotal,
  ...(consignorId ? { consignorId } : {}),
});
const tx = (id: string, eventId: string, items: TxItem[], extra: Partial<Transaction> = {}): Transaction => ({
  id,
  eventId,
  deviceId: 'd',
  timestamp: 1,
  method: 'cash',
  payments: [],
  items,
  discounts: [],
  total: items.reduce((s, i) => s + i.lineTotal, 0),
  currency: 'CHF',
  ...extra,
});

const ana = { id: 'ana', commissionPct: 40, storeCommission: { zurich: 30 } };
const ben = { id: 'ben', commissionPct: 35, storeCommission: {} };

describe('consignment', () => {
  it('tells a store from an event', () => {
    expect(isStore({ kind: 'store' })).toBe(true);
    expect(isStore({ kind: 'event' })).toBe(false);
    expect(isStore({})).toBe(false);
  });

  it('uses a per-store commission over the default', () => {
    expect(commissionFor(ana, 'zurich')).toBe(30);
    expect(commissionFor(ana, 'bern')).toBe(40);
  });

  it('splits only consigned lines, at the store they sold in', () => {
    const lines = consignmentLines(
      [tx('t1', 'bern', [item('own', 10), item('print', 25, 'ana', 1)]), tx('t2', 'zurich', [item('print', 50, 'ana', 2)])],
      [ana, ben],
    );
    expect(lines.map((l) => [l.storeId, l.gross, l.commission, l.artistShare])).toEqual(
      expect.arrayContaining([
        ['bern', 25, 10, 15],
        ['zurich', 50, 15, 35],
      ]),
    );
    expect(lines).toHaveLength(2);
  });

  it('uses a split set on the line itself over the artist commission', () => {
    const l = consignmentLines([tx('t1', 'zurich', [{ ...item('workshop:w1', 90, 'ana', 2), commissionPct: 30 }])], [ana])[0]!;
    expect([l.commissionPct, l.commission, l.artistShare]).toEqual([30, 27, 63]);
  });

  it('leaves reverted sales and unknown artists out', () => {
    const lines = consignmentLines(
      [tx('t1', 'bern', [item('a', 20, 'ana')], { revertedAt: 5 }), tx('t2', 'bern', [item('b', 20, 'ghost')])],
      [ana],
    );
    expect(lines).toEqual([]);
  });

  it('books a converted sale in the base currency', () => {
    const line = consignmentLines(
      [tx('t1', 'bern', [item('a', 20, 'ben')], { currency: 'EUR', total: 21, baseCurrency: 'CHF', baseTotal: 20 })],
      [ben],
    )[0]!;
    expect(line.currency).toBe('CHF');
    expect(line.gross).toBe(20);
  });

  it('rounds commission per line to the cent and keeps the split exact', () => {
    const line = consignmentLines([tx('t1', 'bern', [item('a', 9.99, 'ben')])], [ben])[0]!;
    expect(line.commission).toBe(3.5);
    expect(Math.round((line.commission + line.artistShare) * 100)).toBe(999);
  });

  it('balances what was earned across stores against payouts', () => {
    const lines = consignmentLines(
      [tx('t1', 'bern', [item('a', 25, 'ana')]), tx('t2', 'zurich', [item('a', 50, 'ana', 2)])],
      [ana, ben],
    );
    const [a, b] = consignmentStatements(lines, [{ consignorId: 'ana', amount: 20, currency: 'CHF' }], ['ana', 'ben']) as [ConsignorStatement, ConsignorStatement];
    expect(a.byStore.map((s) => [s.storeId, s.units, s.artistShare])).toEqual([
      ['bern', 1, 15],
      ['zurich', 2, 35],
    ]);
    expect(a.totals).toEqual([{ currency: 'CHF', units: 3, gross: 75, commission: 25, artistShare: 50, paid: 20, rent: 0, fees: 0, cardFees: 0, balance: 30 }]);
    expect(b).toEqual({ consignorId: 'ben', byStore: [], totals: [] });
  });

  it('shows a payout ahead of sales as a negative balance', () => {
    const s = consignmentStatements([], [{ consignorId: 'ana', amount: 10, currency: 'EUR' }], ['ana'])[0]!;
    expect(s.totals[0]).toMatchObject({ currency: 'EUR', paid: 10, balance: -10 });
  });

  it('keeps the VAT rate each line sold at, none for an exempt or untaxed sale', () => {
    const taxed = tx('t1', 'bern', [item('own', 10), item('riso', 35, 'ana'), item('mug', 20, 'ben')], { tax: { country: 'BE', exempt: false, rates: [21, 6, 21] } });
    const exempt = tx('t2', 'bern', [item('riso', 35, 'ana')], { tax: { country: 'BE', exempt: true, rates: [null] } });
    const untaxed = tx('t3', 'bern', [item('riso', 35, 'ana')]);
    const lines = consignmentLines([taxed, exempt, untaxed], [ana, ben]);
    expect(lines.map((l) => [l.txId, l.productId, l.taxRate])).toEqual(expect.arrayContaining([['t1', 'riso', 6], ['t1', 'mug', 21], ['t2', 'riso', null], ['t3', 'riso', null]]));
  });
});

describe('VAT split of an artist share', () => {
  it('takes the VAT out of the share per rate and lists untaxed lines apart', async () => {
    const { vatSplit } = await import('../consignment');
    const lines = [
      { taxRate: 6, artistShare: 24.5 },
      { taxRate: 6, artistShare: 24.5 },
      { taxRate: 21, artistShare: 12.1 },
      { taxRate: null, artistShare: 5 },
    ];
    expect(vatSplit(lines, (l) => l.artistShare)).toEqual([
      { rate: 21, gross: 12.1, net: 10, vat: 2.1 },
      { rate: 6, gross: 49, net: 46.23, vat: 2.77 },
      { rate: null, gross: 5, net: 5, vat: 0 },
    ]);
  });

  it('rounds once per rate so the parts add up to the share', async () => {
    const { vatSplit } = await import('../consignment');
    const rows = vatSplit([{ taxRate: 6, artistShare: 0.33 }, { taxRate: 6, artistShare: 0.33 }, { taxRate: 6, artistShare: 0.33 }], (l) => l.artistShare);
    expect(rows).toHaveLength(1);
    expect(Math.round((rows[0]!.net + rows[0]!.vat) * 100)).toBe(99);
    expect(vatSplit([], () => 0)).toEqual([]);
  });
});

describe('shared item prices', () => {
  const pricing = { rate: 1.07, rounding: 0, overrides: {} as Record<string, number> };
  it('keeps the price when the currencies match, converts and rounds when not', async () => {
    const { sharedPrice } = await import('../consignment');
    expect(sharedPrice(30, 'p:', true, pricing)).toBe(30);
    expect(sharedPrice(30, 'p:', false, pricing)).toBe(32.1);
    expect(sharedPrice(30, 'p:', false, { ...pricing, rounding: 5 })).toBe(30);
    expect(sharedPrice(33, 'p:', false, { ...pricing, rounding: 5 })).toBe(35);
  });
  it('has no price without a rate, and an override always wins', async () => {
    const { sharedPrice } = await import('../consignment');
    expect(sharedPrice(30, 'p:', false, { ...pricing, rate: null })).toBeNull();
    expect(sharedPrice(30, 'p:', false, { ...pricing, rate: null, overrides: { 'p:': 29.9 } })).toBe(29.9);
  });
});
