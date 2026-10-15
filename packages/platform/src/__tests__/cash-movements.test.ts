import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, SaleEvent } from '@zollify/sdk';

/**
 * Cash movements: the float, money put in or taken out, cash to the bank.
 * Each is a receipt of its own on the till, synced like a sale, and counted
 * into the day's closing so the box can be explained.
 */

const account: AccountSnapshot = {
  accountId: 'acct-cash',
  accountName: 'Cash',
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
const closings = await import('../core/closings');
const cash = await import('../core/cash-movements');

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
  closings.resetClosingCache();
  cash.resetCashMovementCache();
});

describe('cash movements', () => {
  it('are numbered as receipts on the till, in one series with the sales, and synced', async () => {
    const till = await tse.tillId();
    const float = await cash.recordCashMovement({ eventId: 'ev-1', reason: 'float', amount: 50, currency: 'EUR' });
    const a = await txs.recordSale(sale());
    const out = await cash.recordCashMovement({ eventId: 'ev-1', reason: 'bank', amount: 20.5, currency: 'EUR', note: 'Evening run' });
    expect(float).toMatchObject({ direction: 'in', reason: 'float', amount: 50, receipt: { till, number: 1 } });
    expect(a.receipt).toEqual({ till, number: 2 });
    expect(out).toMatchObject({ direction: 'out', amount: 20.5, note: 'Evening run', receipt: { till, number: 3 }, by: { userId: 'u-1' } });
    expect(out.tse).toBeUndefined(); // the event is not in Germany
    const ops = await openCoreDb(account.accountId).ops.toArray();
    expect(ops.filter((o) => o.type === 'cash.move').map((o) => (o.payload as { id: string }).id)).toEqual([float.id, out.id]);
    expect(cash.cashMovementsFor('ev-1').map((m) => m.id)).toEqual([out.id, float.id]);
    expect(cash.cashMovementTotals('ev-1', 'EUR')).toEqual({ float: 50, moved: -20.5 });
  });

  it('count into the closing: receipts and cash, not turnover', async () => {
    await cash.recordCashMovement({ eventId: 'ev-1', reason: 'float', amount: 50, currency: 'EUR' });
    await txs.recordSale(sale());
    await cash.recordCashMovement({ eventId: 'ev-1', reason: 'withdrawal', amount: 15, currency: 'EUR' });
    expect(await closings.closeTillNow()).toMatchObject({ firstReceipt: 1, lastReceipt: 3, receipts: 3, total: 10, cash: 45 });
  });

  it('refuse nonsense, and take a synced one only once', async () => {
    await expect(cash.recordCashMovement({ eventId: 'ev-1', reason: 'float', amount: 0, currency: 'EUR' })).rejects.toThrow(/amount/);
    await expect(cash.recordCashMovement({ eventId: '', reason: 'float', amount: 5, currency: 'EUR' })).rejects.toThrow(/event/);
    const m = await cash.recordCashMovement({ eventId: 'ev-1', reason: 'deposit', amount: 5, currency: 'EUR' });
    cash.resetCashMovementCache();
    await cash.loadCashMovements();
    expect(cash.cashMovements.value).toHaveLength(1);
    expect(await cash.applyCashMovement(m)).toBe(0);
    expect(await cash.applyCashMovement({ ...m, id: 'other' })).toBe(1);
    // A lost counter carries on past a movement's number too.
    await openCoreDb(account.accountId).settings.delete('core.receiptCounters');
    expect((await txs.recordSale(sale())).receipt?.number).toBe(2);
  });
});
