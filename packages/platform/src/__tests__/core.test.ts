import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot } from '@zollify/sdk';

/**
 * Core reads the signed-in account to namespace its database and to scope what
 * a helper can see, so the session module is stubbed rather than driven through
 * a real login.
 */
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
};

const HELPER: AccountSnapshot = {
  ...OWNER,
  userId: 'u-2',
  email: 'helper@example.com',
  role: 'member',
  allowedEventIds: ['ev-allowed'],
};

const { deleteCoreDb } = await import('../core/db');
const catalog = await import('../core/catalog');
const events = await import('../core/sales-events');
const outbox = await import('../core/outbox');

function product(id: string, title: string, price = 10) {
  return { id, title, price, forSale: true, unlisted: false, updatedAt: Date.now() } as never;
}

function salesEvent(id: string, name: string) {
  return {
    id,
    name,
    venue: {},
    currency: 'CHF',
    status: 'planned',
    updatedAt: Date.now(),
  } as never;
}

beforeEach(async () => {
  account = OWNER;
  await deleteCoreDb(OWNER.accountId);
  catalog.resetCatalogCache();
  events.resetSalesEventCache();
});

describe('catalog', () => {
  it('persists products and reads them back sorted by title', async () => {
    await catalog.upsertProduct(product('p2', 'Zebra badge'));
    await catalog.upsertProduct(product('p1', 'Anchor print'));

    catalog.resetCatalogCache();
    await catalog.loadCatalog();

    expect(catalog.allProducts.value.map((p) => p.title)).toEqual(['Anchor print', 'Zebra badge']);
  });

  it('soft-deletes rather than removing the row', async () => {
    // Sync is last-write-wins, so a hard delete would simply be resurrected by
    // any device that still held the row.
    await catalog.upsertProduct(product('p1', 'Anchor print'));
    await catalog.deleteProduct('p1');

    catalog.resetCatalogCache();
    await catalog.loadCatalog();

    expect(catalog.allProducts.value).toHaveLength(0);
    const { openCoreDb } = await import('../core/db');
    const row = await openCoreDb(OWNER.accountId).products.get('p1');
    expect(row?.deletedAt).toBeGreaterThan(0);
  });

  it('records an outbox op for every mutation', async () => {
    await catalog.upsertProduct(product('p1', 'Anchor print'));
    await catalog.deleteProduct('p1');

    const pending = await outbox.unsyncedOps();
    expect(pending.map((op) => op.type)).toEqual([
      'product.upsert',
      'product.delete',
    ]);
  });

  it('refuses to touch storage while signed out', async () => {
    account = null;
    await expect(catalog.upsertProduct(product('p1', 'Anchor print'))).rejects.toThrow(
      /signed out/i,
    );
  });
});

describe('sales events', () => {
  it('shows every event to an unrestricted user', async () => {
    await events.upsertSalesEvent(salesEvent('ev-allowed', 'Spring market'));
    await events.upsertSalesEvent(salesEvent('ev-other', 'Autumn fair'));

    expect(events.visibleEvents.value).toHaveLength(2);
  });

  it('shows a helper only their allowed events', async () => {
    await events.upsertSalesEvent(salesEvent('ev-allowed', 'Spring market'));
    await events.upsertSalesEvent(salesEvent('ev-other', 'Autumn fair'));

    account = HELPER;

    expect(events.visibleEvents.value.map((e) => e.id)).toEqual(['ev-allowed']);
  });

  it('refuses to activate an event the user cannot see', async () => {
    await events.upsertSalesEvent(salesEvent('ev-other', 'Autumn fair'));
    account = HELPER;

    await expect(events.setActiveEvent('ev-other')).rejects.toThrow(/not available/i);
  });

  it('clears the active event when it is deleted', async () => {
    // Otherwise the till stays pointed at an event that no longer exists.
    await events.upsertSalesEvent(salesEvent('ev-allowed', 'Spring market'));
    await events.setActiveEvent('ev-allowed');
    expect(events.activeEventId.value).toBe('ev-allowed');

    await events.deleteSalesEvent('ev-allowed');

    expect(events.activeEventId.value).toBeNull();
  });

  it('does not restore an active event that has since gone', async () => {
    await events.upsertSalesEvent(salesEvent('ev-allowed', 'Spring market'));
    await events.setActiveEvent('ev-allowed');

    const { openCoreDb } = await import('../core/db');
    await openCoreDb(OWNER.accountId).events.clear();

    events.resetSalesEventCache();
    await events.loadSalesEvents();

    expect(events.activeEventId.value).toBeNull();
  });
});

describe('outbox', () => {
  it('marks ops synced without deleting them', async () => {
    await catalog.upsertProduct(product('p1', 'Anchor print'));
    const [op] = await outbox.unsyncedOps();

    await outbox.markSynced([(op as unknown as { seq: number }).seq]);

    expect(await outbox.unsyncedOps()).toHaveLength(0);
    expect(outbox.pendingCount.value).toBe(0);
  });
});
