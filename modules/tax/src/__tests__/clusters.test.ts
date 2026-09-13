import { describe, expect, it } from 'vitest';
import * as eng from '../engine/clusters';
import { parseSheet } from '../engine/parse';
import type { MatchedEvent, Txn } from '../engine/types';

const day = (d: string, h = 12): number => new Date(`${d}T${String(h).padStart(2, '0')}:00:00`).getTime();
let n = 0;
const pay = (d: string, amount: number, terminal = 'GO2', h = 12): Txn => ({
  id: `t${++n}`, at: day(d, h), type: 'Payment', amount, currency: 'EUR', terminal, card: 'Visa', ref: `R${n}`, desc: '', source: 'mypos',
});
const fee = (d: string, amount: number, terminal = 'GO2'): Txn => ({ ...pay(d, -Math.abs(amount), terminal), type: 'Fee' });

const ev = (id: string, s: string, e: string, country = 'Germany'): MatchedEvent => ({ id, name: `Con ${id}`, dateStart: s, dateEnd: e, country });

describe('clustering', () => {
  it('splits a device into runs separated by more than a day and a half', () => {
    const cs = eng.assignIds(eng.clusterTxns([pay('2026-03-06', 10), pay('2026-03-07', 20), pay('2026-03-14', 30), pay('2026-03-15', 40)]));
    expect(cs.map((c) => [c.clusterID, c.totalPay])).toEqual([
      ['PN_2026_03_002', 70],
      ['PN_2026_03_001', 30],
    ]);
  });

  it('keeps fees with their cluster and nets them', () => {
    const [c] = eng.clusterTxns([pay('2026-03-06', 100), fee('2026-03-06', 1.5)]);
    expect(c!.totalPay).toBe(100);
    expect(c!.totalFee).toBe(1.5);
    expect(c!.net).toBe(98.5);
  });

  it('groups online orders per month with a fixed ONL id', () => {
    const online = { ...pay('2026-03-06', 42, 'Shopify Online'), isOnline: true, source: 'shopify' as const };
    const cs = eng.mergeIn([], [online, pay('2026-03-06', 10)]);
    expect(cs.map((c) => c.clusterID).sort()).toEqual(['PN_2026_03_001', 'PN_2026_03_ONL']);
  });

  it('re-importing the same file adds nothing twice', () => {
    const rows = [pay('2026-03-06', 10), pay('2026-03-07', 20)];
    const once = eng.mergeIn([], rows);
    const twice = eng.mergeIn(once, rows.map((t) => ({ ...t, id: `${t.id}-again` })));
    expect(twice).toHaveLength(1);
    expect(twice[0]!.txns).toHaveLength(2);
  });

  it('splits at a date and merges back', () => {
    const cs = eng.mergeIn([], [pay('2026-03-06', 10), pay('2026-03-07', 20)]);
    const split = eng.splitAtDate(cs, cs[0]!.uid, '2026-03-07')!;
    expect(split.map((c) => c.totalPay)).toEqual([20, 10]);
    const merged = eng.mergeTwo(split, split[0]!.uid, split[1]!.uid);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.totalPay).toBe(30);
    expect(eng.splitAtDate(cs, cs[0]!.uid, '2026-03-01')).toBeNull();
  });
});

describe('matching', () => {
  it('suggests the event starting the same day before any overlap', () => {
    const [c] = eng.mergeIn([], [pay('2026-03-07', 10), pay('2026-03-08', 10)]);
    const events = [ev('a', '2026-03-05', '2026-03-09'), ev('b', '2026-03-07', '2026-03-08')];
    expect(eng.suggestEvent(c!, events)?.id).toBe('b');
  });

  it('auto merge & match joins terminals at one event and leaves ambiguity alone', () => {
    const cs = eng.mergeIn([], [pay('2026-03-07', 10, 'GO2'), pay('2026-03-07', 20, 'Carbon'), pay('2026-04-04', 5, 'GO2')]);
    const events = [ev('a', '2026-03-06', '2026-03-08'), ev('x', '2026-04-03', '2026-04-05'), ev('y', '2026-04-04', '2026-04-06')];
    const r = eng.autoMergeAndMatch(cs, events);
    expect(r.merged).toBe(1);
    expect(r.ambiguous).toBe(1);
    const a = r.clusters.find((c) => c.matchedEvent?.id === 'a')!;
    expect(a.devices).toEqual(['Carbon', 'GO2']);
    expect(a.totalPay).toBe(30);
    expect(a.customName).toBe('Con a');
  });
});

describe('booking payloads', () => {
  it('books a German event with domestic VAT and a foreign one at zero', () => {
    const cs = eng.mergeIn([], [pay('2026-03-07', 100)]);
    const de = eng.matchTo(cs[0]!, ev('a', '2026-03-07', '2026-03-08', 'Germany'));
    const p = eng.revenuePayload(de, {}, 19)!;
    expect(p.voucherNumber).toBe('PN_2026_03_001_P');
    expect(p.event?.vatRate).toBe(19);
    expect(p.customerName).toBe('Revenue - Con a');
    expect(p.remark).toBe('Point of Sales - Con a - Germany');
    const at = eng.matchTo(cs[0]!, ev('b', '2026-03-07', '2026-03-08', 'Austria'));
    expect(eng.revenuePayload(at, {}, 19)!.event?.vatRate).toBe(0);
  });

  it('applies the account templates and drops separators left by empty tokens', () => {
    const cs = eng.mergeIn([], [pay('2026-03-07', 100)]);
    const c = { ...cs[0]!, customName: 'Leipzig' };
    const p = eng.revenuePayload(c, { LEXWARE_EVENT_DESC_TEMPLATE: '[event_name] - [event_country] - [month]' }, 19)!;
    expect(p.remark).toBe('Leipzig - March 2026');
  });

  it('needs a name for a POS cluster and none for online', () => {
    const cs = eng.mergeIn([], [pay('2026-03-07', 100)]);
    expect(eng.revenuePayload(cs[0]!, {}, 19)).toBeNull();
    expect(eng.ready(cs[0]!)).toBe(false);
    const online = eng.mergeIn([], [{ ...pay('2026-03-07', 42), isOnline: true, source: 'shopify' }]);
    expect(eng.revenuePayload(online[0]!, {}, 19)?.voucherNumber).toBe('PN_2026_03_ONL_P');
  });

  it('books a month of fees as one voucher', () => {
    const cs = eng.mergeIn([], [pay('2026-03-07', 100), fee('2026-03-07', 1.1), pay('2026-03-20', 50), fee('2026-03-20', 0.55)]);
    const p = eng.feesPayload('2026_03', cs, {})!;
    expect(p.kind).toBe('fees');
    expect(p.totalGrossAmount).toBe(1.65);
    expect(p.voucherNumber).toBe('PN_2026_03_F');
    expect(p.remark).toBe('myPOS fees March 2026');
  });
});

describe('file parsing', () => {
  it('reads a myPOS transaction export, reclassifying negative payments as fees', () => {
    const raw = [
      ['Some title'],
      ['Type', 'Date initiated', 'Amount', 'Currency', 'Terminal name', 'Description', 'Transaction reference'],
      ['Payment', '07.03.2026 14:05', '25,00', 'EUR', 'GO2 booth', 'Sale TID 1234', 'A1'],
      ['Payment', '07.03.2026 14:05', '-0,30', 'EUR', 'GO2 booth', 'Fee TID 1234', 'A1F'],
    ];
    const names = {};
    const { format, txns } = parseSheet(raw, names);
    expect(format).toBe('mypos-export');
    expect(txns.map((t) => [t.type, t.amount])).toEqual([['Payment', 25], ['Fee', -0.3]]);
    expect(names).toEqual({ '1234': 'GO2 booth' });
  });

  it('names statement rows from the TIDs a previous export taught it', () => {
    const raw = [
      ['Type', 'Ordered via', 'TID', 'Value date', 'Credit', 'Debit', 'myPOS reference', 'Description'],
      ['Payment', 'myPOS', '1234', '07.03.2026', '25,00', '', 'M1', ''],
      ['Fee', 'System', '1234', '07.03.2026', '', '0,30', 'M1', ''],
      ['Transfer', 'Bank', '', '07.03.2026', '500', '', 'X', ''],
    ];
    const { format, txns } = parseSheet(raw, { '1234': 'GO2 booth' });
    expect(format).toBe('mypos-statement');
    expect(txns).toHaveLength(2);
    expect(txns[0]!.terminal).toBe('GO2 booth');
    expect(txns[1]!.amount).toBe(-0.3);
  });

  it('reads Shopify orders once per order and tells online from POS', () => {
    const raw = [
      ['Name', 'Financial Status', 'Paid at', 'Total', 'Refunded Amount', 'Currency', 'Source', 'Location', 'Payment Method', 'Lineitem name'],
      ['#1', 'paid', '2026-03-07 10:00:00 +0100', '40', '0', 'EUR', 'web', 'Online Store', 'paypal', 'Print A'],
      ['#1', '', '', '', '', '', '', '', '', 'Print B'],
      ['#2', 'paid', '2026-03-07 11:00:00 +0100', '15', '5', 'EUR', 'pos', 'Booth', 'manual', 'Pin'],
    ];
    const { format, txns } = parseSheet(raw, {});
    expect(format).toBe('shopify');
    expect(txns.map((t) => [t.orderNum, t.amount, t.isOnline, t.isManual])).toEqual([
      ['#1', 40, true, false],
      ['#2', 10, false, true],
    ]);
  });
});
