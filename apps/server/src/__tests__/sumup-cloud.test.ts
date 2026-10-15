import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGateway } from '@zollify/server-core';

/**
 * SumUp Solo over the Cloud API, with SumUp mocked: a merchant connects once,
 * pairs a Solo by its code, and a payment is only paid when SumUp says so -
 * for exactly the amount asked. Tokens are refreshed when they run out.
 */

const PASSWORD = 'correct horse battery staple';
const MERCHANT = 'MK10CL2A';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let accessExpiresIn = 3600;
let checkoutStatus = 'pending';
let paidAmount = 1250;
let refuseRefresh = false;
const sent: { url: string; method: string; body: string; auth: string }[] = [];
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/pos${url}`, headers: auth(owner), ...(payload ? { payload } : {}) });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-sumup-'));
  Object.assign(process.env, {
    OWNER_EMAIL: 'owner@sumup.test',
    OWNER_PASSWORD: PASSWORD,
    REQUIRE_CAPTCHA: '0',
    SUMUP_CLIENT_ID: 'cc_client',
    SUMUP_CLIENT_SECRET: 'cc_secret',
    SUMUP_AFFILIATE_KEY: 'aff-key',
    PUBLIC_ORIGIN: 'https://pos.example.test',
  });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://api.sumup.com')) return real(input, init);
    const method = init?.method ?? 'GET';
    const body = String(init?.body ?? '');
    sent.push({ url, method, body, auth: String((init?.headers as Record<string, string>)?.authorization ?? '') });
    if (url.endsWith('/token')) {
      const p = new URLSearchParams(body);
      if (p.get('client_secret') !== 'cc_secret') return json(401, { error: 'invalid_client' });
      if (p.get('grant_type') === 'authorization_code') return p.get('code') === 'good' ? json(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: accessExpiresIn }) : json(400, { error: 'invalid_grant' });
      if (p.get('grant_type') === 'refresh_token') return !refuseRefresh && p.get('refresh_token') === 'refresh-1' ? json(200, { access_token: 'access-2', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
    }
    if (url.includes('/v0.1/memberships')) return json(200, { items: [{ resource_id: MERCHANT, resource: { id: MERCHANT, name: 'Loppehjørnet' } }] });
    const base = `https://api.sumup.com/v0.1/merchants/${MERCHANT}/readers`;
    if (url === base && method === 'GET') return json(200, { items: [{ id: 'rdr_ABC123', name: 'Counter', status: 'paired', device: { model: 'solo' } }] });
    if (url === base && method === 'POST') return JSON.parse(body).pairing_code === 'X7K2PQ' ? json(201, { id: 'rdr_NEW999', name: JSON.parse(body).name, status: 'processing', device: { model: 'solo' } }) : json(422, { detail: 'Invalid pairing code' });
    if (url === `${base}/rdr_ABC123/checkout` && method === 'POST') return json(201, { data: { checkout_id: 'chk-1', client_transaction_id: 'ctx-1' } });
    if (url === `${base}/rdr_ABC123/checkout/chk-1`) return json(200, { data: { status: checkoutStatus, total_amount: { value: paidAmount, currency: 'DKK', minor_unit: 2 } } });
    if (url === `${base}/rdr_ABC123/terminate`) return new Response(null, { status: 204 });
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
  owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@sumup.test', password: PASSWORD } })).json().accessToken;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  for (const k of ['SUMUP_CLIENT_ID', 'SUMUP_CLIENT_SECRET', 'SUMUP_AFFILIATE_KEY', 'PUBLIC_ORIGIN', 'REQUIRE_CAPTCHA']) delete process.env[k];
});

const connect = async (code = 'good') => {
  const { url } = (await call('POST', '/sumup/cloud/connect')).json();
  const state = new URL(url).searchParams.get('state');
  return app.inject({ method: 'GET', url: `/p/pos/sumup/authorized?code=${code}&state=${state}` });
};

describe('SumUp Solo over the cloud', () => {
  it('sends the owner to SumUp with the reader scopes and a one-time state', async () => {
    expect((await call('GET', '/sumup/cloud/status')).json()).toMatchObject({ configured: true, affiliate: true, connected: false, redirectUrl: 'https://pos.example.test/p/pos/sumup/authorized' });
    const url = new URL((await call('POST', '/sumup/cloud/connect')).json().url);
    expect(url.origin + url.pathname).toBe('https://api.sumup.com/authorize');
    expect(url.searchParams.get('scope')).toContain('readers.write');
    expect(url.searchParams.get('redirect_uri')).toBe('https://pos.example.test/p/pos/sumup/authorized');
    // A made-up state never connects anything.
    expect((await app.inject({ method: 'GET', url: '/p/pos/sumup/authorized?code=good&state=forged' })).body).toContain('expired');
  });

  it('refuses a bad code, then connects with a good one, once', async () => {
    expect((await connect('bad')).body).toContain('was not connected');
    expect((await connect()).body).toContain('SumUp is connected');
    expect((await call('GET', '/sumup/cloud/status')).json()).toMatchObject({ connected: true, merchant: { code: MERCHANT, name: 'Loppehjørnet' } });
    // The token never reaches a browser.
    expect((await call('GET', '/sumup/cloud/status')).body).not.toContain('access-1');
  });

  it('pairs a Solo from its code and says when the code is wrong', async () => {
    const bad = await call('POST', '/sumup/cloud/readers', { pairingCode: 'WRONG1' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('Invalid pairing code');
    const res = await call('POST', '/sumup/cloud/readers', { pairingCode: 'x7k2pq', name: 'Counter 2' });
    expect(res.statusCode).toBe(201);
    expect(res.json().reader).toMatchObject({ id: 'rdr_NEW999', name: 'Counter 2' });
    expect(JSON.parse(sent.at(-1)!.body)).toEqual({ pairing_code: 'X7K2PQ', name: 'Counter 2' });
    expect((await call('GET', '/sumup/cloud/readers')).json().readers).toEqual([{ id: 'rdr_ABC123', name: 'Counter', status: 'paired', model: 'solo' }]);
  });

  it('charges the Solo with the affiliate key, and is paid only when SumUp says so', async () => {
    const start = await call('POST', '/sumup/cloud/payments', { amount: 1250, currency: 'DKK', reference: 'S-42', readerId: 'rdr_ABC123' });
    expect(start.statusCode).toBe(201);
    const checkout = JSON.parse(sent.find((s) => s.url.endsWith('/rdr_ABC123/checkout'))!.body);
    expect(checkout).toMatchObject({ total_amount: { value: 1250, currency: 'DKK', minor_unit: 2 }, affiliate: { app_id: 'com.phuongninjin.zollify', key: 'aff-key' } });
    const ref = start.json().referenceId;
    expect((await call('GET', `/sumup/cloud/payments/${ref}`)).json().state).toBe('sent');
    checkoutStatus = 'successful';
    // SumUp is asked at most every two seconds, however often the till polls.
    await new Promise((r) => setTimeout(r, 2100));
    expect((await call('GET', `/sumup/cloud/payments/${ref}`)).json()).toMatchObject({ state: 'approved', transactionId: 'ctx-1' });
  });

  it('does not take a payment for a different amount as paid', async () => {
    checkoutStatus = 'successful';
    paidAmount = 125;
    const ref = (await call('POST', '/sumup/cloud/payments', { amount: 1250, currency: 'DKK', readerId: 'rdr_ABC123' })).json().referenceId;
    await new Promise((r) => setTimeout(r, 2100));
    const o = (await call('GET', `/sumup/cloud/payments/${ref}`)).json();
    expect(o.state).toBe('declined');
    expect(o.message).toMatch(/different amount/);
    paidAmount = 1250;
  });

  it('refreshes an expired token, and asks for a new sign-in when the refresh is refused', async () => {
    accessExpiresIn = 0;
    await connect();
    await call('GET', '/sumup/cloud/readers');
    expect(sent.some((s) => s.url.endsWith('/token') && s.body.includes('grant_type=refresh_token'))).toBe(true);
    expect(sent.at(-1)!.auth).toBe('Bearer access-2');
    // Revoked on SumUp's side: the link goes, and the till is told to connect again.
    refuseRefresh = true;
    await connect();
    const res = await call('GET', '/sumup/cloud/readers');
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/connect it again/);
    expect((await call('GET', '/sumup/cloud/status')).json().connected).toBe(false);
  });
});
