import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGateway } from '@zollify/server-core';

/**
 * MobilePay by QR, with Vipps MobilePay mocked: an account enters keys that
 * are checked before they are kept, a payment is created as a QR with the
 * customer present, and it is only paid once MobilePay says AUTHORIZED and
 * exactly the amount asked has been captured.
 */

const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let payState = 'CREATED';
let capturedValue = 1250;
let paymentValue = 1250;
const sent: { url: string; method: string; body: string; headers: Record<string, string> }[] = [];
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/pos${url}`, headers: auth(owner), ...(payload ? { payload } : {}) });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const keys = { env: 'test', msn: '123456', clientId: 'client-id-0001', clientSecret: 'secret-0001-xyz', subscriptionKey: 'a'.repeat(32) };

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-mobilepay-'));
  Object.assign(process.env, { OWNER_EMAIL: 'owner@mobilepay.test', OWNER_PASSWORD: PASSWORD, REQUIRE_CAPTCHA: '0' });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://apitest.vipps.no')) return real(input, init);
    const method = init?.method ?? 'GET';
    const body = String(init?.body ?? '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ url, method, body, headers });
    if (url.endsWith('/accesstoken/get')) return headers.client_secret === keys.clientSecret ? json(200, { access_token: 'tok-1', expires_in: '3600' }) : json(401, { title: 'Unauthorized' });
    if (headers.authorization !== 'Bearer tok-1') return json(401, {});
    if (url.endsWith('/epayment/v1/payments') && method === 'POST') return json(201, { reference: JSON.parse(body).reference, redirectUrl: 'https://qr.vipps.no/pay/abc123' });
    const m = /\/epayment\/v1\/payments\/([^/]+)(\/(capture|cancel))?$/.exec(url);
    if (m && !m[3] && method === 'GET') return json(200, { state: payState, amount: { currency: 'DKK', value: paymentValue }, pspReference: 'psp-1', aggregate: {} });
    if (m && m[3] === 'capture') return json(200, { aggregate: { capturedAmount: { currency: 'DKK', value: capturedValue } } });
    if (m && m[3] === 'cancel') return json(200, { state: 'TERMINATED' });
    return json(404, {});
  });
  const { receiptsServerModule } = await import('../modules/receipts');
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [receiptsServerModule('test-secret-value-long-enough-for-signing')],
    defaultModules: ['pos'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@mobilepay.test', password: PASSWORD } })).json().accessToken;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.REQUIRE_CAPTCHA;
});

const settle = () => new Promise((r) => setTimeout(r, 2100));

describe('MobilePay by QR', () => {
  it('keeps keys only once MobilePay accepts them, and never hands them back', async () => {
    expect((await call('GET', '/mobilepay/status')).json()).toMatchObject({ connected: false, canManage: true });
    expect((await call('POST', '/mobilepay/payments', { amount: 1250, currency: 'DKK' })).statusCode).toBe(409);
    const bad = await call('PUT', '/mobilepay/keys', { ...keys, clientSecret: 'wrong-secret-1' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('did not accept');
    const ok = await call('PUT', '/mobilepay/keys', keys);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ connected: true, env: 'test', msn: '123456' });
    expect(ok.body).not.toContain(keys.clientSecret);
    expect(ok.body).not.toContain(keys.subscriptionKey);
  });

  it('creates a customer-present QR payment and is paid only when authorised and captured in full', async () => {
    const start = await call('POST', '/mobilepay/payments', { amount: 1250, currency: 'DKK', reference: 'S-42' });
    expect(start.statusCode).toBe(201);
    expect(start.json().qr).toBe('https://qr.vipps.no/pay/abc123');
    const create = sent.find((s) => s.url.endsWith('/epayment/v1/payments') && s.method === 'POST')!;
    expect(JSON.parse(create.body)).toMatchObject({ amount: { value: 1250, currency: 'DKK' }, userFlow: 'QR', qrFormat: { format: 'TEXT/TARGETURL' }, customerInteraction: 'CUSTOMER_PRESENT', paymentMethod: { type: 'WALLET' } });
    expect(create.headers['Merchant-Serial-Number']).toBe('123456');
    expect(create.headers['Idempotency-Key']).toBe(JSON.parse(create.body).reference);
    const ref = start.json().referenceId;
    expect((await call('GET', `/mobilepay/payments/${ref}`)).json().state).toBe('sent');

    payState = 'AUTHORIZED';
    await settle();
    expect((await call('GET', `/mobilepay/payments/${ref}`)).json()).toMatchObject({ state: 'approved', transactionId: 'psp-1' });
    const capture = sent.find((s) => s.url.endsWith(`/${ref}/capture`))!;
    expect(JSON.parse(capture.body)).toEqual({ modificationAmount: { currency: 'DKK', value: 1250 } });
    // Final: no more looks at MobilePay.
    const looks = sent.length;
    expect((await call('GET', `/mobilepay/payments/${ref}`)).json().state).toBe('approved');
    expect(sent.length).toBe(looks);
  });

  it('does not take a payment for a different amount as paid', async () => {
    payState = 'AUTHORIZED';
    paymentValue = 125;
    const ref = (await call('POST', '/mobilepay/payments', { amount: 1250, currency: 'DKK' })).json().referenceId;
    await settle();
    const o = (await call('GET', `/mobilepay/payments/${ref}`)).json();
    expect(o.state).toBe('declined');
    expect(o.message).toContain('different amount');
    expect(sent.some((s) => s.url.endsWith(`/${ref}/capture`))).toBe(false);
    paymentValue = 1250;
  });

  it('cancels a request the customer has not paid, and reports a request that ran out', async () => {
    payState = 'CREATED';
    const ref = (await call('POST', '/mobilepay/payments', { amount: 1250, currency: 'DKK' })).json().referenceId;
    expect((await call('POST', `/mobilepay/payments/${ref}/cancel`)).json().state).toBe('cancelled');
    expect(sent.some((s) => s.url.endsWith(`/${ref}/cancel`))).toBe(true);

    payState = 'EXPIRED';
    const ref2 = (await call('POST', '/mobilepay/payments', { amount: 1250, currency: 'DKK' })).json().referenceId;
    await settle();
    expect((await call('GET', `/mobilepay/payments/${ref2}`)).json().state).toBe('cancelled');
  });

  it('removes the keys on request', async () => {
    expect((await call('DELETE', '/mobilepay/keys')).json().connected).toBe(false);
    expect((await call('POST', '/mobilepay/payments', { amount: 1250, currency: 'DKK' })).statusCode).toBe(409);
  });
});
