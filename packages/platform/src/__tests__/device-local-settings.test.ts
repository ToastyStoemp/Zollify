import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot } from '@zollify/sdk';

/**
 * Synced settings share a table with rows that belong to one device: its id,
 * the sync cursor, the receipt counter. Those must neither arrive from the
 * wire nor be sent.
 */

const account: AccountSnapshot = {
  accountId: 'acct-local-settings',
  accountName: 'Settings Booth',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'CHF' },
};

let pullResponses: unknown[] = [];
const fakeFetch = async (path: string) => (path.startsWith('/sync/push') ? { accepted: 0, duplicates: 0, latestSeq: 0 } : (pullResponses.shift() ?? { ops: [], latestSeq: 0 }));

vi.mock('../session', () => ({
  getAccount: () => account,
  getDeviceAccount: () => account,
  personSession: () => null,
  onAccountChange: () => () => {},
  authFetch: fakeFetch,
  authFetchAs: (_as: string | null, path: string) => fakeFetch(path),
  deviceFetch: fakeFetch,
}));

const { deleteCoreDb, openCoreDb } = await import('../core/db');
const catalog = await import('../core/catalog');
const events = await import('../core/sales-events');
const outbox = await import('../core/outbox');
const sync = await import('../core/sync');
const device = await import('../core/device');
const { isSyncedSettingKey, setSyncedSetting } = await import('../core/synced-settings');

const op = (n: number, key: string, value: unknown) => ({
  opId: String(n).padStart(16, '0'),
  deviceId: 'other',
  ts: 1,
  serverSeq: n,
  type: 'setting.upsert',
  payload: { key, value, updatedAt: Date.now() + 60_000 },
});

beforeEach(async () => {
  pullResponses = [];
  await deleteCoreDb(account.accountId);
  catalog.resetCatalogCache();
  events.resetSalesEventCache();
  device.resetDeviceCache();
});

describe('settings that belong to this device', () => {
  it('are not overwritten by a synced setting, while the keys meant to sync still apply', async () => {
    const db = openCoreDb(account.accountId);
    const myId = await device.deviceId();
    await db.settings.bulkPut([
      { key: 'core.receiptSeq', value: 41 },
      { key: 'core.activeEventId', value: 'mine' },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pullResponses = [
      {
        ops: [
          op(1, 'core.deviceId', 'someone-else'),
          op(2, 'core.receiptSeq', 1),
          op(3, 'core.syncCursor', 999_999),
          op(4, 'core.activeEventId', 'theirs'),
          op(5, 'sync.refusedSales', [{ txId: 'x' }]),
          op(6, 'core.defaultActiveEventId', 'ev-9'),
          op(7, 'multi-storage.home', { name: 'Studio' }),
        ],
        latestSeq: 7,
      },
    ];

    try {
      const result = await sync.syncNow();
      expect(result.ok).toBe(true);
      // Said in the log, once per op that was dropped.
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('device-local key'))).toHaveLength(5);
    } finally {
      warn.mockRestore();
    }

    expect((await db.settings.get('core.deviceId'))?.value).toBe(myId);
    expect((await db.settings.get('core.receiptSeq'))?.value).toBe(41);
    expect((await db.settings.get('core.syncCursor'))?.value).toBe(7);
    expect((await db.settings.get('core.activeEventId'))?.value).toBe('mine');
    expect(await db.settings.get('sync.refusedSales')).toBeUndefined();
    expect((await db.settings.get('core.defaultActiveEventId'))?.value).toBe('ev-9');
    expect((await db.settings.get('multi-storage.home'))?.value).toEqual({ name: 'Studio' });
  });

  it('cannot be sent as a synced setting either', async () => {
    const myId = await device.deviceId();

    await expect(setSyncedSetting('core.deviceId', 'forged')).rejects.toThrow('device-local');
    await expect(setSyncedSetting('core.claimCleared.e|p|', 5)).rejects.toThrow('device-local');

    device.resetDeviceCache();
    expect(await device.deviceId()).toBe(myId);
    expect(await outbox.unsyncedOps()).toEqual([]);
  });

  it('lets module keys, team keys and the two shared core keys through', () => {
    for (const key of ['team.note', 'wholesale.eventId', 'stock.sellLock', 'events.auto', 'core.cubeConfiguratorUrl', 'core.defaultActiveEventId']) {
      expect(isSyncedSettingKey(key)).toBe(true);
    }
    for (const key of ['core.deviceId', 'core.deviceName', 'core.syncEpoch', 'core.testMode', 'core.afterSale', 'sync.refusedSales', '', undefined, 7]) {
      expect(isSyncedSettingKey(key)).toBe(false);
    }
  });
});
