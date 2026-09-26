import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot } from '@zollify/sdk';

/** Same stub pattern as core.test.ts - backup reads the signed-in account to namespace its database. */
let account: AccountSnapshot | null = null;

vi.mock('../session', () => ({
  getAccount: () => account,
  onAccountChange: () => () => {},
}));

const OWNER: AccountSnapshot = {
  accountId: 'acct-1',
  accountName: 'Test Booth',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'CHF' },
};

const { deleteCoreDb, openCoreDb } = await import('../core/db');
const { createBackup } = await import('../core/backup');

beforeEach(async () => {
  account = OWNER;
  await deleteCoreDb(OWNER.accountId);

  const db = openCoreDb(OWNER.accountId);
  await db.products.bulkPut([{ id: 'p1', title: 'Pin', forSale: true, unlisted: false, updatedAt: 1 } as never]);
  await db.events.bulkPut([
    { id: 'ev1', name: 'Con A', venue: {}, currency: 'CHF', status: 'planned', updatedAt: 1 } as never,
    { id: 'ev2', name: 'Con B', venue: {}, currency: 'CHF', status: 'planned', updatedAt: 1 } as never,
  ]);
  await db.inventory.bulkPut([
    { productId: 'p1', variantId: '', onHand: 100, updatedAt: 1 },
    { productId: 'p2', variantId: '', onHand: 50, updatedAt: 1 },
  ]);
  await db.eventStock.bulkPut([
    { eventId: 'ev1', productId: 'p1', variantId: '', broughtQty: 10, updatedAt: 1 },
    { eventId: 'ev2', productId: 'p2', variantId: '', broughtQty: 5, updatedAt: 1 },
  ]);
  await db.transactions.bulkPut([
    { id: 'tx1', eventId: 'ev1', deviceId: 'd', timestamp: 1, method: 'cash', payments: [], items: [], discounts: [], total: 10, currency: 'CHF' } as never,
    { id: 'tx2', eventId: 'ev2', deviceId: 'd', timestamp: 1, method: 'cash', payments: [], items: [], discounts: [], total: 5, currency: 'CHF' } as never,
  ]);
});

describe('createBackup', () => {
  it('includes every category by default', async () => {
    const backup = await createBackup();
    expect(backup.products).toHaveLength(1);
    expect(backup.events).toHaveLength(2);
    expect(backup.inventory).toHaveLength(2);
    expect(backup.eventStock).toHaveLength(2);
    expect(backup.transactions).toHaveLength(2);
  });

  it('omits a category the caller unchecked', async () => {
    const backup = await createBackup({ transactions: false, images: false });
    expect(backup.transactions).toHaveLength(0);
    expect(backup.products).toHaveLength(1);
  });

  it('scopes events, event stock and transactions to the selected event', async () => {
    const backup = await createBackup({ eventIds: ['ev1'] });
    expect(backup.events.map((e) => e.id)).toEqual(['ev1']);
    expect(backup.eventStock.map((s) => s.eventId)).toEqual(['ev1']);
    expect(backup.transactions.map((t) => t.id)).toEqual(['tx1']);
  });

  it('narrows inventory to only the stock claimed by the selected event, not the whole booth', async () => {
    // p2 is owned by the booth (in db.inventory) but only ever claimed for ev2 -
    // exporting ev1 alone must not carry it along.
    const backup = await createBackup({ eventIds: ['ev1'] });
    expect(backup.inventory.map((i) => i.productId)).toEqual(['p1']);
  });
});
