import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot } from '@zollify/sdk';

let account: AccountSnapshot | null = null;

vi.mock('../session', () => ({
  getAccount: () => account,
  onAccountChange: () => () => {},
}));

const OWNER: AccountSnapshot = {
  accountId: 'acct-booth',
  accountName: 'Test Booth',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'CHF' },
};

const { deleteCoreDb } = await import('../core/db');
const events = await import('../core/sales-events');
const outbox = await import('../core/outbox');
const booth = await import('../core/booth-layout');

const salesEvent = (id: string, name: string) => ({ id, name, venue: {}, currency: 'CHF', status: 'planned', updatedAt: 1 }) as never;

const design = JSON.stringify({
  schema: 'cube-studio',
  version: 2,
  name: 'Corner',
  width: 30,
  height: 30,
  depth: 30,
  panels: [{ type: 'back', x: 0, y: 0, z: 0, material: 'mesh', color: '#aabbcc' }],
});

beforeEach(async () => {
  account = OWNER;
  await deleteCoreDb(OWNER.accountId);
  events.resetSalesEventCache();
  await events.upsertSalesEvent(salesEvent('e1', 'Spring 2026'));
  await events.upsertSalesEvent(salesEvent('e2', 'Spring 2027'));
});

describe('event booth layout', () => {
  it('imports a design onto the event and queues it for sync', async () => {
    await booth.importEventBoothLayout('e1', design, 'corner.json');
    expect(events.getSalesEvent('e1')?.boothLayout).toMatchObject({ name: 'Corner', fileName: 'corner.json' });
    const ops = await outbox.unsyncedOps();
    expect(ops.at(-1)?.type).toBe('event.upsert');
  });

  it('rejects a bad file and leaves the event alone', async () => {
    await expect(booth.importEventBoothLayout('e1', '{"schema":"nope"}')).rejects.toThrow(/Cube Studio/);
    expect(events.getSalesEvent('e1')?.boothLayout).toBeUndefined();
  });

  it('replaces and removes', async () => {
    await booth.importEventBoothLayout('e1', design);
    await booth.importEventBoothLayout('e1', design.replace('Corner', 'Wall'));
    expect(events.getSalesEvent('e1')?.boothLayout?.name).toBe('Wall');
    await booth.setEventBoothLayout('e1', undefined);
    expect('boothLayout' in (events.getSalesEvent('e1') ?? {})).toBe(false);
  });

  it('copies a layout from another event, and refuses when there is none', async () => {
    await expect(booth.copyEventBoothLayout('e1', 'e2')).rejects.toThrow(/no layout/);
    await booth.importEventBoothLayout('e1', design);
    await booth.copyEventBoothLayout('e1', 'e2');
    expect(events.getSalesEvent('e2')?.boothLayout?.name).toBe('Corner');
    // Independent copies: removing one keeps the other.
    await booth.setEventBoothLayout('e1', undefined);
    expect(events.getSalesEvent('e2')?.boothLayout).toBeDefined();
  });

  it('keeps the configurator link empty until set, and only accepts web addresses', async () => {
    expect(await booth.getConfiguratorUrl()).toBe('');
    await expect(booth.setConfiguratorUrl('javascript:alert(1)')).rejects.toThrow(/https/);
    expect(await booth.setConfiguratorUrl('me.github.io/cube')).toBe('https://me.github.io/cube');
    expect(await booth.getConfiguratorUrl()).toBe('https://me.github.io/cube');
    expect(await booth.setConfiguratorUrl('')).toBe('');
    expect(await booth.getConfiguratorUrl()).toBe('');
  });
});
