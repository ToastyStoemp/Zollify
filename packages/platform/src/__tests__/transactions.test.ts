import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, SaleEvent } from '@zollify/sdk';

const account: AccountSnapshot = {
  accountId: 'acct-tx',
  accountName: 'Till Test',
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

const { deleteCoreDb, openCoreDb } = await import('../core/db');
const tx = await import('../core/transactions');
const backup = await import('../core/backup');
const catalog = await import('../core/catalog');
const events = await import('../core/sales-events');
const device = await import('../core/device');

function sale(over: Partial<SaleEvent> = {}): SaleEvent {
  return {
    saleId: crypto.randomUUID(),
    eventId: 'ev-1',
    at: Date.now(),
    currency: 'CHF',
    total: 35,
    lines: [{ productId: 'p1', sku: 'ANCH', name: 'Anchor print', qty: 1, unitPrice: 35, lineTotal: 35, taxRate: null }],
    payment: { provider: 'manual', approved: true, txRef: 'ref-1' },
    ...over,
  };
}

beforeEach(async () => {
  await deleteCoreDb(account.accountId);
  tx.resetTransactionCache();
  catalog.resetCatalogCache();
  events.resetSalesEventCache();
  device.resetDeviceCache();
});

describe('recording sales', () => {
  it('persists a sale and surfaces it in history', async () => {
    await tx.recordSale(sale({ saleId: 's1' }));

    tx.resetTransactionCache();
    await tx.loadTransactions();

    expect(tx.recentTransactions.value).toHaveLength(1);
    expect(tx.getTransaction('s1')?.total).toBe(35);
  });

  it('maps a manual payment to cash and a terminal to card', async () => {
    const manual = tx.saleToTransaction(sale({ saleId: 'a' }), 'dev');
    const card = tx.saleToTransaction(
      sale({ saleId: 'b', payment: { provider: 'mypos-go2', approved: true } }),
      'dev',
    );

    expect(manual.method).toBe('cash');
    expect(card.method).toBe('card');
    expect(card.payments[0]?.provider).toBe('mypos-go2');
  });

  it('records a sale made with no active event rather than dropping it', async () => {
    // A sale that happened is a sale that happened; filing it under '' keeps it
    // visible in History instead of vanishing.
    await tx.recordSale(sale({ saleId: 's2', eventId: null }));

    expect(tx.getTransaction('s2')?.eventId).toBe('');
  });

  it('keeps the line total it was given rather than recomputing it', async () => {
    const t = tx.saleToTransaction(
      sale({
        lines: [
          { productId: 'p', sku: null, name: 'x', qty: 3, unitPrice: 0.1, lineTotal: 0.3, taxRate: null },
        ],
      }),
      'dev',
    );

    // Recomputing here is what made a discounted receipt's lines disagree with
    // its own total. 0.1 * 3 in floats is also 0.30000000000000004.
    expect(t.items[0]?.lineTotal).toBe(0.3);
  });

  it('records lines that add up to the discounted total', async () => {
    // The regression this pins: a discounted sale whose line totals still
    // showed the undiscounted price, so a receipt did not add up to itself.
    await tx.recordSale(
      sale({
        saleId: 'discounted',
        total: 58.5,
        lines: [
          { productId: 'p1', sku: null, name: 'Print', qty: 1, unitPrice: 65, lineTotal: 58.5, taxRate: null },
        ],
      }),
    );

    const stored = tx.getTransaction('discounted');
    const lineSum = (stored?.items ?? []).reduce((n, i) => n + i.lineTotal, 0);

    expect(lineSum).toBe(stored?.total);
  });

  it('records both the charged and base figures for a converted sale', async () => {
    // They answer different questions: total is what the terminal took,
    // baseTotal is what the books count. Deriving one later would use whatever
    // rate is current then, not the rate actually applied.
    await tx.recordSale(
      sale({
        saleId: 'abroad',
        currency: 'SEK',
        total: 700,
        baseCurrency: 'CHF',
        baseTotal: 65,
        exchangeRate: 10.77,
      }),
    );

    const stored = tx.getTransaction('abroad');
    expect(stored?.currency).toBe('SEK');
    expect(stored?.total).toBe(700);
    expect(stored?.baseCurrency).toBe('CHF');
    expect(stored?.baseTotal).toBe(65);
    expect(stored?.exchangeRate).toBe(10.77);
  });

  it('leaves the conversion fields off an unconverted sale', async () => {
    await tx.recordSale(sale({ saleId: 'home', currency: 'CHF', baseCurrency: 'CHF' }));

    const stored = tx.getTransaction('home');
    expect(stored?.baseCurrency).toBeUndefined();
    expect(stored?.exchangeRate).toBeUndefined();
  });
});

describe('reverting', () => {
  it('marks the sale rather than deleting it', async () => {
    // A till's history is a financial record; a refund that erased the sale
    // would leave the books unexplainable.
    await tx.recordSale(sale({ saleId: 's1' }));
    await tx.revertTransaction('s1');

    const row = await openCoreDb(account.accountId).transactions.get('s1');
    expect(row).toBeDefined();
    expect(row?.revertedAt).toBeGreaterThan(0);
  });

  it('is idempotent', async () => {
    await tx.recordSale(sale({ saleId: 's1' }));
    await tx.revertTransaction('s1');
    const first = tx.getTransaction('s1')?.revertedAt;

    await tx.revertTransaction('s1');

    expect(tx.getTransaction('s1')?.revertedAt).toBe(first);
  });

  it('rejects an unknown id', async () => {
    await expect(tx.revertTransaction('nope')).rejects.toThrow(/no such/i);
  });
});

describe('totals', () => {
  it('counts reverted sales separately rather than netting them off', async () => {
    // At cash-up you need both what was taken and what was handed back.
    await tx.recordSale(sale({ saleId: 'a', total: 10 }));
    await tx.recordSale(sale({ saleId: 'b', total: 25 }));
    await tx.revertTransaction('b');

    const [totals] = tx.totalsFor('ev-1');

    expect(totals?.gross).toBe(10);
    expect(totals?.sales).toBe(1);
    expect(totals?.reverted).toBe(25);
  });

  it('separates currencies', async () => {
    await tx.recordSale(sale({ saleId: 'a', total: 10, currency: 'CHF' }));
    await tx.recordSale(sale({ saleId: 'b', total: 20, currency: 'SEK' }));

    expect(tx.totalsFor(null).map((t) => t.currency)).toEqual(['CHF', 'SEK']);
  });

  it('scopes to one event', async () => {
    await tx.recordSale(sale({ saleId: 'a', total: 10, eventId: 'ev-1' }));
    await tx.recordSale(sale({ saleId: 'b', total: 99, eventId: 'ev-2' }));

    expect(tx.totalsFor('ev-1')[0]?.gross).toBe(10);
  });
});

describe('backup', () => {
  it('round-trips everything core owns', async () => {
    await catalog.upsertProduct({ id: 'p1', title: 'Print', price: 5, forSale: true, unlisted: false } as never);
    await events.upsertSalesEvent({ id: 'ev-1', name: 'Fair', venue: {}, currency: 'CHF', status: 'planned' } as never);
    await tx.recordSale(sale({ saleId: 's1' }));

    const file = await backup.createBackup();
    expect(file.products).toHaveLength(1);
    expect(file.events).toHaveLength(1);
    expect(file.transactions).toHaveLength(1);

    await deleteCoreDb(account.accountId);
    catalog.resetCatalogCache();
    events.resetSalesEventCache();
    tx.resetTransactionCache();

    const result = await backup.restoreBackup(JSON.parse(JSON.stringify(file)));

    expect(result.products).toBe(1);
    expect(catalog.allProducts.value).toHaveLength(1);
    expect(events.visibleEvents.value).toHaveLength(1);
    expect(tx.recentTransactions.value).toHaveLength(1);
  });

  it('keeps tombstones so a restore does not resurrect deleted rows', async () => {
    await catalog.upsertProduct({ id: 'p1', title: 'Gone', price: 5, forSale: true, unlisted: false } as never);
    await catalog.deleteProduct('p1');

    const file = await backup.createBackup();

    // The deleted row must still be in the file — last-write-wins sync has no
    // other way to learn it is gone.
    expect(file.products).toHaveLength(1);
    expect(file.products[0]?.deletedAt).toBeGreaterThan(0);
  });

  it('refuses a file that is not a Zollify backup', () => {
    expect(() => backup.inspectBackup({ hello: 'world' })).toThrow(backup.RestoreError);
    expect(() => backup.inspectBackup(null)).toThrow(backup.RestoreError);
  });

  it('refuses a backup version it does not understand', () => {
    expect(() =>
      backup.inspectBackup({ format: 'zollify-backup', version: 99 }),
    ).toThrow(/version 1/i);
  });

  it('flags a backup from another account instead of restoring silently', () => {
    const summary = backup.inspectBackup({
      format: 'zollify-backup',
      version: 1,
      exportedAt: 'x',
      accountId: 'someone-else',
      accountName: 'Other Booth',
      products: [],
      events: [],
      eventStock: [],
      transactions: [],
    });

    expect(summary.sameAccount).toBe(false);
    expect(summary.accountName).toBe('Other Booth');
  });

  it('does not overwrite an existing sale on restore', async () => {
    // Sales are immutable; a restore must not rewrite one that already exists.
    await tx.recordSale(sale({ saleId: 's1', total: 35 }));
    const file = await backup.createBackup();
    file.transactions[0]!.total = 999;

    await backup.restoreBackup(JSON.parse(JSON.stringify(file)));

    expect(tx.getTransaction('s1')?.total).toBe(35);
  });
});
