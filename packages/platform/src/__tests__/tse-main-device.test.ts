import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, SaleEvent } from '@zollify/sdk';
import type { TseRequestMessage, TseResultMessage, TseSignature } from '@zollify/shared';

/**
 * Signing through a main TSE device: a device without a TSE of its own (a
 * backup phone) has its sales signed by one of the account's main TSE
 * devices over the live channel, under its own till serial number - and a
 * main TSE device answers such calls with its own TSE.
 */

const account: AccountSnapshot = {
  accountId: 'acct-tse-main',
  accountName: 'TSE Main',
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

const { deleteCoreDb, openCoreDb } = await import('../core/db');
const txs = await import('../core/transactions');
const events = await import('../core/sales-events');
const device = await import('../core/device');
const tse = await import('../core/tse');

type Msg = TseRequestMessage | TseResultMessage;
const sent: Msg[] = [];
let deliver: (msg: Msg) => void = () => {};
/** How the fake "other devices" answer a request; undefined = nobody answers. */
let answer: (req: TseRequestMessage) => Omit<TseResultMessage, 'type' | 'to' | 'requestId'> | undefined = () => undefined;
let online = true;

tse.setTseTransport({
  send: (msg) => {
    if (!online) return false;
    sent.push(msg);
    if (msg.type === 'tse.request') {
      const r = answer(msg);
      if (r) setTimeout(() => deliver({ type: 'tse.result', to: 'me', requestId: msg.requestId, ...r }), 1);
    }
    return true;
  },
  on: (handler) => {
    deliver = handler;
    return () => {};
  },
});

const HOST_INFO = { serial: 'serial-b', publicKey: 'pk-b', algorithm: 'ecdsa-plain-SHA384', timeFormat: 'unixTime', certified: true };

function sale(): SaleEvent {
  return {
    saleId: crypto.randomUUID(),
    eventId: 'ev-de',
    at: Date.now(),
    currency: 'EUR',
    total: 21,
    lines: [{ productId: 'p1', variantId: null, sku: null, name: 'Print', qty: 1, unitPrice: 21, lineTotal: 21, taxRate: 19 }],
    tax: { country: 'DE', exempt: false, rates: [19] },
    payment: { provider: 'manual', approved: true, method: 'card' },
  };
}

beforeEach(async () => {
  await deleteCoreDb(account.accountId);
  txs.resetTransactionCache();
  device.resetDeviceCache();
  events.resetSalesEventCache();
  tse.resetTseCache();
  sent.length = 0;
  online = true;
  answer = () => undefined;
  await events.upsertSalesEvent({ id: 'ev-de', name: 'Leipzig', venue: { country: 'Germany' }, currency: 'EUR', status: 'active', updatedAt: 1 });
  await tse.loadTseSettings();
});

describe('a device without a TSE of its own', () => {
  it('signs nothing while the account has no main TSE device', async () => {
    expect(tse.tseMode()).toBe('none');
    expect((await txs.recordSale(sale())).tse).toBeUndefined();
  });

  it('signs nothing until the till is assigned to a main TSE device, and is assigned once', async () => {
    tse.applyMainTseDevices(['host-a', 'host-b']);
    expect(tse.tseMode()).toBe('remote');
    expect((await txs.recordSale(sale())).tse).toMatchObject({ failed: { reason: expect.stringContaining('No main TSE device assigned') } });
    await expect(tse.assignTseHost('nobody')).rejects.toThrow('not one of the main TSE devices');
    await tse.assignTseHost('host-a');
    await expect(tse.assignTseHost('host-b')).rejects.toThrow('already has its main TSE device');
    expect(tse.assignedTseHost()).toBe('host-a');
    // A new till serial number is a new till: it gets its own assignment.
    await tse.setTseSettings({ clientId: 'PHONE-2' });
    expect(tse.assignedTseHost()).toBeNull();
  });

  it('signs on its assigned main TSE device, under its own till number', async () => {
    tse.applyMainTseDevices(['host-a', 'host-b']);
    await tse.assignTseHost('host-b');
    answer = (req) => {
      if (req.op === 'start') return { ok: true, number: 7, time: Date.now() };
      if (req.op === 'finish') return { ok: true, signatureCounter: 15, time: Date.now(), signature: 'SIG-B', info: HOST_INFO };
      return undefined;
    };
    const tx = await txs.recordSale(sale());
    const sig = (tx.tse as { signed: TseSignature }).signed;
    const till = tse.defaultTillId(await device.deviceId());
    expect(sig).toMatchObject({ clientId: till, transactionNumber: 7, signatureCounter: 15, signature: 'SIG-B', serial: 'serial-b', publicKey: 'pk-b', processData: 'Beleg^21.00_0.00_0.00_0.00_0.00^21.00:Unbar' });
    expect(sig.test).toBeUndefined();
    expect(sig.substitute).toBeUndefined();
    // Only the assigned device was asked.
    expect(sent.filter((m) => m.type === 'tse.request').every((m) => m.to === 'host-b')).toBe(true);
    expect(sent.filter((m) => m.type === 'tse.request').every((m) => !('clientId' in m) || m.clientId === till)).toBe(true);
    expect(tx.receipt?.till).toBe(till);
    expect(tse.tseState.outages).toEqual([]);
  });

  it('while its own is out, signs on another as a stand-in, logs the outage, and goes back when it returns', async () => {
    tse.applyMainTseDevices(['host-a', 'host-b']);
    await tse.assignTseHost('host-a');
    let aDown = true;
    answer = (req) => {
      if (req.to === 'host-a' && aDown) return { ok: false, error: 'TSE unplugged' };
      if (req.op === 'start') return { ok: true, number: 7, time: Date.now() };
      if (req.op === 'finish') return { ok: true, signatureCounter: 15, time: Date.now(), signature: `SIG-${req.to}`, info: HOST_INFO };
      return undefined;
    };
    const during = ((await txs.recordSale(sale())).tse as { signed: TseSignature }).signed;
    expect(during).toMatchObject({ signature: 'SIG-host-b', substitute: true });
    expect(tse.tseState.outages).toEqual([{ from: expect.any(Number), reason: 'Assigned main TSE device: TSE unplugged' }]);

    aDown = false;
    const after = ((await txs.recordSale(sale())).tse as { signed: TseSignature }).signed;
    expect(after.signature).toBe('SIG-host-a');
    expect(after.substitute).toBeUndefined();
    expect(tse.tseState.outages).toEqual([{ from: expect.any(Number), to: expect.any(Number), reason: 'Assigned main TSE device: TSE unplugged' }]);
    // The log is synced, per till.
    const till = tse.defaultTillId(await device.deviceId());
    const ops = await openCoreDb(account.accountId).ops.toArray();
    expect(ops.some((o) => o.type === 'setting.upsert' && (o.payload as { key: string }).key === `core.tseOutages.${till}`)).toBe(true);
  });

  it('records the sale as not signed, saying why, when no main TSE device can be reached', async () => {
    tse.applyMainTseDevices(['host-a']);
    await tse.assignTseHost('host-a');
    online = false;
    const tx = await txs.recordSale(sale());
    expect(tx.tse).toMatchObject({ failed: { reason: expect.stringContaining('Offline') } });
  });
});

describe('a main TSE device', () => {
  async function ask(req: { from: string; op: TseRequestMessage['op'] } & Record<string, unknown>): Promise<TseResultMessage> {
    const requestId = crypto.randomUUID();
    deliver({ type: 'tse.request', to: await device.deviceId(), requestId, ...req } as TseRequestMessage);
    for (let i = 0; i < 100; i++) {
      const r = sent.find((m) => m.type === 'tse.result' && m.requestId === requestId);
      if (r) return r as TseResultMessage;
      await new Promise((ok) => setTimeout(ok, 5));
    }
    throw new Error('no answer');
  }

  it('signs for another device with its own TSE, under that device’s till number', async () => {
    await tse.setTseSettings({ driver: 'test', clientId: 'MAIN-1' });
    await tse.setMainTseDevice(true);
    const started = await ask({ from: 'phone', op: 'start', clientId: 'PHONE-1' });
    expect(started).toMatchObject({ ok: true, to: 'phone' });
    const done = await ask({ from: 'phone', op: 'finish', clientId: 'PHONE-1', number: started.number!, processType: 'Kassenbeleg-V1', processData: 'Beleg^21.00_0.00_0.00_0.00_0.00^21.00:Unbar' });
    expect(done.ok).toBe(true);
    expect(done.info).toMatchObject({ algorithm: 'ecdsa-plain-SHA384', certified: false });
    const raw = Uint8Array.from(atob(done.info!.publicKey), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-384' }, false, ['verify']);
    const message = new TextEncoder().encode(['PHONE-1', started.number, done.signatureCounter, Math.floor(done.time! / 1000), 'Kassenbeleg-V1', 'Beleg^21.00_0.00_0.00_0.00_0.00^21.00:Unbar'].join('|'));
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-384' }, key, Uint8Array.from(atob(done.signature!), (c) => c.charCodeAt(0)), message)).toBe(true);
  });

  it('refuses once it is no longer a main TSE device, and only a device with a TSE can be one', async () => {
    await expect(tse.setMainTseDevice(true)).rejects.toThrow('TSE of its own');
    await tse.setTseSettings({ driver: 'test', clientId: 'MAIN-1' });
    expect(await ask({ from: 'phone', op: 'info' })).toMatchObject({ ok: false, error: expect.stringContaining('no longer a main TSE device') });
  });
});
