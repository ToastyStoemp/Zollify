import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGateway } from '@zollify/server-core';
import { receiptsServerModule } from '../modules/receipts';
import { additional, readPayment } from '../modules/adyen-terminal';

/**
 * Adyen terminals against a pretend Adyen: the credential is proved before
 * it is kept, a payment reaches the terminal and comes back approved with
 * the card details, a refusal and a cancel read as such, a different amount
 * is never an approval, and a lost answer is recovered from Adyen's own
 * record of the transaction.
 */

const PASSWORD = 'correct horse battery staple';
const KEY = 'AQEyhmfxK4...testkey...';
const POI = 'V400m-347395464';

// ── A pretend Adyen ──────────────────────────────────────────────────────────
const adyen = {
  /** What the next payment comes to on the terminal. */
  outcome: 'approve' as 'approve' | 'refuse' | 'cancel' | 'wrong-amount' | 'drop',
  delayMs: 50,
  aborted: [] as string[],
  statusAsked: [] as string[],
  lastPayment: null as null | { ServiceID: string; amount: number; currency: string; reference: string },
  listRole: true,
};
const paymentResponse = (amount: number, currency: string, serviceId: string, kind: typeof adyen.outcome) => {
  const header = { MessageCategory: 'Payment', MessageType: 'Response', SaleID: 'Zollify', ServiceID: serviceId, POIID: POI };
  if (kind === 'refuse') return { SaleToPOIResponse: { MessageHeader: header, PaymentResponse: { Response: { Result: 'Failure', ErrorCondition: 'Refusal', AdditionalResponse: 'message=Declined&refusalReason=Not%20enough%20balance&pspReference=REF123' } } } };
  if (kind === 'cancel') return { SaleToPOIResponse: { MessageHeader: header, PaymentResponse: { Response: { Result: 'Failure', ErrorCondition: 'Aborted', AdditionalResponse: 'message=Cancelled' } } } };
  const paid = kind === 'wrong-amount' ? amount + 1 : amount;
  return {
    SaleToPOIResponse: {
      MessageHeader: header,
      PaymentResponse: {
        Response: { Result: 'Success', AdditionalResponse: Buffer.from(JSON.stringify({ additionalData: { pspReference: 'PSP00042', authCode: '123456', cardSummary: '1234', paymentMethod: 'visa' } })).toString('base64') },
        POIData: { POITransactionID: { TransactionID: 'tx-1' } },
        PaymentResult: { AmountsResp: { Currency: currency, AuthorizedAmount: paid }, PaymentInstrumentData: { CardData: { PaymentBrand: 'visa', MaskedPan: '541333 **** 1234' } }, PaymentAcquirerData: { ApprovalCode: '123456' } },
      },
    },
  };
};
const realFetch = globalThis.fetch;
const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  const key = (init?.headers as Record<string, string> | undefined)?.['x-API-key'];
  if (u.startsWith('https://management-test.adyen.com/')) {
    if (key !== KEY) return new Response('{"status":401}', { status: 401 });
    if (!adyen.listRole) return new Response('{"status":403}', { status: 403 });
    if (!u.includes('/merchants/ShopECOM/')) return new Response('{"status":422}', { status: 422 });
    return new Response(JSON.stringify({ data: [{ id: POI, model: 'V400m', serialNumber: '347-395-464', displayName: 'Front counter' }] }), { status: 200 });
  }
  if (u === 'https://terminal-api-test.adyen.com/sync') {
    if (key !== KEY) return new Response('{"status":401}', { status: 401 });
    const req = JSON.parse(String(init?.body)).SaleToPOIRequest as { MessageHeader: { MessageCategory: string; ServiceID: string }; PaymentRequest?: { SaleData: { SaleTransactionID: { TransactionID: string } }; PaymentTransaction: { AmountsReq: { Currency: string; RequestedAmount: number } } }; AbortRequest?: { MessageReference: { ServiceID: string } }; TransactionStatusRequest?: { MessageReference: { ServiceID: string } } };
    if (req.MessageHeader.MessageCategory === 'Payment') {
      const { Currency, RequestedAmount } = req.PaymentRequest!.PaymentTransaction.AmountsReq;
      adyen.lastPayment = { ServiceID: req.MessageHeader.ServiceID, amount: RequestedAmount, currency: Currency, reference: req.PaymentRequest!.SaleData.SaleTransactionID.TransactionID };
      await new Promise((r) => setTimeout(r, adyen.delayMs));
      if (adyen.outcome === 'drop') throw new TypeError('fetch failed');
      const kind = adyen.aborted.includes(req.MessageHeader.ServiceID) ? 'cancel' : adyen.outcome;
      return new Response(JSON.stringify(paymentResponse(RequestedAmount, Currency, req.MessageHeader.ServiceID, kind)), { status: 200 });
    }
    if (req.MessageHeader.MessageCategory === 'Abort') {
      adyen.aborted.push(req.AbortRequest!.MessageReference.ServiceID);
      return new Response('', { status: 200 });
    }
    if (req.MessageHeader.MessageCategory === 'TransactionStatus') {
      const id = req.TransactionStatusRequest!.MessageReference.ServiceID;
      adyen.statusAsked.push(id);
      const last = adyen.lastPayment;
      if (!last || last.ServiceID !== id) return new Response(JSON.stringify({ SaleToPOIResponse: { TransactionStatusResponse: { Response: { Result: 'Failure', ErrorCondition: 'NotFound' } } } }), { status: 200 });
      return new Response(JSON.stringify({ SaleToPOIResponse: { TransactionStatusResponse: { Response: { Result: 'Success' }, RepeatedMessageResponse: { RepeatedResponseMessageBody: paymentResponse(last.amount, last.currency, id, 'approve').SaleToPOIResponse } } } }), { status: 200 });
    }
  }
  return realFetch(url, init);
});

// ── Zollify ──────────────────────────────────────────────────────────────────
let app: FastifyInstance;
let dataDir: string;
let owner: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) => app.inject({ method, url: `/api/m/pos${url}`, headers: auth(owner), ...(payload !== undefined ? { payload } : {}) });
const settle = async (ref: string, until: (s: string) => boolean): Promise<{ state: string } & Record<string, unknown>> => {
  let last: { state: string } & Record<string, unknown> = { state: 'sent' };
  for (let i = 0; i < 100; i++) {
    last = (await call('GET', `/adyen/payments/${ref}`)).json();
    if (until(last.state)) return last;
    await new Promise((r) => setTimeout(r, 20));
  }
  return last;
};
const pay = async (amount = 12.5) => (await call('POST', '/adyen/payments', { amount, currency: 'EUR', reference: 'sale-1', poiId: POI })).json().referenceId as string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-adyen-'));
  process.env.OWNER_EMAIL = 'shop@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  vi.stubGlobal('fetch', fakeFetch);
  app = await buildGateway({ dataDir, moduleStoreDir: join(dataDir, 'modules'), jwtSecret: 'test-secret-value-long-enough-for-signing', serverModules: [receiptsServerModule('test-secret-value-long-enough-for-signing')], defaultModules: ['pos'], allowedOrigins: [], requireHttps: false, trustProxy: false, logLevel: 'silent' });
  await app.ready();
  owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shop@example.test', password: PASSWORD } })).json().accessToken;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe("reading Adyen's answers", () => {
  it('takes AdditionalResponse as key=value or as base64 JSON', () => {
    expect(additional('message=Declined&refusalReason=Not%20enough%20balance')).toEqual({ message: 'Declined', refusalReason: 'Not enough balance' });
    expect(additional(Buffer.from('{"additionalData":{"pspReference":"X"}}').toString('base64'))).toEqual({ pspReference: 'X' });
    expect(additional(undefined)).toEqual({});
  });

  it('never approves for a different amount or currency', () => {
    const ok = paymentResponse(10, 'EUR', 'abc', 'approve').SaleToPOIResponse.PaymentResponse;
    expect(readPayment(ok, { amount: 10, currency: 'EUR' })).toMatchObject({ state: 'approved', detail: { pspReference: 'PSP00042', cardBrand: 'visa', last4: '1234', authCode: '123456', transactionId: 'tx-1' } });
    expect(readPayment(ok, { amount: 10, currency: 'DKK' }).state).toBe('declined');
    expect(readPayment(paymentResponse(10, 'EUR', 'abc', 'wrong-amount').SaleToPOIResponse.PaymentResponse, { amount: 10, currency: 'EUR' })).toMatchObject({ state: 'declined', detail: { message: /different amount/ } });
    expect(readPayment(undefined, { amount: 10, currency: 'EUR' })).toMatchObject({ state: 'declined' });
  });
});

describe('the credential', () => {
  it('is proved with Adyen before it is kept, and the key never comes back', async () => {
    expect((await call('GET', '/adyen/status')).json()).toMatchObject({ configured: false, canManage: true });
    const bad = await call('PUT', '/adyen/app', { apiKey: 'nope-nope-nope', merchantAccount: 'ShopECOM', environment: 'test' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/API key/);
    const wrongMerchant = await call('PUT', '/adyen/app', { apiKey: KEY, merchantAccount: 'Other', environment: 'test' });
    expect(wrongMerchant.statusCode).toBe(400);
    const ok = await call('PUT', '/adyen/app', { apiKey: KEY, merchantAccount: 'ShopECOM', environment: 'test' });
    expect(ok.json()).toEqual({ app: { merchantAccount: 'ShopECOM', environment: 'test', keyHint: 'y...' }, canList: true });
    expect(ok.body).not.toContain(KEY);
    expect((await call('GET', '/adyen/terminals')).json()).toEqual({ canList: true, terminals: [{ id: POI, model: 'V400m', serial: '347-395-464', name: 'Front counter' }] });
  });

  it('is kept without the listing role, so the till types the terminal id', async () => {
    adyen.listRole = false;
    expect((await call('PUT', '/adyen/app', { apiKey: '', merchantAccount: 'ShopECOM', environment: 'test' })).json()).toMatchObject({ canList: false });
    expect((await call('GET', '/adyen/terminals')).json()).toEqual({ canList: false, terminals: [] });
    adyen.listRole = true;
    await call('PUT', '/adyen/app', { apiKey: '', merchantAccount: 'ShopECOM', environment: 'test' });
  });
});

describe('a payment', () => {
  it('reaches the terminal with the amount and comes back approved with the card', async () => {
    adyen.outcome = 'approve';
    const ref = await pay(12.5);
    const o = await settle(ref, (s) => s !== 'sent');
    expect(o).toMatchObject({ state: 'approved', pspReference: 'PSP00042', cardBrand: 'visa', last4: '1234', authCode: '123456' });
    expect(adyen.lastPayment).toMatchObject({ amount: 12.5, currency: 'EUR', reference: 'sale-1' });
    expect(adyen.lastPayment!.ServiceID).toMatch(/^[a-z0-9]{1,10}$/);
  });

  it('refuses a terminal id that is not one, and a sale without a credential', async () => {
    expect((await call('POST', '/adyen/payments', { amount: 1, currency: 'EUR', poiId: 'nonsense' })).statusCode).toBe(400);
  });

  it('a refusal says why', async () => {
    adyen.outcome = 'refuse';
    const o = await settle(await pay(), (s) => s !== 'sent');
    expect(o).toMatchObject({ state: 'declined', message: 'Not enough balance', pspReference: 'REF123' });
  });

  it('a different amount from the terminal is a decline, not a sale', async () => {
    adyen.outcome = 'wrong-amount';
    const o = await settle(await pay(20), (s) => s !== 'sent');
    expect(o).toMatchObject({ state: 'declined', message: /different amount/ });
  });

  it('cancelling from the till aborts it on the terminal', async () => {
    adyen.outcome = 'approve';
    adyen.delayMs = 300;
    const ref = await pay();
    expect((await call('POST', `/adyen/payments/${ref}/cancel`)).json()).toEqual({ state: 'sent' });
    const o = await settle(ref, (s) => s !== 'sent');
    expect(o.state).toBe('cancelled');
    expect(adyen.aborted).toHaveLength(1);
    adyen.delayMs = 50;
  });

  it('a lost answer is recovered from Adyen rather than guessed', async () => {
    adyen.outcome = 'drop';
    const ref = await pay(7);
    const o = await settle(ref, (s) => s !== 'sent');
    expect(adyen.statusAsked).toHaveLength(1);
    expect(o).toMatchObject({ state: 'approved', pspReference: 'PSP00042' });
    adyen.outcome = 'approve';
  });

  it('removing the credential ends it all', async () => {
    expect((await call('DELETE', '/adyen/app')).json()).toEqual({ ok: true });
    expect((await call('POST', '/adyen/payments', { amount: 1, currency: 'EUR', poiId: POI })).statusCode).toBe(409);
  });
});
