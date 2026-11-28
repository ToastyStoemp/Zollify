import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot } from '@zollify/sdk';
import { defineModule } from '@zollify/sdk';

/**
 * Housekeeping that keeps an old device quick: acknowledged outbox ops and
 * superseded module bundles are dropped - in the background, rarely, and
 * never at the cost of a sync, a start-up or anything not yet safe to lose.
 */

const account: AccountSnapshot = {
  accountId: 'acct-prune',
  accountName: 'Prune Booth',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'CHF' },
};

const fakeFetch = async (path: string) => (path.startsWith('/sync/push') ? { accepted: 0, duplicates: 0, latestSeq: 0 } : { ops: [], latestSeq: 0 });

vi.mock('../session', () => ({
  getAccount: () => account,
  getDeviceAccount: () => account,
  personSession: () => null,
  onAccountChange: () => () => {},
  getApiBase: () => '/api',
  authFetch: fakeFetch,
  authFetchAs: (_as: string | null, path: string) => fakeFetch(path),
  deviceFetch: fakeFetch,
}));

const { deleteCoreDb, openCoreDb } = await import('../core/db');
const sync = await import('../core/sync');
const device = await import('../core/device');
const { RemoteResolver } = await import('../loader');
const cache = await import('../module-cache');

const DAY = 24 * 3600 * 1000;
const PRUNED_AT_KEY = 'core.outboxPrunedAt';

let n = 0;
const outboxRow = (ageDays: number, synced: 0 | 1) => ({ opId: `op-prune-${String(++n).padStart(8, '0')}`, deviceId: 'd', ts: Date.now() - ageDays * DAY, type: 'tx.create' as const, payload: { id: `tx-${n}` }, synced });
const outboxIds = async (): Promise<string[]> => (await openCoreDb(account.accountId).ops.toArray()).map((op) => (op.payload as { id: string }).id);
const prunedAt = async (): Promise<unknown> => (await openCoreDb(account.accountId).settings.get(PRUNED_AT_KEY))?.value;

beforeEach(async () => {
  await deleteCoreDb(account.accountId);
  device.resetDeviceCache();
});

describe('the outbox after a sync', () => {
  it('drops acknowledged ops older than a week, and nothing that has not been sent', async () => {
    const db = openCoreDb(account.accountId);
    const [oldSynced, freshSynced] = [outboxRow(30, 1), outboxRow(1, 1)];
    await db.ops.bulkAdd([oldSynced, freshSynced]);

    expect((await sync.syncNow()).ok).toBe(true);
    await vi.waitFor(async () => expect(await prunedAt()).toBeTypeOf('number'));

    expect(await outboxIds()).toEqual([(freshSynced.payload as { id: string }).id]);
  });

  it('keeps an old sale that never reached the server', async () => {
    const db = openCoreDb(account.accountId);
    const unsent = outboxRow(90, 0);
    await db.ops.add(unsent);
    // What the server says about the push decides whether it is marked sent; here the prune itself is under test.
    const { pruneSynced } = await import('../core/outbox');

    expect(await pruneSynced()).toBe(0);
    expect(await outboxIds()).toEqual([unsent.payload.id]);
  });

  it('prunes at most once a day', async () => {
    const db = openCoreDb(account.accountId);
    await sync.syncNow();
    await vi.waitFor(async () => expect(await prunedAt()).toBeTypeOf('number'));
    const first = await prunedAt();

    const late = outboxRow(30, 1);
    await db.ops.add(late);
    await sync.syncNow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await outboxIds()).toEqual([late.payload.id]);
    expect(await prunedAt()).toBe(first);

    // A day on, it is due again.
    await db.settings.put({ key: PRUNED_AT_KEY, value: Date.now() - DAY - 1 });
    await sync.syncNow();
    await vi.waitFor(async () => expect(await outboxIds()).toEqual([]));
  });

  it('does not fail the sync when pruning fails', async () => {
    const db = openCoreDb(account.accountId);
    await db.ops.add(outboxRow(30, 1));
    const refuse = (): never => {
      throw new Error('storage is full');
    };
    db.ops.hook('deleting', refuse);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await sync.syncNow();
      expect(result.ok).toBe(true);
      await vi.waitFor(() => expect(warn.mock.calls.some((c) => String(c[0]).includes('could not prune the outbox'))).toBe(true));
      expect(sync.syncState.value).toBe('idle');
    } finally {
      warn.mockRestore();
      db.ops.hook('deleting').unsubscribe(refuse);
    }
  });
});

describe('old module bundles', () => {
  const code = (version: string): string => `export default "pos ${version}";`;
  const importModule = async (source: string) => {
    if (source.includes('broken')) throw new Error('bundle threw on import');
    return { default: defineModule({ id: 'pos', version: '1.0.0', sdk: '^1.0.0', title: source, setup: () => {} }) };
  };
  const cacheVersion = async (version: string, source = code(version)) => cache.putCached({ moduleId: 'pos', version, code: source, integrity: await cache.sha256Hex(source) });
  const descriptor = async (version: string, source = code(version)) => ({ moduleId: 'pos', version, url: `/modules/pos/${version}/bundle.js`, integrity: await cache.sha256Hex(source) });
  const cachedVersions = async (): Promise<string[]> => (await cache.listCached()).filter((b) => b.moduleId === 'pos').map((b) => b.version).sort();

  beforeEach(async () => {
    await cache.evictModule('pos');
    await cache.evictModule('tax');
  });

  it('go once the version the manifest names has loaded, and other modules are left alone', async () => {
    await cacheVersion('1.0.0');
    await cacheVersion('1.1.0');
    await cache.putCached({ moduleId: 'tax', version: '1.0.0', code: 'tax', integrity: await cache.sha256Hex('tax') });

    await new RemoteResolver(async () => code('1.2.0'), importModule).resolve(await descriptor('1.2.0'));

    await vi.waitFor(async () => expect(await cachedVersions()).toEqual(['1.2.0']));
    expect((await cache.listCached()).some((b) => b.moduleId === 'tax')).toBe(true);
  });

  it('stay when the new version could not be downloaded', async () => {
    await cacheVersion('1.0.0');
    const offline = async (): Promise<string> => {
      throw new Error('offline');
    };

    await expect(new RemoteResolver(offline, importModule).resolve(await descriptor('1.1.0'))).rejects.toThrow('offline');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await cachedVersions()).toEqual(['1.0.0']);
  });

  it('stay when the new version will not run', async () => {
    await cacheVersion('1.0.0');
    const broken = 'export default "broken";';

    await expect(new RemoteResolver(async () => broken, importModule).resolve(await descriptor('1.1.0', broken))).rejects.toThrow('bundle threw on import');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await cachedVersions()).toEqual(['1.0.0', '1.1.0']);
  });

  it('are never removed in favour of a version that is not in the cache', async () => {
    await cacheVersion('1.0.0');

    expect(await cache.pruneOldVersions('pos', '9.9.9')).toBe(0);
    expect(await cachedVersions()).toEqual(['1.0.0']);
  });
});
