import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, SaleEvent } from '@zollify/sdk';
import type { TseSignature } from '@zollify/shared';

/**
 * KassenSichV signing end to end in core, against the test TSE: a sale in
 * Germany is signed over exactly the figures its receipt prints, the
 * signature checks out against the published key, an outage never stops a
 * sale, and a reverted sale gets a signed cancelling receipt.
 */

const account: AccountSnapshot = {
  accountId: 'acct-tse',
  accountName: 'TSE Test',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'EUR' },
};

vi.mock('../session', () => ({
  getAccount: () => account,
  onAccountChange: () => () => {},
  authFetch: async () => ({}),
}));

const { deleteCoreDb } = await import('../core/db');
const txs = await import('../core/transactions');
const events = await import('../core/sales-events');
const device = await import('../core/device');
const tse = await import('../core/tse');

const EVENT = { venue: {}, currency: 'EUR', status: 'active' as const, updatedAt: 1 };

function sale(over: Partial<SaleEvent> = {}): SaleEvent {
  return {
    saleId: crypto.randomUUID(),
    eventId: 'ev-de',
    at: Date.now(),
    currency: 'EUR',
    total: 50.7,
    lines: [
      { productId: 'p1', variantId: null, sku: null, name: 'Print', qty: 2, unitPrice: 20, lineTotal: 40, taxRate: 19 },
      { productId: 'p2', variantId: null, sku: null, name: 'Artbook', qty: 1, unitPrice: 10.7, lineTotal: 10.7, taxRate: 7 },
    ],
    tax: { country: 'DE', exempt: false, rates: [19, 7] },
    payment: { provider: 'manual', approved: true, method: 'cash' },
    ...over,
  };
}

async function verify(sig: TseSignature): Promise<boolean> {
  const raw = Uint8Array.from(atob(sig.publicKey), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-384' }, false, ['verify']);
  const message = new TextEncoder().encode([sig.clientId, sig.transactionNumber, sig.signatureCounter, Math.floor(Date.parse(sig.finish) / 1000), sig.processType, sig.processData].join('|'));
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-384' }, key, Uint8Array.from(atob(sig.signature), (c) => c.charCodeAt(0)), message);
}

beforeEach(async () => {
  await deleteCoreDb(account.accountId);
  txs.resetTransactionCache();
  device.resetDeviceCache();
  events.resetSalesEventCache();
  tse.resetTseCache();
  await events.upsertSalesEvent({ ...EVENT, id: 'ev-de', name: 'Leipzig', venue: { country: 'Germany' } });
  await events.upsertSalesEvent({ ...EVENT, id: 'ev-it', name: 'Milan', venue: { country: 'Italy' } });
  await tse.setTseSettings({ driver: 'test', clientId: 'ZOLLIFY-TEST1', scope: 'germany' });
});

describe('signing sales', () => {
  it('signs a sale in Germany over the receipt’s figures, verifiably', async () => {
    const tx = await txs.recordSale(sale());
    expect(tx.tse && 'signed' in tx.tse).toBe(true);
    const sig = (tx.tse as { signed: TseSignature }).signed;
    expect(sig).toMatchObject({
      clientId: 'ZOLLIFY-TEST1',
      processType: 'Kassenbeleg-V1',
      processData: 'Beleg^40.00_10.70_0.00_0.00_0.00^50.70:Bar',
      algorithm: 'ecdsa-plain-SHA384',
      test: true,
    });
    expect(sig.serial).toMatch(/^[0-9a-f]{64}$/);
    expect(await verify(sig)).toBe(true);
    expect(await verify({ ...sig, processData: 'Beleg^1.00_0.00_0.00_0.00_0.00^1.00:Bar' })).toBe(false);
  });

  it('leaves sales outside Germany alone, unless told to sign everything', async () => {
    expect((await txs.recordSale(sale({ eventId: 'ev-it', tax: { country: 'IT', exempt: false, rates: [22, 10] } }))).tse).toBeUndefined();
    await tse.setTseSettings({ scope: 'always' });
    expect((await txs.recordSale(sale({ eventId: 'ev-it', tax: { country: 'DE', exempt: false, rates: [19, 7] } }))).tse).toBeDefined();
  });

  it('counts transactions and signatures up, sale after sale', async () => {
    const a = (await txs.recordSale(sale())).tse as { signed: TseSignature };
    const b = (await txs.recordSale(sale())).tse as { signed: TseSignature };
    expect(b.signed.transactionNumber).toBe(a.signed.transactionNumber + 1);
    expect(b.signed.signatureCounter).toBeGreaterThan(a.signed.signatureCounter);
  });

  it('finishes the transaction started at the sale’s first item', async () => {
    const handle = await tse.beginTse();
    expect('number' in handle).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const tx = await txs.recordSale(sale({ tseHandle: handle }));
    const sig = (tx.tse as { signed: TseSignature }).signed;
    expect(sig.transactionNumber).toBe((handle as { number: number }).number);
    expect(Date.parse(sig.start)).toBeLessThan(Date.parse(sig.finish));
  });

  it('keeps selling when the TSE fails, and says why on the sale', async () => {
    tse.registerTseDriver('test', {
      available: async () => true,
      info: async () => ({ serial: 'x', publicKey: 'y', algorithm: 'a', timeFormat: 'unixTime', certified: true }),
      start: async () => {
        throw new Error('TSE not responding');
      },
      finish: async () => {
        throw new Error('unreachable');
      },
    });
    const tx = await txs.recordSale(sale());
    expect(tx.tse).toMatchObject({ failed: { reason: 'TSE not responding' } });
    expect(txs.getTransaction(tx.id)).toBeDefined();
  });

  it('records a failure rather than signing what a German TSE cannot describe', async () => {
    const tx = await txs.recordSale(sale({ currency: 'CHF' }));
    expect(tx.tse).toMatchObject({ failed: { reason: expect.stringContaining('EUR') } });
  });
});

describe('cancelling a signed sale', () => {
  it('signs a receipt of its own with the same figures, negative', async () => {
    const tx = await txs.recordSale(sale());
    await txs.revertTransaction(tx.id);
    const reverted = txs.getTransaction(tx.id)!;
    expect(reverted.revertTse, JSON.stringify(reverted.revertTse)).toHaveProperty('signed');
    const sig = (reverted.revertTse as { signed: TseSignature }).signed;
    expect(sig.processData).toBe('Beleg^-40.00_-10.70_0.00_0.00_0.00^-50.70:Bar');
    expect(await verify(sig)).toBe(true);
  });
});
