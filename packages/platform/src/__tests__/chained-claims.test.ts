import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, SaleEvent } from '@zollify/sdk';

/**
 * Events chained on one another: A claims stock, B takes over what A has left.
 * The figures must hold at every step - with A closed first or still open, A
 * reopened, a recount in between, or A selling past its claim - not only once
 * both are over. "free" is what an event without a claim can still sell.
 */

const account: AccountSnapshot = {
  accountId: 'acct-chain', accountName: 'Chain', userId: 'u-1', email: 'o@example.com', role: 'owner', allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'CHF' },
};
vi.mock('../session', () => ({ getAccount: () => account, onAccountChange: () => () => {}, authFetch: async () => ({}) }));

const { deleteCoreDb } = await import('../core/db');
const inv = await import('../core/inventory');
const events = await import('../core/sales-events');
const catalog = await import('../core/catalog');
const tx = await import('../core/transactions');
const device = await import('../core/device');
const lock = await import('../core/sell-lock');
const P = 'p-print';

const tick = () => new Promise((r) => setTimeout(r, 2));
async function sell(eventId: string, qty: number): Promise<void> {
  await tick();
  const sale: SaleEvent = { saleId: crypto.randomUUID(), eventId, at: Date.now(), currency: 'CHF', total: qty, lines: [{ productId: P, variantId: null, sku: null, name: 'Print', qty, unitPrice: 1, lineTotal: qty, taxRate: null }], payment: { provider: 'manual', approved: true } };
  await tx.recordSale(sale);
}
const setStatus = (id: string, status: 'active' | 'closed') => events.upsertSalesEvent({ ...events.getSalesEvent(id)!, status });
const avail = (id: string) => inv.availabilityFor(id).find((r) => r.productId === P)!;
/** physical left, free, what A and B can sell (and from where). */
const state = () => ({ physical: inv.remainingFor(P), free: inv.freeFor(P), A: `${avail('A').source}:${avail('A').available}`, B: `${avail('B').source}:${avail('B').available}` });

beforeEach(async () => {
  await deleteCoreDb(account.accountId);
  inv.resetInventoryCache(); catalog.resetCatalogCache(); tx.resetTransactionCache(); device.resetDeviceCache(); events.resetSalesEventCache();
  await catalog.upsertProduct({ id: P, title: 'Print', price: 1, forSale: true, unlisted: false, variants: [], sortOrder: 0, updatedAt: Date.now() });
  for (const id of ['A', 'B']) await events.upsertSalesEvent({ id, name: id, venue: {}, currency: 'CHF', status: 'active', dateStart: '2999-01-01', updatedAt: 1 } as never);
  await inv.setOnHand(P, '', 100);
  await tick();
  await inv.setClaim('A', P, '', 30);
});

describe('chained claims', () => {
  it('A closed first, then B takes its leftovers', async () => {
    await sell('A', 20);
    await setStatus('A', 'closed');
    await inv.claimUnsoldFrom('A', 'B');
    expect(state()).toEqual({ physical: 80, free: 70, A: 'pool:70', B: 'claim:10' });
    await sell('B', 5);
    expect(state()).toEqual({ physical: 75, free: 70, A: 'pool:70', B: 'claim:5' });
    await setStatus('B', 'closed');
    expect(state()).toEqual({ physical: 75, free: 75, A: 'pool:75', B: 'pool:75' });
  });

  it('B takes the leftovers while A is still open: reserved once, and A no longer sells them', async () => {
    await sell('A', 20);
    await inv.claimUnsoldFrom('A', 'B');
    expect(state()).toEqual({ physical: 80, free: 70, A: 'claim:0', B: 'claim:10' });
    // A's own claim stays as it was, for customs and the packing list.
    expect(inv.claimFor('A', P)).toBe(30);
    await sell('A', 3); // sold past what it kept: shows as oversold, comes off the pile
    expect(state()).toMatchObject({ physical: 77, free: 67, A: 'claim:-3' });
    await setStatus('A', 'closed');
    await sell('B', 5);
    await setStatus('B', 'closed');
    expect(state()).toEqual({ physical: 72, free: 72, A: 'pool:72', B: 'pool:72' });
  });

  it('reopening A after B took its leftovers does not reserve them again', async () => {
    await sell('A', 20);
    await setStatus('A', 'closed');
    await inv.claimUnsoldFrom('A', 'B');
    await setStatus('A', 'active');
    expect(state()).toEqual({ physical: 80, free: 70, A: 'claim:0', B: 'claim:10' });
  });

  it('a recount while A runs does not keep its earlier sales reserved', async () => {
    await sell('A', 20);
    await inv.setOnHand(P, '', 80);
    await tick();
    expect(state()).toEqual({ physical: 80, free: 70, A: 'claim:10', B: 'pool:70' });
    await inv.claimUnsoldFrom('A', 'B');
    expect(state()).toEqual({ physical: 80, free: 70, A: 'claim:0', B: 'claim:10' });
  });

  it('nothing left at A: B is not given a claim of 0 and keeps selling from the pool', async () => {
    await sell('A', 34);
    expect(await inv.claimUnsoldFrom('A', 'B')).toBe(0);
    expect(inv.claimFor('B', P)).toBeNull();
    expect(state()).toEqual({ physical: 66, free: 66, A: 'claim:-4', B: 'pool:66' });
  });

  it('taking the leftovers again takes what is left now, and an edit keeps where the stock came from', async () => {
    await sell('A', 20);
    await inv.claimUnsoldFrom('A', 'B');
    await inv.claimUnsoldFrom('A', 'B');
    expect(inv.claimFor('B', P)).toBe(10);
    await inv.setClaim('B', P, '', 12); // two more, from the pile
    expect(state()).toEqual({ physical: 80, free: 68, A: 'claim:0', B: 'claim:12' });
  });
});

describe('Sell 🔒', () => {
  beforeEach(async () => {
    await lock.setSellLockSettings({ allowForce: false });
  });

  it('locks A once B, holding its leftovers, is open - also after A is reopened', async () => {
    await events.upsertSalesEvent({ ...events.getSalesEvent('B')!, status: 'planned' });
    await sell('A', 20);
    await inv.claimUnsoldFrom('A', 'B');
    expect(lock.sellLocked('A')).toBe(false); // B has not opened yet
    await setStatus('B', 'active');
    expect(lock.sellLocked('A')).toBe(true);
    expect(lock.sellLockFor('A')!.by.map((e) => e.id)).toEqual(['B']);
    expect(lock.sellLocked('B')).toBe(false);
    await setStatus('A', 'closed');
    await setStatus('A', 'active');
    expect(lock.sellLocked('A')).toBe(true);
  });

  it('no leftovers taken, no lock', async () => {
    await sell('A', 30);
    await inv.claimUnsoldFrom('A', 'B');
    expect(lock.sellLockFor('A')).toBeNull();
  });

  it('forcing is refused by default, and only holds while the account allows it', async () => {
    await sell('A', 20);
    await inv.claimUnsoldFrom('A', 'B');
    expect(lock.canForceSell()).toBe(false);
    await expect(lock.forceSell('A', true)).rejects.toThrow();
    await lock.setSellLockSettings({ allowForce: true });
    await lock.forceSell('A', true);
    expect(lock.sellLocked('A')).toBe(false);
    await lock.setSellLockSettings({ allowForce: false });
    expect(lock.sellLocked('A')).toBe(true);
    await lock.setSellLockSettings({ allowForce: true });
    await lock.forceSell('A', false);
    expect(lock.sellLocked('A')).toBe(true);
  });
});
