import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, SaleEvent } from '@zollify/sdk';

/**
 * Test mode: the till sells into the test event, and everything it does is
 * kept apart from the real sales - recorded, numbered and synced, but never
 * counted as takings. Stock moves while it runs and is put back after.
 */

const account: AccountSnapshot = {
  accountId: 'acct-test-mode',
  accountName: 'Test Booth',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'CHF' },
};

let pullResponses: unknown[] = [];
const fakeFetch = async (path: string) => {
  if (path.startsWith('/sync/push')) return { accepted: 0, duplicates: 0, latestSeq: 0 };
  return pullResponses.shift() ?? { ops: [], latestSeq: 0 };
};

vi.mock('../session', () => ({
  getAccount: () => account,
  getDeviceAccount: () => account,
  personSession: () => null,
  onAccountChange: () => () => {},
  authFetch: (path: string) => fakeFetch(path),
  authFetchAs: (_as: string | null, path: string) => fakeFetch(path),
  deviceFetch: (path: string) => fakeFetch(path),
}));

const { deleteCoreDb } = await import('../core/db');
const catalog = await import('../core/catalog');
const events = await import('../core/sales-events');
const tx = await import('../core/transactions');
const inv = await import('../core/inventory');
const outbox = await import('../core/outbox');
const device = await import('../core/device');
const sync = await import('../core/sync');
const testMode = await import('../core/test-mode');
const { resetTestState, testState } = await import('../core/test-state');

const PRINT = 'p-print';
const SHOP = 'ev-shop';

async function sell(eventId: string, qty: number, saleId: string = crypto.randomUUID()): Promise<void> {
  const sale: SaleEvent = {
    saleId,
    eventId,
    at: Date.now(),
    currency: 'CHF',
    total: 40 * qty,
    lines: [{ productId: PRINT, variantId: null, sku: null, name: 'Harbour print', qty, unitPrice: 40, lineTotal: 40 * qty, taxRate: null }],
    payment: { provider: 'manual', approved: true, method: 'cash' },
  };
  await tx.recordSale(sale);
}

const remaining = () => inv.remainingFor(PRINT, '');
const opTypes = async () => (await outbox.unsyncedOps()).map((o) => o.type);

beforeEach(async () => {
  pullResponses = [];
  await deleteCoreDb(account.accountId);
  catalog.resetCatalogCache();
  events.resetSalesEventCache();
  tx.resetTransactionCache();
  inv.resetInventoryCache();
  device.resetDeviceCache();
  resetTestState();
  await catalog.upsertProduct({ id: PRINT, title: 'Harbour print', price: 40, forSale: true, unlisted: false, variants: [], sortOrder: 0, updatedAt: Date.now() } as never);
  await events.upsertSalesEvent({ id: SHOP, name: 'Harbour shop', venue: { country: 'CH' }, currency: 'CHF', localCurrency: 'EUR', exchangeRate: 1.05, status: 'active', updatedAt: 1 });
  await events.loadSalesEvents();
  await events.setActiveEvent(SHOP);
  await tx.loadTransactions();
  await inv.loadInventory();
});

describe('switching test mode on', () => {
  it('makes a test event like the one being sold at, and sells into it', async () => {
    const made = await testMode.startTestMode();
    expect(made).toMatchObject({ name: 'Test event', test: true, noPool: true, currency: 'CHF', localCurrency: 'EUR', exchangeRate: 1.05, venue: { country: 'CH' } });
    expect(events.activeEvent.value?.id).toBe(made.id);
    expect(events.activeEventId.value).toBe(made.id);
    // Never offered as an event of its own.
    expect(events.visibleEvents.value.map((e) => e.id)).toEqual([SHOP]);
  });

  it('reuses the test event, and goes back to the real one when switched off', async () => {
    const first = await testMode.startTestMode();
    await testMode.stopTestMode();
    expect(events.activeEvent.value?.id).toBe(SHOP);
    const second = await testMode.startTestMode();
    expect(second.id).toBe(first.id);
  });
});

describe('a sale in test mode', () => {
  it('is recorded and synced as a test, numbered apart, and never counted as takings', async () => {
    await sell(SHOP, 1, 'real-1');
    const testEvent = await testMode.startTestMode();
    await sell(testEvent.id, 2, 'test-1');

    const made = tx.getTransaction('test-1')!;
    expect(made.testRun).toBe(testState.run);
    expect(made.receiptNumber).toMatch(/^TEST-[0-9A-F]+-0001$/);
    expect(tx.getTransaction('real-1')!.receiptNumber).toMatch(/^[0-9A-F]+-0001$/);
    expect(await opTypes()).toContain('tx.test.create');
    expect((await outbox.unsyncedOps()).filter((o) => o.type === 'tx.create')).toHaveLength(1);

    expect(tx.recentTransactions.value.map((t) => t.id)).toEqual(['real-1']);
    expect(tx.testTransactions.value.map((t) => t.id)).toEqual(['test-1']);
    expect(tx.transactionsOfEvent(testEvent.id).map((t) => t.id)).toEqual(['test-1']);
    expect(tx.totalsFor()).toEqual([{ currency: 'CHF', sales: 1, gross: 40, reverted: 0 }]);
  });

  it('is reverted as a test', async () => {
    const testEvent = await testMode.startTestMode();
    await sell(testEvent.id, 1, 'test-1');
    await tx.revertTransaction('test-1');
    expect(await opTypes()).toContain('tx.test.revert');
    expect(await opTypes()).not.toContain('tx.revert');
  });
});

describe('stock in test mode', () => {
  it('moves with test sales and comes back when test mode is switched off', async () => {
    await inv.setOnHand(PRINT, '', 10);
    const testEvent = await testMode.startTestMode();
    await sell(testEvent.id, 3);
    expect(remaining()).toBe(7);

    await testMode.stopTestMode();
    expect(remaining()).toBe(10);
    expect(await opTypes()).toContain('tx.test.end');
  });

  it('puts counts and claims back as they were, keeping real sales made meanwhile', async () => {
    await inv.setOnHand(PRINT, '', 10);
    await inv.setClaim(SHOP, PRINT, '', 4);
    const testEvent = await testMode.startTestMode();
    await new Promise((r) => setTimeout(r, 5));
    await inv.setOnHand(PRINT, '', 25);
    await inv.setClaim(SHOP, PRINT, '', 9);
    await inv.setClaim(testEvent.id, PRINT, '', 5);
    await sell(testEvent.id, 2);
    await sell(SHOP, 1);

    const { restored } = await testMode.stopTestMode();
    expect(restored).toBe(3);
    // The count from before the test, less the real sale since.
    expect(inv.onHandFor(PRINT, '')).toBe(9);
    expect(remaining()).toBe(9);
    expect(inv.claimFor(SHOP, PRINT, '')).toBe(4);
    expect(inv.claimFor(testEvent.id, PRINT, '')).toBeNull();
  });

  it('leaves alone what changed again after the test run wrote it', async () => {
    await inv.setOnHand(PRINT, '', 10);
    await testMode.startTestMode();
    await inv.setOnHand(PRINT, '', 25);
    // Someone else counts again; this device is no longer the last to have written it.
    testState.on = false;
    await new Promise((r) => setTimeout(r, 5));
    await inv.setOnHand(PRINT, '', 30);
    testState.on = true;

    await testMode.stopTestMode();
    expect(inv.onHandFor(PRINT, '')).toBe(30);
  });
});

describe('clearing test data', () => {
  it('removes every test sale here and tells the other devices', async () => {
    await sell(SHOP, 1, 'real-1');
    const testEvent = await testMode.startTestMode();
    await sell(testEvent.id, 1, 'test-1');
    await testMode.clearTestData();
    expect(tx.testTransactions.value).toHaveLength(0);
    expect(tx.getTransaction('real-1')).toBeTruthy();
    expect(await opTypes()).toContain('tx.test.clear');

    tx.resetTransactionCache();
    await tx.loadTransactions();
    expect(tx.testTransactions.value).toHaveLength(0);
  });
});

describe('test ops from other devices', () => {
  const testSale = (id: string, timestamp: number, run = 'run-b') => ({
    id,
    eventId: 'ev-test',
    deviceId: 'other',
    timestamp,
    method: 'cash',
    payments: [{ kind: 'cash', amount: 40 }],
    items: [{ pid: PRINT, vid: null, title: 'Harbour print', qty: 1, unitPrice: 40, lineTotal: 40 }],
    discounts: [],
    total: 40,
    currency: 'CHF',
    testRun: run,
  });
  const op = (seq: number, type: string, payload: unknown) => ({ opId: `op-${seq}-${'x'.repeat(16)}`, deviceId: 'other', ts: seq, type, payload, serverSeq: seq });

  it('keeps their test sales apart, stops counting a run once it ends, and drops them on a clear', async () => {
    await inv.setOnHand(PRINT, '', 10);
    const now = Date.now() + 1000;
    pullResponses = [{ ops: [op(1, 'tx.test.create', testSale('t-1', now))], latestSeq: 1 }];
    await sync.syncNow();
    expect(tx.testTransactions.value.map((t) => t.id)).toEqual(['t-1']);
    expect(tx.recentTransactions.value).toHaveLength(0);
    expect(remaining()).toBe(9);

    pullResponses = [{ ops: [op(2, 'tx.test.end', { run: 'run-b', at: now })], latestSeq: 2 }];
    await sync.syncNow();
    expect(remaining()).toBe(10);

    pullResponses = [{ ops: [op(3, 'tx.test.clear', { at: now + 1 }), op(4, 'tx.test.create', testSale('t-late', now))], latestSeq: 4 }];
    await sync.syncNow();
    // Cleared, and a sale made before the clear that syncs after it stays gone.
    expect(tx.testTransactions.value).toHaveLength(0);
  });
});
