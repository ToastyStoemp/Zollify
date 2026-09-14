import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, SaleEvent } from '@zollify/sdk';

const account: AccountSnapshot = {
  accountId: 'acct-inv',
  accountName: 'Inventory Test',
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
const inv = await import('../core/inventory');
const catalog = await import('../core/catalog');
const tx = await import('../core/transactions');
const device = await import('../core/device');

const PRINT = 'p-print';

async function addPrint(): Promise<void> {
  await catalog.upsertProduct({
    id: PRINT,
    title: 'Harbour print',
    price: 40,
    forSale: true,
    unlisted: false,
    variants: [],
    sortOrder: 0,
    updatedAt: Date.now(),
  });
}

async function sell(eventId: string, qty: number, saleId: string = crypto.randomUUID()): Promise<void> {
  const sale: SaleEvent = {
    saleId,
    eventId,
    at: Date.now(),
    currency: 'CHF',
    total: 40 * qty,
    lines: [
      { productId: PRINT, variantId: null, sku: null, name: 'Harbour print', qty, unitPrice: 40, lineTotal: 40 * qty, taxRate: null },
    ],
    payment: { provider: 'manual', approved: true },
  };
  await tx.recordSale(sale);
}

function availability(eventId: string) {
  return inv.availabilityFor(eventId).find((r) => r.productId === PRINT)!;
}

function inventoryRow() {
  return inv.inventoryRows().find((r) => r.productId === PRINT)!;
}

beforeEach(async () => {
  await deleteCoreDb(account.accountId);
  inv.resetInventoryCache();
  catalog.resetCatalogCache();
  tx.resetTransactionCache();
  device.resetDeviceCache();
  await addPrint();
});

describe('one inventory', () => {
  it('starts at zero until counted', () => {
    expect(inv.onHandFor(PRINT)).toBe(0);
    expect(inventoryRow().free).toBe(0);
  });

  it('records what the booth owns', async () => {
    await inv.setOnHand(PRINT, null, 100);

    expect(inv.onHandFor(PRINT)).toBe(100);
    expect(inventoryRow().free).toBe(100);
  });

  it('survives a reload', async () => {
    await inv.setOnHand(PRINT, null, 42);
    inv.resetInventoryCache();
    await inv.loadInventory();

    expect(inv.onHandFor(PRINT)).toBe(42);
  });
});

describe('an event with no claim', () => {
  it('sells from the whole unclaimed pool', async () => {
    await inv.setOnHand(PRINT, null, 100);

    const row = availability('ev-a');
    expect(row.source).toBe('pool');
    expect(row.available).toBe(100);
  });

  it('shares that pool with every other unclaimed event', async () => {
    // Two events with no claims are drawing on one physical pile. Treating
    // them separately would let the booth sell the same print twice.
    await inv.setOnHand(PRINT, null, 10);
    await sell('ev-a', 4);

    expect(availability('ev-b').available).toBe(6);
  });

  it('cannot touch stock another event has claimed', async () => {
    await inv.setOnHand(PRINT, null, 100);
    await inv.setClaim('ev-a', PRINT, null, 30);

    const row = availability('ev-b');
    expect(row.reservedElsewhere).toBe(30);
    expect(row.available).toBe(70);
  });
});

describe('an event with a claim', () => {
  it('sells only against its claim, however much is left elsewhere', async () => {
    await inv.setOnHand(PRINT, null, 100);
    await inv.setClaim('ev-a', PRINT, null, 30);

    const row = availability('ev-a');
    expect(row.source).toBe('claim');
    expect(row.claimed).toBe(30);
    expect(row.available).toBe(30);
  });

  it('counts down its own sales', async () => {
    await inv.setOnHand(PRINT, null, 100);
    await inv.setClaim('ev-a', PRINT, null, 30);
    await sell('ev-a', 10);

    expect(availability('ev-a').available).toBe(20);
  });

  it('is unaffected by sales at other events', async () => {
    // This is what reserving means: nobody else's trading can eat it.
    await inv.setOnHand(PRINT, null, 100);
    await inv.setClaim('ev-a', PRINT, null, 30);
    await sell('ev-b', 50);

    expect(availability('ev-a').available).toBe(30);
  });

  it('treats a claim of zero as taking none, not as having no claim', async () => {
    await inv.setOnHand(PRINT, null, 100);
    await inv.setClaim('ev-a', PRINT, null, 0);

    const row = availability('ev-a');
    expect(row.source).toBe('claim');
    expect(row.available).toBe(0);
  });

  it('falls back to the pool once the claim is dropped', async () => {
    await inv.setOnHand(PRINT, null, 100);
    await inv.setClaim('ev-a', PRINT, null, 30);
    expect(availability('ev-a').source).toBe('claim');

    await inv.clearClaim('ev-a', PRINT, null);

    const row = availability('ev-a');
    expect(row.source).toBe('pool');
    expect(row.available).toBe(100);
  });

  it('goes negative rather than silently clamping when oversold', async () => {
    // Physical reality wins: the sale happened. A negative number says the
    // claim was wrong, which is the thing worth surfacing.
    await inv.setOnHand(PRINT, null, 100);
    await inv.setClaim('ev-a', PRINT, null, 5);
    await sell('ev-a', 8);

    expect(availability('ev-a').available).toBe(-3);
  });
});

describe('the free pool', () => {
  it('does not subtract a claimed sale twice', async () => {
    // The obvious mistake: a sale out of a claim reduces both the claim and
    // the pool, so the pool shrinks twice for one print.
    await inv.setOnHand(PRINT, null, 100);
    await inv.setClaim('ev-a', PRINT, null, 30);
    await sell('ev-a', 10);

    // 100 owned, 30 set aside for ev-a, nothing sold from the pool.
    expect(inventoryRow().free).toBe(70);
  });

  it('subtracts sales made from the pool', async () => {
    await inv.setOnHand(PRINT, null, 100);
    await sell('ev-b', 15);

    expect(inventoryRow().free).toBe(85);
  });

  it('accounts for claims and pool sales together', async () => {
    await inv.setOnHand(PRINT, null, 100);
    await inv.setClaim('ev-a', PRINT, null, 30);
    await sell('ev-a', 10);
    await sell('ev-b', 5);

    expect(inventoryRow().free).toBe(65);
    expect(availability('ev-b').available).toBe(65);
  });

  it('loses the overage when a claim is oversold', async () => {
    // Three prints past the claim still physically left the pile. They came
    // out of the unclaimed stock, so the pool — and every unclaimed event —
    // must see them gone, or a second event could sell the same prints.
    await inv.setOnHand(PRINT, null, 100);
    await inv.setClaim('ev-a', PRINT, null, 5);
    await sell('ev-a', 8);

    expect(inventoryRow().free).toBe(92);
    expect(availability('ev-b').available).toBe(92);
    // The claimed event still shows its own shortfall.
    expect(availability('ev-a').available).toBe(-3);
  });

  it('drains the pool to zero, not below, when only the claim is oversold', async () => {
    // Overage is the excess past the claim, not the whole sale: 30 claimed,
    // 32 sold means 2 left the pool, not 32.
    await inv.setOnHand(PRINT, null, 100);
    await inv.setClaim('ev-a', PRINT, null, 30);
    await sell('ev-a', 32);

    expect(inventoryRow().free).toBe(68);
  });

  it('flags over-commitment when more is promised than owned', async () => {
    await inv.setOnHand(PRINT, null, 40);
    await inv.setClaim('ev-a', PRINT, null, 30);
    await inv.setClaim('ev-b', PRINT, null, 25);

    const row = inventoryRow();
    expect(row.claimed).toBe(55);
    expect(row.free).toBe(-15);
    expect(row.overCommitted).toBe(true);
  });
});

describe('reverted sales', () => {
  it('return stock to whatever they came out of', async () => {
    await inv.setOnHand(PRINT, null, 100);
    await inv.setClaim('ev-a', PRINT, null, 30);
    await sell('ev-a', 10, 'sale-1');
    expect(availability('ev-a').available).toBe(20);

    await tx.revertTransaction('sale-1');

    // Derived, not decremented — which is exactly why a revert needs no
    // compensating write anywhere.
    expect(availability('ev-a').available).toBe(30);
    expect(inventoryRow().sold).toBe(0);
  });
});
