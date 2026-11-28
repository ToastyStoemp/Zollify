import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, SaleEvent } from '@zollify/sdk';

/**
 * A change and its outbox op are one write. Android can kill the WebView
 * between two separate writes; a sale stored without its op would never sync.
 * The kill is stood in for by the outbox refusing the row.
 */

const account: AccountSnapshot = {
  accountId: 'acct-atomic',
  accountName: 'Atomic Booth',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'CHF' },
};

vi.mock('../session', () => ({
  getAccount: () => account,
  onAccountChange: () => () => {},
  authFetch: async () => ({}),
}));

const { deleteCoreDb, openCoreDb } = await import('../core/db');
const tx = await import('../core/transactions');
const catalog = await import('../core/catalog');
const events = await import('../core/sales-events');
const device = await import('../core/device');
const outbox = await import('../core/outbox');

function sale(saleId: string): SaleEvent {
  return {
    saleId,
    eventId: 'ev-1',
    at: Date.now(),
    currency: 'CHF',
    total: 35,
    lines: [{ productId: 'p1', sku: 'ANCH', name: 'Anchor print', qty: 1, unitPrice: 35, lineTotal: 35, taxRate: null }],
    payment: { provider: 'manual', approved: true, txRef: 'ref-1' },
  };
}

const failEnqueue = (): never => {
  throw new Error('outbox write failed');
};
/** Makes every outbox insert fail, as if the write was cut off before the op landed. */
function breakOutbox(): void {
  openCoreDb(account.accountId).ops.hook('creating', failEnqueue);
}

const opTypes = async (): Promise<string[]> => (await openCoreDb(account.accountId).ops.toArray()).map((op) => op.type);

beforeEach(async () => {
  await deleteCoreDb(account.accountId);
  tx.resetTransactionCache();
  catalog.resetCatalogCache();
  events.resetSalesEventCache();
  device.resetDeviceCache();
});

afterEach(() => {
  openCoreDb(account.accountId).ops.hook('creating').unsubscribe(failEnqueue);
});

describe('a change and its outbox op', () => {
  it('stores a sale together with its op', async () => {
    await tx.recordSale(sale('s1'));

    const db = openCoreDb(account.accountId);
    expect(await db.transactions.get('s1')).toBeDefined();
    const ops = await db.ops.toArray();
    expect(ops.map((op) => op.type)).toEqual(['tx.create']);
    // The op carries the sale as stored, receipt number and all.
    expect(ops[0]!.payload).toEqual(await db.transactions.get('s1'));
    expect(outbox.pendingCount.value).toBe(1);
  });

  it('stores no sale when its op cannot be queued, and does not use up a receipt number', async () => {
    breakOutbox();

    await expect(tx.recordSale(sale('s1'))).rejects.toThrow('outbox write failed');

    const db = openCoreDb(account.accountId);
    expect(await db.transactions.get('s1')).toBeUndefined();
    expect(tx.getTransaction('s1')).toBeUndefined();
    expect(await db.settings.get('core.receiptSeq')).toBeUndefined();
    expect(await opTypes()).toEqual([]);
  });

  it('leaves a sale unreverted when the revert op cannot be queued', async () => {
    await tx.recordSale(sale('s1'));
    breakOutbox();

    await expect(tx.revertTransaction('s1')).rejects.toThrow('outbox write failed');

    expect((await openCoreDb(account.accountId).transactions.get('s1'))?.revertedAt).toBeUndefined();
    expect(tx.getTransaction('s1')?.revertedAt).toBeUndefined();
    expect(await opTypes()).toEqual(['tx.create']);
  });

  it('stores a revert together with its op', async () => {
    await tx.recordSale(sale('s1'));
    await tx.revertTransaction('s1');

    expect((await openCoreDb(account.accountId).transactions.get('s1'))?.revertedAt).toBeGreaterThan(0);
    expect(await opTypes()).toEqual(['tx.create', 'tx.revert']);
  });

  it('stores no product when its op cannot be queued', async () => {
    breakOutbox();

    await expect(catalog.upsertProduct({ id: 'p1', title: 'Anchor print', price: 5, forSale: true, unlisted: false } as never)).rejects.toThrow('outbox write failed');

    expect(await openCoreDb(account.accountId).products.get('p1')).toBeUndefined();
    expect(catalog.getProduct('p1')).toBeUndefined();
  });
});
