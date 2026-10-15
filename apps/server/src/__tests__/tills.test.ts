import { describe, expect, it } from 'vitest';
import type { CashClosing, CashMovement, Transaction, TseSignature } from '@zollify/shared';
import { tillRegister } from '../modules/dsfinvk/tills';

/** The till register: one row per till serial number, with its device, dates and the TSEs that signed for it. */

const sig = (over: Partial<TseSignature> = {}): TseSignature => ({
  clientId: 'ZOLLIFY-A',
  serial: 'tse-live',
  transactionNumber: 1,
  signatureCounter: 1,
  start: '2026-09-12T10:00:00.000Z',
  finish: '2026-09-12T10:00:01.000Z',
  algorithm: 'fiskaly cloud TSE',
  timeFormat: 'unixTime',
  signature: 'S',
  publicKey: 'P',
  processType: 'Kassenbeleg-V1',
  processData: 'Beleg^10.00_0.00_0.00_0.00_0.00^10.00:Bar',
  ...over,
});
const T0 = Date.parse('2026-09-12T10:00:00Z');
const tx = (over: Partial<Transaction>): Transaction =>
  ({ id: 'x', eventId: 'ev', deviceId: 'dev-1', timestamp: T0, method: 'cash', payments: [{ kind: 'cash', amount: 10 }], items: [], discounts: [], total: 10, currency: 'EUR', ...over }) as Transaction;

describe('till register', () => {
  it('lists each till with its device, first and last receipt, and the TSEs that signed, test ones flagged', () => {
    const sales: Transaction[] = [
      tx({ id: 'a', receipt: { till: 'ZOLLIFY-A', number: 1 }, tse: { signed: sig({ test: true, serial: 'tse-test' }) } }),
      tx({ id: 'b', timestamp: T0 + 86_400_000, receipt: { till: 'ZOLLIFY-A', number: 2 }, tse: { signed: sig() } }),
      // Cancelled a week later on another till, by another device.
      tx({ id: 'c', timestamp: T0 + 1000, deviceId: 'dev-2', receipt: { till: 'ZOLLIFY-B', number: 1 }, revertedAt: T0 + 7 * 86_400_000, revertReceipt: { till: 'ZOLLIFY-B', number: 2 }, revertTse: { signed: sig({ clientId: 'ZOLLIFY-B' }) } }),
      tx({ id: 'old' }), // from before numbering: no till
    ];
    const moves: CashMovement[] = [{ id: 'm', eventId: 'ev', deviceId: 'dev-1', timestamp: T0 - 3600_000, direction: 'in', reason: 'float', amount: 50, currency: 'EUR', receipt: { till: 'ZOLLIFY-A', number: 0 } }];
    const closings: CashClosing[] = [
      { id: 'c1', till: 'ZOLLIFY-A', number: 1, createdAt: T0 + 3600_000, businessDay: '2026-09-12', firstReceipt: 1, lastReceipt: 1, eventId: 'ev', currency: 'EUR', deviceId: 'dev-1', device: { brand: 'Android', model: 'Zollify app', software: 'Zollify', version: '1.0' }, receipts: 1, total: 10, cash: 10 },
      { id: 'c2', till: 'ZOLLIFY-A', number: 2, createdAt: T0 + 2 * 86_400_000, businessDay: '2026-09-13', firstReceipt: 2, lastReceipt: 2, eventId: 'ev', currency: 'EUR', deviceId: 'dev-1', device: { brand: 'myPOS', model: 'Carbon', software: 'Zollify', version: '1.1' }, receipts: 1, total: 10, cash: 10 },
    ];
    const out = tillRegister({ closings, transactions: sales, movements: moves });
    expect(out.map((t) => t.till)).toEqual(['ZOLLIFY-A', 'ZOLLIFY-B']);
    const [a, b] = out;
    expect(a).toMatchObject({ deviceIds: ['dev-1'], device: { model: 'Carbon', version: '1.1' }, firstReceiptAt: T0 - 3600_000, lastReceiptAt: T0 + 86_400_000, receipts: 3, closings: 2 });
    expect(a!.tses.map((s) => [s.serial, s.test, s.signatures])).toEqual([
      ['tse-test', true, 1],
      ['tse-live', false, 1],
    ]);
    expect(b).toMatchObject({ deviceIds: ['dev-2'], device: null, firstReceiptAt: T0 + 1000, lastReceiptAt: T0 + 7 * 86_400_000, receipts: 2, closings: 0 });
    expect(b!.tses).toEqual([expect.objectContaining({ serial: 'tse-live', firstSignedAt: T0 + 7 * 86_400_000, signatures: 1 })]);
  });
});
