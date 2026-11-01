import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, SaleEvent } from '@zollify/sdk';

/**
 * Refilling the travelling boxes: after an event, what came back in the box
 * and what to put in from home to fill it back up to the claim - then claimed
 * for the next event in one step, the box carried on and the refill taken
 * from home, never reserved twice.
 */

const account: AccountSnapshot = {
  accountId: 'acct-refill', accountName: 'Refill', userId: 'u-1', email: 'o@example.com', role: 'owner', allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'EUR' },
};
vi.mock('../session', () => ({ getAccount: () => account, onAccountChange: () => () => {}, authFetch: async () => ({}) }));

const { deleteCoreDb } = await import('../core/db');
const inv = await import('../core/inventory');
const events = await import('../core/sales-events');
const catalog = await import('../core/catalog');
const tx = await import('../core/transactions');
const device = await import('../core/device');

const BOOK = 'p-stickerbook';
const KEYS = 'p-keychain';
const tick = () => new Promise((r) => setTimeout(r, 2));
async function sell(eventId: string, productId: string, qty: number, variantId: string | null = null): Promise<void> {
  await tick();
  const sale: SaleEvent = { saleId: crypto.randomUUID(), eventId, at: Date.now(), currency: 'EUR', total: qty, lines: [{ productId, variantId, sku: null, name: productId, qty, unitPrice: 1, lineTotal: qty, taxRate: null }], payment: { provider: 'manual', approved: true } };
  await tx.recordSale(sale);
}
const setStatus = (id: string, status: 'active' | 'closed') => events.upsertSalesEvent({ ...events.getSalesEvent(id)!, status });
const row = (source: string, productId: string, target = '', variantId = '') => inv.refillPlan(source, target).find((r) => r.productId === productId && r.variantId === variantId)!;
const avail = (id: string, productId: string, variantId = '') => inv.availabilityFor(id).find((r) => r.productId === productId && r.variantId === variantId)!;

beforeEach(async () => {
  await deleteCoreDb(account.accountId);
  inv.resetInventoryCache(); catalog.resetCatalogCache(); tx.resetTransactionCache(); device.resetDeviceCache(); events.resetSalesEventCache();
  await catalog.upsertProduct({ id: BOOK, title: 'Sticker book', price: 1, forSale: true, unlisted: false, variants: [], sortOrder: 0, updatedAt: Date.now() });
  await catalog.upsertProduct({ id: KEYS, title: 'Keychain', price: 1, forSale: true, unlisted: false, variants: [{ id: 'fox', name: 'Fox' }, { id: 'owl', name: 'Owl' }], sortOrder: 1, updatedAt: Date.now() });
  for (const id of ['A', 'B']) await events.upsertSalesEvent({ id, name: id, venue: {}, currency: 'EUR', status: 'active', dateStart: '2999-01-01', updatedAt: 1 } as never);
  await inv.setOnHand(BOOK, '', 30);
  await inv.setOnHand(KEYS, 'fox', 12);
  await inv.setOnHand(KEYS, 'owl', 4);
  await tick();
  await inv.setClaim('A', BOOK, '', 10);
  await inv.setClaim('A', KEYS, 'fox', 6);
  await inv.setClaim('A', KEYS, 'owl', 4);
});

describe('refilling the boxes', () => {
  it('says what came back, what to put in and what is at home, most to put in first', async () => {
    await sell('A', BOOK, 7);
    await sell('A', KEYS, 2, 'fox');
    await sell('A', KEYS, 4, 'owl');
    await setStatus('A', 'closed');
    const plan = inv.refillPlan('A', 'B');
    expect(plan.map((r) => [r.label, r.claimed, r.sold, r.inBox, r.need, r.home, r.refill])).toEqual([
      // 30 counted, 7 sold, 3 in the box: 20 at home, 7 to put in.
      ['Sticker book', 10, 7, 3, 7, 20, 7],
      // All 4 owls sold and none at home: the box stays short.
      ['Keychain · Owl', 4, 4, 0, 4, 0, 0],
      ['Keychain · Fox', 6, 2, 4, 2, 6, 2],
    ]);
  });

  it('claims the box plus the refill for the next event, carried on and taken from home', async () => {
    await sell('A', BOOK, 7);
    await setStatus('A', 'closed');
    const done = await inv.claimRefill('A', 'B');
    // Book 3 + 7, fox 6 + 0, owl 4 + 0.
    expect(done).toEqual({ items: 3, units: 20 });
    expect(inv.claimFor('B', BOOK)).toBe(10);
    expect(avail('B', BOOK)).toMatchObject({ source: 'claim', available: 10 });
    // 23 left of the pile, 10 of it in the box for B: 13 free.
    expect(inv.freeFor(BOOK)).toBe(13);
    // The plan reads the same afterwards, so claiming again changes nothing.
    expect(row('A', BOOK, 'B')).toMatchObject({ inBox: 3, need: 7, home: 20, refill: 7 });
    await inv.claimRefill('A', 'B');
    expect(inv.claimFor('B', BOOK)).toBe(10);
    expect(inv.freeFor(BOOK)).toBe(13);
  });

  it('works with the first event still open: the box moves on and is not reserved twice', async () => {
    await sell('A', BOOK, 7);
    expect(row('A', BOOK, 'B')).toMatchObject({ inBox: 3, home: 20, refill: 7 });
    await inv.claimRefill('A', 'B');
    expect(avail('A', BOOK)).toMatchObject({ source: 'claim', available: 0 });
    expect(avail('B', BOOK)).toMatchObject({ source: 'claim', available: 10 });
    expect(inv.freeFor(BOOK)).toBe(13);
    expect(row('A', BOOK, 'B')).toMatchObject({ inBox: 3, home: 20 });
  });

  it('puts in only what home has, takes a typed figure, and leaves out what nothing would go in for', async () => {
    await inv.setOnHand(BOOK, '', 12); // 10 in A's box, 2 at home
    await tick();
    await sell('A', BOOK, 7);
    await sell('A', KEYS, 4, 'owl');
    await setStatus('A', 'closed');
    expect(row('A', BOOK, 'B')).toMatchObject({ inBox: 3, need: 7, home: 2, refill: 2 });
    const done = await inv.claimRefill('A', 'B', { [inv.stockKey(KEYS, 'fox')]: 1 });
    expect(inv.claimFor('B', BOOK)).toBe(5);
    expect(inv.claimFor('B', KEYS, 'fox')).toBe(7);
    // Sold out with nothing at home: no claim of 0, B keeps selling it from the pool.
    expect(inv.claimFor('B', KEYS, 'owl')).toBeNull();
    expect(done).toEqual({ items: 2, units: 12 });
  });

  it('claims only the items asked for, and refuses the same event or none', async () => {
    await sell('A', BOOK, 7);
    await setStatus('A', 'closed');
    await inv.claimRefill('A', 'B', {}, new Set([inv.stockKey(BOOK, '')]));
    expect(inv.claimFor('B', BOOK)).toBe(10);
    expect(inv.claimFor('B', KEYS, 'fox')).toBeNull();
    await expect(inv.claimRefill('A', 'A')).rejects.toThrow();
    await expect(inv.claimRefill('A', '')).rejects.toThrow();
  });

  it('an item never counted has no home figure and is filled to the claim', async () => {
    await catalog.upsertProduct({ id: 'p-new', title: 'New print', price: 1, forSale: true, unlisted: false, variants: [], sortOrder: 2, updatedAt: Date.now() });
    await inv.setClaim('A', 'p-new', '', 5);
    await sell('A', 'p-new', 5);
    expect(row('A', 'p-new', 'B')).toMatchObject({ inBox: 0, need: 5, home: null, refill: 5 });
  });
});
