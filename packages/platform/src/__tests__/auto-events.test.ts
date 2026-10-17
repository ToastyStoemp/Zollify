import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot } from '@zollify/sdk';
import type { SalesEvent } from '@zollify/shared';

/**
 * The server opens and closes events; a device only moves its own till to the
 * one event running today once its own event has closed or ended.
 */

const account: AccountSnapshot = {
  accountId: 'acct-auto',
  accountName: 'Auto',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'member',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'EUR' },
};

vi.mock('../session', () => ({
  getAccount: () => account,
  onAccountChange: () => () => {},
  authFetch: async () => ({}),
}));

const { deleteCoreDb } = await import('../core/db');
const events = await import('../core/sales-events');
const auto = await import('../core/auto-events');
const { setSyncedSetting } = await import('../core/synced-settings');

const ev = (id: string, status: SalesEvent['status'], dateStart: string, dateEnd: string): SalesEvent =>
  ({ id, name: id, status, dateStart, dateEnd, venue: {}, currency: 'EUR', updatedAt: 1 }) as unknown as SalesEvent;

beforeEach(async () => {
  await deleteCoreDb(account.accountId);
  events.resetSalesEventCache();
  for (const e of [ev('last-week', 'active', '2026-10-08', '2026-10-10'), ev('this-weekend', 'planned', '2026-10-17', '2026-10-18'), ev('next-month', 'planned', '2026-11-14', '2026-11-15')]) {
    await events.upsertSalesEvent(e);
  }
  await events.setActiveEvent('last-week');
});

describe('automatic events on a device', () => {
  it('leaves the till alone while switched off', async () => {
    expect(await auto.runAutoEvents('2026-10-17')).toBeNull();
    expect(events.activeEventId.value).toBe('last-week');
  });

  it('moves a till on a finished event to the one running today, even before the server opened it, and changes no event', async () => {
    await setSyncedSetting('events.auto', { open: true, close: true });
    expect(await auto.runAutoEvents('2026-10-17')).toBe('this-weekend');
    expect(events.activeEventId.value).toBe('this-weekend');
    expect(events.getSalesEvent('this-weekend')?.status).toBe('planned');
    expect(events.getSalesEvent('last-week')?.status).toBe('active');
  });

  it('keeps a till on an event that is still running', async () => {
    await setSyncedSetting('events.auto', { open: true, close: false });
    await events.setActiveEvent('this-weekend');
    expect(await auto.runAutoEvents('2026-10-18')).toBeNull();
    expect(events.activeEventId.value).toBe('this-weekend');
  });
});
