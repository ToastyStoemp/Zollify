import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, SaleEvent } from '@zollify/sdk';
import type { TseSignature } from '@zollify/shared';

/**
 * The fiskaly driver: a device asks the server to sign, under its own till
 * serial number, and the receipt carries exactly what fiskaly says it signed.
 */

const account: AccountSnapshot = {
  accountId: 'acct-fiskaly',
  accountName: 'fiskaly',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'EUR' },
};

const calls: { path: string; body?: Record<string, unknown> }[] = [];
let online = true;
vi.mock('../session', () => ({
  getAccount: () => account,
  onAccountChange: () => () => {},
  authFetch: async (path: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ path, body });
    if (!online) throw new Error('Failed to fetch');
    if (path === '/m/pos/fiskaly') return { configured: true, env: 'LIVE', tss: { id: 'tss-1', state: 'INITIALIZED', serial: 'fiskaly-serial' } };
    if (path === '/m/pos/fiskaly/start') return { number: 41, time: Date.parse('2026-09-12T10:00:00Z') };
    if (path === '/m/pos/fiskaly/finish') {
      return {
        signatureCounter: 99,
        time: Date.parse('2026-09-12T10:00:05Z'),
        signature: 'FISKALY-SIG',
        info: { serial: 'fiskaly-serial', publicKey: 'FISKALY-PUB', algorithm: 'ecdsa-plain-SHA256', timeFormat: 'unixTime', certified: true },
        exact: { clientId: body!.clientId, processType: 'Kassenbeleg-V1', processData: body!.processData, start: '2026-09-12T10:00:00.000Z', finish: '2026-09-12T10:00:05.000Z' },
      };
    }
    return {};
  },
}));

const { deleteCoreDb } = await import('../core/db');
const txs = await import('../core/transactions');
const events = await import('../core/sales-events');
const device = await import('../core/device');
const tse = await import('../core/tse');

function sale(): SaleEvent {
  return {
    saleId: crypto.randomUUID(),
    eventId: 'ev-de',
    at: Date.now(),
    currency: 'EUR',
    total: 21,
    lines: [{ productId: 'p1', variantId: null, sku: null, name: 'Print', qty: 1, unitPrice: 21, lineTotal: 21, taxRate: 19 }],
    tax: { country: 'DE', exempt: false, rates: [19] },
    payment: { provider: 'manual', approved: true, method: 'cash' },
  };
}

beforeEach(async () => {
  await deleteCoreDb(account.accountId);
  txs.resetTransactionCache();
  device.resetDeviceCache();
  events.resetSalesEventCache();
  tse.resetTseCache();
  calls.length = 0;
  online = true;
  await events.upsertSalesEvent({ id: 'ev-de', name: 'Leipzig', venue: { country: 'Germany' }, currency: 'EUR', status: 'active', updatedAt: 1 });
  await tse.loadTseSettings();
  await tse.setTseSettings({ driver: 'fiskaly', clientId: 'ZOLLIFY-PHONE1' });
});

describe('the fiskaly driver', () => {
  it('signs through the server under this till, and keeps exactly what fiskaly signed', async () => {
    const tx = await txs.recordSale(sale());
    const sig = (tx.tse as { signed: TseSignature }).signed;
    expect(sig).toEqual({
      clientId: 'ZOLLIFY-PHONE1',
      serial: 'fiskaly-serial',
      transactionNumber: 41,
      signatureCounter: 99,
      start: '2026-09-12T10:00:00.000Z',
      finish: '2026-09-12T10:00:05.000Z',
      algorithm: 'ecdsa-plain-SHA256',
      timeFormat: 'unixTime',
      signature: 'FISKALY-SIG',
      publicKey: 'FISKALY-PUB',
      processType: 'Kassenbeleg-V1',
      processData: 'Beleg^21.00_0.00_0.00_0.00_0.00^21.00:Bar',
    });
    expect(calls.map((c) => c.path)).toEqual(['/m/pos/fiskaly/start', '/m/pos/fiskaly/finish']);
    expect(calls[0]!.body).toEqual({ clientId: 'ZOLLIFY-PHONE1' });
    expect(calls[1]!.body).toMatchObject({ clientId: 'ZOLLIFY-PHONE1', number: 41, processType: 'Kassenbeleg-V1' });
  });

  it('records the sale as not signed when offline, like any TSE outage', async () => {
    online = false;
    expect((await txs.recordSale(sale())).tse).toMatchObject({ failed: { reason: 'Failed to fetch' } });
  });

  it('reports the cloud TSE as ready in Settings', async () => {
    expect(await tse.refreshTseInfo()).toMatchObject({ serial: 'fiskaly-serial', certified: true });
  });
});
