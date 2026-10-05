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
    expect(a.totals).toEqual([{ currency: 'CHF', units: 3, gross: 75, commission: 25, artistShare: 50, paid: 20, balance: 30 }]);
    expect(b).toEqual({ consignorId: 'ben', byStore: [], totals: [] });
  });

  it('shows a payout ahead of sales as a negative balance', () => {
    const s = consignmentStatements([], [{ consignorId: 'ana', amount: 10, currency: 'EUR' }], ['ana'])[0]!;
    expect(s.totals[0]).toMatchObject({ currency: 'EUR', paid: 10, balance: -10 });
  });
});
