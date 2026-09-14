import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, SaleEvent } from '@zollify/sdk';
import type { Product } from '@zollify/shared';

const account: AccountSnapshot = {
  accountId: 'acct-merge',
  accountName: 'Merge Test',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '' }, defaultCurrency: 'CHF' },
};

vi.mock('../session', () => ({
  getAccount: () => account,
  onAccountChange: () => () => {},
  authFetch: async () => ({}),
}));

const { deleteCoreDb } = await import('../core/db');
const tx = await import('../core/transactions');
const catalog = await import('../core/catalog');
const events = await import('../core/sales-events');
const inventory = await import('../core/inventory');
const device = await import('../core/device');
const outbox = await import('../core/outbox');
const { mergeProducts } = await import('../core/merge');

const product = (id: string, title: string): Product => ({ id, title, forSale: true, unlisted: false, price: 10, variants: [], sortOrder: 0, updatedAt: 1 });
const sale = (productId: string, name: string): SaleEvent => ({
  saleId: crypto.randomUUID(),
  eventId: 'ev-1',
  at: Date.now(),
  currency: 'CHF',
  total: 10,
  lines: [{ productId, sku: null, name, qty: 2, unitPrice: 10, lineTotal: 20, taxRate: null }],
  payment: { provider: 'manual', approved: true },
});

beforeEach(async () => {
  await deleteCoreDb(account.accountId);
  tx.resetTransactionCache();
  catalog.resetCatalogCache();
  events.resetSalesEventCache();
  inventory.resetInventoryCache();
  device.resetDeviceCache();
});

describe('merging products', () => {
  it('folds sources into variants, re-attaches sales and stock, and queues one merge op', async () => {
    await catalog.upsertProduct(product('cat', 'Keychain Cat'));
    await catalog.upsertProduct(product('dog', 'Keychain Dog'));
    // Counted first: only sales after a count reduce it.
    await inventory.setOnHand('cat', '', 5);
    await inventory.setOnHand('dog', '', 7);
    await tx.recordSale(sale('cat', 'Keychain Cat'));
    await tx.recordSale(sale('dog', 'Keychain Dog'));

    await mergeProducts(
      { ...product('cat', 'Keychain'), variants: [{ id: 'v-cat', name: 'Cat', price: 10 }, { id: 'v-dog', name: 'Dog', price: 10 }] },
      {
        id: 'm1',
        intoId: 'cat',
        sources: [
          { fromKey: 'cat', toPid: 'cat', toVid: 'v-cat', title: 'Keychain', variantLabel: 'Cat' },
          { fromKey: 'dog', toPid: 'cat', toVid: 'v-dog', title: 'Keychain', variantLabel: 'Dog' },
        ],
        updatedAt: Date.now(),
      },
      ['dog'],
    );

    expect(catalog.getProduct('dog')).toBeUndefined();
    expect(catalog.getProduct('cat')?.variants.map((v) => v.name)).toEqual(['Cat', 'Dog']);

    const items = tx.recentTransactions.value.flatMap((t) => t.items);
    expect(items.map((i) => `${i.pid}:${i.vid}:${i.title}:${i.variantLabel}`).sort()).toEqual(['cat:v-cat:Keychain:Cat', 'cat:v-dog:Keychain:Dog']);
    expect(inventory.soldTotal('cat', 'v-dog')).toBe(2);
    expect(inventory.onHandFor('cat', 'v-cat')).toBe(5);
    expect(inventory.onHandFor('cat', 'v-dog')).toBe(7);
    expect(inventory.onHandFor('dog', '')).toBe(0);

    const ops = await outbox.unsyncedOps();
    expect(ops.filter((o) => o.type === 'product.merge')).toHaveLength(1);
    expect(ops.filter((o) => o.type === 'product.delete')).toHaveLength(1);
  });
});
