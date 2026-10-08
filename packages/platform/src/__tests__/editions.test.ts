import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, SaleEvent } from '@zollify/sdk';

const account: AccountSnapshot = {
  accountId: 'acct-editions',
  accountName: 'Editions Test',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'CHF' },
};

vi.mock('../session', () => ({
  getAccount: () => account,
  onAccountChange: () => () => {},
  authFetch: async () => ({}),
}));

const { deleteCoreDb } = await import('../core/db');
const inv = await import('../core/inventory');
const events = await import('../core/sales-events');
const catalog = await import('../core/catalog');
const tx = await import('../core/transactions');
const device = await import('../core/device');
const ed = await import('../core/editions');

const PRINT = 'p-print';
const BASE = { venue: { city: 'Basel' }, currency: 'CHF', updatedAt: 1 };

async function sell(eventId: string, qty: number): Promise<void> {
  const sale: SaleEvent = {
    saleId: crypto.randomUUID(),
    eventId,
    at: Date.now(),
    currency: 'CHF',
    total: 40 * qty,
    lines: [{ productId: PRINT, variantId: null, sku: null, name: 'Harbour print', qty, unitPrice: 40, lineTotal: 40 * qty, taxRate: null }],
    payment: { provider: 'manual', approved: true },
  };
  await tx.recordSale(sale);
}

beforeEach(async () => {
  await deleteCoreDb(account.accountId);
  inv.resetInventoryCache();
  catalog.resetCatalogCache();
  tx.resetTransactionCache();
  device.resetDeviceCache();
  events.resetSalesEventCache();
  await catalog.upsertProduct({ id: PRINT, title: 'Harbour print', price: 40, forSale: true, unlisted: false, variants: [], sortOrder: 0, updatedAt: Date.now() });
  await events.upsertSalesEvent({ ...BASE, id: 'e-2025', name: 'Comic Con', status: 'closed', dateStart: '2025-05-01', dateEnd: '2025-05-03', notes: 'Hall 2', localCurrency: 'SEK', exchangeRate: 11 });
});

describe('createNextEdition', () => {
  it('copies the event into a series, with new dates and label', async () => {
    await inv.setClaim('e-2025', PRINT, null, 12);
    const next = await ed.createNextEdition('e-2025', { label: '2026', dateStart: '2026-05-01', dateEnd: '2026-05-03', stock: 'same' });

    expect(next).toMatchObject({ name: 'Comic Con', notes: 'Hall 2', localCurrency: 'SEK', exchangeRate: 11, status: 'planned', edition: '2026', dateStart: '2026-05-01' });
    expect(next.venue).toEqual({ city: 'Basel' });
    // The source joined the series and is labelled by its year.
    const source = events.getSalesEvent('e-2025')!;
    expect(source.seriesId).toBe(next.seriesId);
    expect(source.edition).toBe('2025');
    expect(ed.editionsOf(next.id).map((e) => e.edition)).toEqual(['2025', '2026']);
    expect(inv.claimFor(next.id, PRINT, null)).toBe(12);
  });

  it('starts empty when asked, and refuses a blank label', async () => {
    await inv.setClaim('e-2025', PRINT, null, 12);
    const next = await ed.createNextEdition('e-2025', { label: '2026', stock: 'none' });
    expect(inv.claimFor(next.id, PRINT, null)).toBeNull();
    await expect(ed.createNextEdition('e-2025', { label: ' ', stock: 'none' })).rejects.toThrow(/label/);
  });
});

describe('series links', () => {
  it('links an existing event, and unlinks it again', async () => {
    await events.upsertSalesEvent({ ...BASE, id: 'e-2027', name: 'Comic Con 27', status: 'planned', dateStart: '2027-05-01' });
    await ed.linkToSeries('e-2027', 'e-2025');
    expect(events.getSalesEvent('e-2027')!.seriesId).toBe(events.getSalesEvent('e-2025')!.seriesId);
    expect(ed.editionsOf('e-2027').map((e) => e.id)).toEqual(['e-2025', 'e-2027']);
    await ed.unlinkFromSeries('e-2027');
    expect(events.getSalesEvent('e-2027')!.seriesId).toBeUndefined();
    expect(ed.editionsOf('e-2027')).toEqual([]);
  });
});

describe('prep planner', () => {
  it('suggests from earlier editions and caps the apply at free stock', async () => {
    await inv.setOnHand(PRINT, null, 30);
    await inv.setClaim('e-2025', PRINT, null, 10);
    await sell('e-2025', 10);
    const next = await ed.createNextEdition('e-2025', { label: '2026', dateStart: '2999-05-01', stock: 'none' });

    const opts = { bufferPct: 50, basis: 'average' as const };
    const [row] = ed.prepPlanFor(next.id, opts);
    expect(row).toMatchObject({ productId: PRINT, suggested: 15, underClaimed: true, claimable: 20, current: null });
    expect(row!.editions[0]).toMatchObject({ units: 10, claimed: 10, soldOut: true, revenue: 400 });

    // The 2025 sales came out of the count, leaving 20; another event holds 10 of them.
    await events.upsertSalesEvent({ ...BASE, id: 'e-other', name: 'Other', status: 'planned', dateStart: '2999-06-01' });
    await inv.setClaim('e-other', PRINT, null, 10);
    const limited = ed.prepPlanFor(next.id, opts);
    expect(ed.grantsFor(limited)[0]).toMatchObject({ wanted: 15, granted: 10, short: 5 });

    await ed.applyPrepPlan(next.id, limited);
    expect(inv.claimFor(next.id, PRINT, null)).toBe(10);
    // Re-planning counts the event's own claim as available to it.
    expect(ed.prepPlanFor(next.id, opts)[0]!.claimable).toBe(10);
  });

  it('has nothing to say without earlier editions that sold', async () => {
    const next = await ed.createNextEdition('e-2025', { label: '2026', dateStart: '2999-05-01', stock: 'none' });
    expect(ed.prepPlanFor(next.id, { bufferPct: 0, basis: 'max' })).toEqual([]);
  });
});
