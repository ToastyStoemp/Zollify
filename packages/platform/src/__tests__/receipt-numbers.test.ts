import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, SaleEvent } from '@zollify/sdk';

/**
 * Receipt numbers count up per till without gaps or repeats - sales and
 * cancellations alike - and carry on from the highest number used when the
 * counter itself is lost.
 */

const account: AccountSnapshot = {
  accountId: 'acct-numbers',
  accountName: 'Numbers',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'EUR' },
};

vi.mock('../session', () => ({
  getAccount: () => account,
  onAccountChange: () => () => {},
  authFetch: async () => ({}),
}));

const { deleteCoreDb, openCoreDb } = await import('../core/db');
const txs = await import('../core/transactions');
const device = await import('../core/device');
const tse = await import('../core/tse');
const numbers = await import('../core/receipt-numbers');

function sale(): SaleEvent {
  return {
    saleId: crypto.randomUUID(),
    eventId: 'ev-1',
    at: Date.now(),
    currency: 'EUR',
    total: 10,
    lines: [{ productId: 'p1', variantId: null, sku: null, name: 'Print', qty: 1, unitPrice: 10, lineTotal: 10, taxRate: null }],
    payment: { provider: 'manual', approved: true, method: 'cash' },
  };
}

beforeEach(async () => {
  await deleteCoreDb(account.accountId);
  txs.resetTransactionCache();
  device.resetDeviceCache();
  tse.resetTseCache();
});

describe('receipt numbers', () => {
  it('counts up per till, from 1, named after the device', async () => {
    const till = tse.defaultTillId(await device.deviceId());
    expect(till).toMatch(/^ZOLLIFY-[0-9A-F]{8}$/);
    const a = await txs.recordSale(sale());
    const b = await txs.recordSale(sale());
    expect(a.receipt).toEqual({ till, number: 1 });
    expect(b.receipt).toEqual({ till, number: 2 });
  });

  it('gives a cancellation the next number of its own', async () => {
    const a = await txs.recordSale(sale());
    await txs.revertTransaction(a.id);
    const b = await txs.recordSale(sale());
    expect(txs.getTransaction(a.id)?.revertReceipt?.number).toBe(2);
    expect(b.receipt?.number).toBe(3);
  });

  it('names the till after the TSE till serial, and counts each till on its own', async () => {
    await txs.recordSale(sale());
    await tse.setTseSettings({ clientId: 'KASSE-7' });
    expect((await txs.recordSale(sale())).receipt).toEqual({ till: 'KASSE-7', number: 1 });
  });

  it('never repeats a number, also when many are taken at once', async () => {
    const taken = await Promise.all(Array.from({ length: 20 }, () => numbers.nextReceiptNumber()));
    expect(new Set(taken.map((n) => n.number)).size).toBe(20);
    expect(Math.max(...taken.map((n) => n.number))).toBe(20);
  });

  it('carries on from the highest number used if the counter is lost', async () => {
    await txs.recordSale(sale());
    const b = await txs.recordSale(sale());
    await txs.revertTransaction(b.id);
    await openCoreDb(account.accountId).settings.delete('core.receiptCounters');
    expect((await txs.recordSale(sale())).receipt?.number).toBe(4);
  });
});
