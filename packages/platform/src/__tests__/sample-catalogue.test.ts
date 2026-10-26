import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot } from '@zollify/sdk';

/** Sample products, for a test account only. */

const account: AccountSnapshot = {
  accountId: 'acct-samples',
  accountName: 'Test Store',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'admin',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'EUR', sandbox: true },
};

vi.mock('../session', () => ({
  getAccount: () => account,
  onAccountChange: () => () => {},
  authFetch: async () => ({}),
}));

const { deleteCoreDb } = await import('../core/db');
const catalog = await import('../core/catalog');
const inv = await import('../core/inventory');
const { fillSampleCatalogue, SAMPLE_PRODUCTS } = await import('../core/sample-catalogue');

beforeEach(async () => {
  account.profile.sandbox = true;
  await deleteCoreDb(account.accountId);
  catalog.resetCatalogCache();
  inv.resetInventoryCache();
  await catalog.loadCatalog();
  await inv.loadInventory();
});

describe('sample products', () => {
  it('fills a test account with products, variants and stock', async () => {
    expect(await fillSampleCatalogue()).toBe(SAMPLE_PRODUCTS.length);
    const products = catalog.allProducts.value;
    expect(products).toHaveLength(SAMPLE_PRODUCTS.length);
    const keychain = products.find((p) => p.id === 'sample-zodiac-keychain')!;
    expect(keychain.variants.map((v) => v.name)).toContain('Dragon');
    expect(inv.onHandFor('sample-zodiac-keychain', 'dragon')).toBe(2);
    expect(inv.onHandFor('sample-tote', 'black')).toBe(0);
    expect(products.find((p) => p.id === 'sample-zine')?.taxClass).toBe('reduced');
    expect(products.find((p) => p.id === 'sample-display')?.forSale).toBe(false);
  });

  it('puts them back rather than adding a second set', async () => {
    await fillSampleCatalogue();
    await inv.setOnHand('sample-moth-pin', '', 99);
    await fillSampleCatalogue();
    expect(catalog.allProducts.value).toHaveLength(SAMPLE_PRODUCTS.length);
    expect(inv.onHandFor('sample-moth-pin', '')).toBe(3);
  });

  it('is refused in a real account', async () => {
    account.profile.sandbox = undefined;
    await expect(fillSampleCatalogue()).rejects.toThrow(/test account/);
    expect(catalog.allProducts.value).toHaveLength(0);
  });
});
