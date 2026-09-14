import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import type { AccountSnapshot } from '@zollify/sdk';

const account: AccountSnapshot = {
  accountId: 'acct-img',
  accountName: 'Test Booth',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '' }, defaultCurrency: 'CHF' },
};
vi.mock('../session', () => ({ getAccount: () => account, onAccountChange: () => () => {} }));

const { deleteCoreDb, openCoreDb } = await import('../core/db');
const { importProductImage } = await import('../core/images');

describe('importProductImage', () => {
  beforeEach(() => deleteCoreDb(account.accountId));

  // A backup importer keeps its plan in Vue state, so the records arrive as
  // proxies; IndexedDB refuses to clone a Proxy but must keep the Blobs intact.
  it('stores a reactive record with its blobs', async () => {
    const rec = reactive({ id: 'img-1', productId: 'p-1', updatedAt: 5, full: new Blob(['full'], { type: 'image/jpeg' }), thumb: new Blob(['thumb'], { type: 'image/webp' }) });
    await importProductImage(rec);
    const stored = await openCoreDb(account.accountId).images.get('img-1');
    expect(stored?.productId).toBe('p-1');
    expect(await stored?.thumb.text()).toBe('thumb');
    expect(await stored?.full.text()).toBe('full');
  });
});
