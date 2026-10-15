import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, SaleEvent } from '@zollify/sdk';

/**
 * Closings: every receipt a till takes ends up in exactly one closing, made
 * by the till itself when the day, event or currency changes, at start-up
 * on a new day, or by hand.
 */

const account: AccountSnapshot = {
  accountId: 'acct-closings',
  accountName: 'Closings',
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

const DAY1 = new Date(2026, 8, 3, 12).getTime();
const DAY2 = new Date(2026, 8, 4, 12).getTime();

function sale(at: number, over: Partial<SaleEvent> = {}): SaleEvent {
  return {
    saleId: crypto.randomUUID(),
    eventId: 'ev-1',
    at,
    currency: 'EUR',
    total: 10,
    lines: [{ productId: 'p1', variantId: null, sku: null, name: 'Print', qty: 1, unitPrice: 10, lineTotal: 10, taxRate: null }],
    payment: { provider: 'manual', approved: true, method: 'cash' },
    ...over,
  };
}

beforeEach(async () => {
  await deleteCoreDb(account.accountId);
  txs.resetTransactionCache();
  device.resetDeviceCache();
  tse.resetTseCache();
  closings.resetClosingCache();
});

describe('closings', () => {
  it('closes the day when the next receipt is on another day, covering every receipt of the day', async () => {
    const a = await txs.recordSale(sale(DAY1));
    await txs.recordSale(sale(DAY1 + 1000, { payment: { provider: 'manual', approved: true, method: 'card' } }));
    expect(closings.allClosings()).toHaveLength(0);
    await txs.revertTransaction(a.id);
    // The cancellation was taken "now", on another day than DAY1, so it closed DAY1 first.
    const [first] = closings.allClosings();
    expect(first).toMatchObject({ number: 1, businessDay: '2026-09-03', firstReceipt: 1, lastReceipt: 2, receipts: 2, total: 20, cash: 10, currency: 'EUR', eventId: 'ev-1' });
  });

  it('closes when the event or the currency changes', async () => {
    await txs.recordSale(sale(DAY1));
    await txs.recordSale(sale(DAY1, { eventId: 'ev-2' }));
    await txs.recordSale(sale(DAY1, { eventId: 'ev-2', currency: 'CHF' }));
    const list = closings.allClosings().sort((x, y) => x.number - y.number);
    expect(list.map((c) => [c.number, c.eventId, c.currency, c.firstReceipt, c.lastReceipt])).toEqual([
      [1, 'ev-1', 'EUR', 1, 1],
      [2, 'ev-2', 'EUR', 2, 2],
    ]);
    // Synced like any other record.
    const ops = await openCoreDb(account.accountId).ops.toArray();
    expect(ops.filter((o) => o.type === 'closing.create')).toHaveLength(2);
  });

  it('closes yesterday at start-up, and by hand only when there is something to close', async () => {
    await txs.recordSale(sale(DAY1));
    expect(await closings.closeStaleDay(DAY1 + 3600_000)).toBeNull();
    expect(await closings.closeStaleDay(DAY2)).toMatchObject({ number: 1, lastReceipt: 1 });
    expect(await closings.closeTillNow()).toBeNull();
    await txs.recordSale(sale(DAY2));
    expect(await closings.openReceipts()).toBe(1);
    expect(await closings.closeTillNow()).toMatchObject({ number: 2, firstReceipt: 2, lastReceipt: 2, businessDay: '2026-09-04' });
    expect(await closings.openReceipts()).toBe(0);
  });
});
