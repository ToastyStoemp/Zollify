import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot } from '@zollify/sdk';

const account: AccountSnapshot = {
  accountId: 'acct-sync',
  accountName: 'Sync Booth',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '' }, defaultCurrency: 'CHF' },
};

/** Requests the fake server has seen, so tests can assert on ordering. */
const calls: { path: string; body?: unknown }[] = [];
let pushResponse: unknown = { accepted: 0, duplicates: 0, latestSeq: 0 };
let failPush = false;
let pullResponses: unknown[] = [];

vi.mock('../session', () => ({
  getAccount: () => account,
  onAccountChange: () => () => {},
  authFetch: async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.startsWith('/sync/push')) {
      if (failPush) throw new Error('network down');
      return pushResponse;
    }
    return pullResponses.shift() ?? { ops: [], latestSeq: 0 };
  },
}));

const { deleteCoreDb, openCoreDb } = await import('../core/db');
const catalog = await import('../core/catalog');
const events = await import('../core/sales-events');
const outbox = await import('../core/outbox');
const sync = await import('../core/sync');
const device = await import('../core/device');

function product(id: string, title: string, updatedAt: number) {
  return { id, title, price: 5, forSale: true, unlisted: false, updatedAt } as never;
}

beforeEach(async () => {
  calls.length = 0;
  pullResponses = [];
  pushResponse = { accepted: 0, duplicates: 0, latestSeq: 0 };
  failPush = false;
  await deleteCoreDb(account.accountId);
  catalog.resetCatalogCache();
  events.resetSalesEventCache();
  device.resetDeviceCache();
});

describe('sync', () => {
  it('pushes before it pulls', async () => {
    // A device must get its own work to the server before adopting anyone
    // else's, or a slow client can have unsent changes overwritten by a pull it
    // triggered itself.
    await catalog.upsertProduct(product('p1', 'Anchor print', 1000));

    await sync.syncNow();

    expect(calls.map((c) => c.path.split('?')[0])).toEqual(['/sync/push', '/sync/pull']);
  });

  it('sends wire ops without local bookkeeping columns', async () => {
    await catalog.upsertProduct(product('p1', 'Anchor print', 1000));

    await sync.syncNow();

    const body = calls[0]?.body as { ops: Record<string, unknown>[] };
    expect(body.ops).toHaveLength(1);
    expect(body.ops[0]).toHaveProperty('opId');
    expect(body.ops[0]).toHaveProperty('deviceId');
    expect(body.ops[0]).not.toHaveProperty('synced');
    expect(body.ops[0]).not.toHaveProperty('seq');
  });

  it('marks the outbox synced once the server has the ops', async () => {
    await catalog.upsertProduct(product('p1', 'Anchor print', 1000));
    expect(await outbox.unsyncedOps()).toHaveLength(1);

    await sync.syncNow();

    expect(await outbox.unsyncedOps()).toHaveLength(0);
  });

  it('applies a newer incoming product and ignores a stale one', async () => {
    // upsertProduct stamps updatedAt with Date.now(), so incoming fixtures are
    // anchored to now too - a peer's clock is in the same era, not in 1970.
    await catalog.upsertProduct(product('p1', 'Local title', 0));
    const localAt = (await openCoreDb(account.accountId).products.get('p1'))!.updatedAt!;

    pullResponses = [
      {
        ops: [
          { opId: 'a'.repeat(16), deviceId: 'other', ts: 1, serverSeq: 1, type: 'product.upsert', payload: product('p1', 'Newer title', localAt + 1000) },
          { opId: 'b'.repeat(16), deviceId: 'other', ts: 1, serverSeq: 2, type: 'product.upsert', payload: product('p2', 'Stale', 500) },
          { opId: 'c'.repeat(16), deviceId: 'other', ts: 1, serverSeq: 3, type: 'product.upsert', payload: product('p2', 'Winner', 900) },
        ],
        latestSeq: 3,
      },
    ];

    await sync.syncNow();

    const db = openCoreDb(account.accountId);
    expect((await db.products.get('p1'))?.title).toBe('Newer title');
    // Last-write-wins on updatedAt, regardless of arrival order.
    expect((await db.products.get('p2'))?.title).toBe('Winner');
  });

  it('skips op types this build does not understand', async () => {
    // A newer device on the account may emit types this build has never heard
    // of; refusing the whole batch would be worse than ignoring them.
    pullResponses = [
      {
        ops: [
          { opId: 'd'.repeat(16), deviceId: 'other', ts: 1, serverSeq: 1, type: 'image.meta', payload: {} },
          { opId: 'e'.repeat(16), deviceId: 'other', ts: 1, serverSeq: 2, type: 'product.upsert', payload: product('p9', 'Kept', 100) },
        ],
        latestSeq: 2,
      },
    ];

    const result = await sync.syncNow();

    expect(result.ok).toBe(true);
    await expect(openCoreDb(account.accountId).products.get('p9')).resolves.toBeDefined();
  });

  it('keeps applying the batch when one known op has a malformed payload', async () => {
    // A peer on a newer build can send a payload this one cannot read. That is
    // a reason to skip the op, not to strand the device on an old cursor.
    pullResponses = [
      {
        ops: [
          { opId: 'f'.repeat(16), deviceId: 'other', ts: 1, serverSeq: 1, type: 'product.upsert', payload: { nonsense: true } },
          { opId: 'g'.repeat(16), deviceId: 'other', ts: 1, serverSeq: 2, type: 'product.upsert', payload: product('p8', 'Survived', 100) },
        ],
        latestSeq: 2,
      },
    ];

    const result = await sync.syncNow();

    expect(result.ok).toBe(true);
    await expect(openCoreDb(account.accountId).products.get('p8')).resolves.toBeDefined();
  });

  it('advances the cursor so the next pull asks only for what is new', async () => {
    pullResponses = [
      { ops: [], latestSeq: 42 },
      { ops: [], latestSeq: 42 },
    ];

    await sync.syncNow();
    calls.length = 0;
    await sync.syncNow();

    expect(calls.find((c) => c.path.startsWith('/sync/pull'))?.path).toBe('/sync/pull?since=42');
  });

  it('discards local data and re-pulls when the server epoch changes', async () => {
    pullResponses = [{ ops: [], latestSeq: 5, epoch: 1 }];
    await sync.syncNow();

    pullResponses = [
      { ops: [], latestSeq: 9, epoch: 2 },
      { ops: [{ opId: 'f'.repeat(16), deviceId: 'o', ts: 1, serverSeq: 1, type: 'product.upsert', payload: product('p1', 'Rebuilt', 10) }], latestSeq: 9, epoch: 2 },
    ];
    calls.length = 0;

    await sync.syncNow();

    // A changed epoch means the server rewrote its log, so the cached payloads
    // are stale and the only safe move is a full re-pull from zero.
    expect(calls.some((c) => c.path === '/sync/pull?since=0')).toBe(true);
    expect((await openCoreDb(account.accountId).products.get('p1'))?.title).toBe('Rebuilt');
  });

  it('reports being offline instead of throwing', async () => {
    failPush = true;
    await catalog.upsertProduct(product('p1', 'Anchor print', 1000));

    const result = await sync.syncNow();

    expect(result.ok).toBe(false);
    // Being offline is the normal state at a booth; callers should not have to
    // treat it as exceptional.
    expect(sync.syncState.value === 'error' || sync.syncState.value === 'offline').toBe(true);
  });

  it('splits a push into byte-bounded batches so big payloads cannot wedge the outbox', async () => {
    // Twelve ops of ~1 MB each: counted alone they are one batch of 12; by
    // bytes they must go in several requests, each under the cap.
    const big = 'x'.repeat(1_000_000);
    for (let i = 0; i < 12; i++) await outbox.queueOp({ type: 'image.meta', payload: { imageId: `img${i}`, productId: 'p1', updatedAt: i, thumbB64: big } });

    await sync.syncNow();

    const pushes = calls.filter((c) => c.path === '/sync/push');
    expect(pushes.length).toBeGreaterThan(1);
    for (const p of pushes) expect(JSON.stringify(p.body).length).toBeLessThan(5 * 1024 * 1024);
    expect(pushes.reduce((n, p) => n + (p.body as { ops: unknown[] }).ops.length, 0)).toBe(12);
    expect(await outbox.unsyncedOps()).toHaveLength(0);
  });

  it('stores a pulled image thumbnail so a second device can show the photo', async () => {
    const thumbB64 = btoa('webp-bytes');
    pullResponses = [{ ops: [{ seq: 1, opId: 'op-image-000000001', deviceId: 'other', ts: 1, type: 'image.meta', payload: { imageId: 'img1', productId: 'p1', updatedAt: 5, thumbB64 } }], latestSeq: 1 }];

    await sync.syncNow();

    const rec = await openCoreDb(account.accountId).images.get('img1');
    expect(rec?.productId).toBe('p1');
    expect(rec?.thumb.type).toBe('image/webp');
    // No full-size copy travels; the thumbnail stands in for it here.
    expect(rec?.full).toBe(rec?.thumb);
  });
});
