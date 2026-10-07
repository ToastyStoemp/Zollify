import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGateway, setEnabled } from '@zollify/server-core';
import { businessFromCode, readCallback } from '../modules/smartpos';

/**
 * Nexi SmartPOS over Poynt's Payment Bridge, with Poynt's cloud mocked: a
 * merchant connects once, picks a terminal, and a payment is only paid when
 * the terminal says so - for exactly the amount asked, through the one
 * callback URL Poynt was given.
 */

const PASSWORD = 'correct horse battery staple';
const APP = 'urn:aid:00000000-0000-0000-0000-000000000001';
const BIZ = '11111111-2222-3333-4444-555555555555';
const APP2 = 'urn:aid:00000000-0000-0000-0000-000000000002';
const BIZ2 = '66666666-7777-8888-9999-000000000000';
const app2 = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const app_ = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const poynt = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const jwt = (claims: Record<string, unknown>, key = poynt.privateKey): string => {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${h}.${b}.${createSign('RSA-SHA256').update(`${h}.${b}`).sign(key).toString('base64url')}`;
};
const now = () => Math.floor(Date.now() / 1000);
const code = (biz = BIZ, extra: Record<string, unknown> = {}) => jwt({ iss: 'https://poynt.net', sub: APP, iat: now(), exp: now() + 300, 'poynt.biz': biz, ...extra });

let app: FastifyInstance;
let dataDir: string;
let owner: string;
const sent: { url: string; body: string }[] = [];
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (t: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/pos${url}`, headers: auth(t), ...(payload ? { payload } : {}) });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-smartpos-'));
  Object.assign(process.env, {
    OWNER_EMAIL: 'owner@smartpos.test',
    OWNER_PASSWORD: PASSWORD,
    REQUIRE_CAPTCHA: '0',
    POYNT_APPLICATION_ID: APP,
    POYNT_PRIVATE_KEY: app_.privateKey,
    POYNT_AUTH_PUBLIC_KEY: poynt.publicKey,
    PUBLIC_ORIGIN: 'https://pos.example.test',
  });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://services-eu.poynt.net')) return real(input, init);
    sent.push({ url, body: String(init?.body ?? '') });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/token')) return json(200, { accessToken: 'app-token', expiresIn: 86400, tokenType: 'BEARER' });
    if (url.endsWith(`/businesses/${BIZ}`) || url.endsWith(`/businesses/${BIZ2}`)) return json(200, { id: url.split('/').pop() });
    if (url.endsWith(`/businesses/${BIZ2}/stores`)) return json(200, [{ id: 'store-2', displayName: 'Shop two', storeDevices: [{ deviceId: 'urn:tid:shop2', name: 'Till 2', status: 'ACTIVATED', type: 'TERMINAL' }] }]);
    if (url.includes('/businesses/') && url.endsWith('/stores')) {
      return url.includes(BIZ)
        ? json(200, [{ id: 'store-1', displayName: 'Atelier', storeDevices: [{ deviceId: 'urn:tid:n950', serialNumber: 'N950-1', name: 'Counter', status: 'ACTIVATED', type: 'TERMINAL' }, { deviceId: 'urn:tid:old', status: 'DEACTIVATED', type: 'TERMINAL' }] }])
        : json(403, { message: 'no access' });
    }
    if (url.includes('/businesses/')) return json(403, { message: 'no access' });
    if (url.endsWith('/cloudMessages')) return new Response(null, { status: 202 });
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
  owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@smartpos.test', password: PASSWORD } })).json().accessToken;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  for (const k of ['POYNT_APPLICATION_ID', 'POYNT_PRIVATE_KEY', 'POYNT_AUTH_PUBLIC_KEY', 'PUBLIC_ORIGIN', 'REQUIRE_CAPTCHA']) delete process.env[k];
});

async function connect(c = code()): Promise<string> {
  const { url } = (await call(owner, 'POST', '/smartpos/connect')).json();
  const context = new URL(url).searchParams.get('context')!;
  const res = await app.inject({ method: 'GET', url: `/p/pos/smartpos/authorized?code=${encodeURIComponent(c)}&status=allow&context=${encodeURIComponent(context)}` });
  return String(res.headers.location);
}

describe('connecting a Nexi account', () => {
  it('sends the owner to Poynt with this app and a one-time context', async () => {
    expect((await call(owner, 'GET', '/smartpos/status')).json()).toMatchObject({ configured: true, connected: false, canManage: true, app: null, serverApp: true, redirectUrl: 'https://pos.example.test/p/pos/smartpos/authorized' });
    const { url } = (await call(owner, 'POST', '/smartpos/connect')).json();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://poynt-eu.secureserver.net/applications/authorize');
    expect(u.searchParams.get('client_id')).toBe(APP);
    expect(u.searchParams.get('redirect_uri')).toBe('https://pos.example.test/p/pos/smartpos/authorized');
  });

  it('refuses a code not signed by Poynt, made out to another app, or stale', async () => {
    expect(await connect(code(BIZ, {}).replace(/\.[^.]+$/, '.' + Buffer.from('forged').toString('base64url')))).toMatch(/smartpos=failed/);
    expect(await connect(jwt({ iss: 'https://poynt.net', sub: APP, iat: now(), exp: now() + 300, 'poynt.biz': BIZ }, app_.privateKey))).toMatch(/smartpos=failed/);
    expect(await connect(code(BIZ, { sub: 'urn:aid:someone-else' }))).toMatch(/smartpos=failed/);
    expect(await connect(code(BIZ, { exp: now() - 10 }))).toMatch(/smartpos=failed/);
    expect((await call(owner, 'GET', '/smartpos/status')).json().connected).toBe(false);
  });

  it('links the business once the code checks out, and a context only works once', async () => {
    const { url } = (await call(owner, 'POST', '/smartpos/connect')).json();
    const context = new URL(url).searchParams.get('context')!;
    const go = () => app.inject({ method: 'GET', url: `/p/pos/smartpos/authorized?code=${encodeURIComponent(code())}&status=allow&context=${context}` });
    expect(String((await go()).headers.location)).toBe('https://pos.example.test/#/settings?panel=pos.payments&smartpos=connected');
    expect(String((await go()).headers.location)).toMatch(/smartpos=expired/);
    expect((await call(owner, 'GET', '/smartpos/status')).json().connected).toBe(true);
  });

  it('lists only active terminals', async () => {
    expect((await call(owner, 'GET', '/smartpos/terminals')).json().terminals).toEqual([{ storeId: 'store-1', storeName: 'Atelier', deviceId: 'urn:tid:n950', name: 'Counter', serial: 'N950-1' }]);
  });
});

describe('taking a payment', () => {
  const pay = (extra: Record<string, unknown> = {}) => call(owner, 'POST', '/smartpos/payments', { amount: 12500, currency: 'DKK', reference: 'T-1', storeId: 'store-1', deviceId: 'urn:tid:n950', ...extra });
  const lastMessage = () => {
    const m = [...sent].reverse().find((s) => s.url.endsWith('/cloudMessages'))!;
    const body = JSON.parse(m.body);
    return { body, data: JSON.parse(body.data) };
  };

  it('sends the amount in minor units to the chosen terminal, with a secret callback', async () => {
    const res = await pay();
    expect(res.statusCode).toBe(201);
    const { body, data } = lastMessage();
    expect(body).toMatchObject({ businessId: BIZ, storeId: 'store-1', deviceId: 'urn:tid:n950', ttl: 120 });
    expect(JSON.parse(data.payment)).toMatchObject({ amount: 12500, currency: 'DKK', referenceId: res.json().referenceId });
    expect(data.callbackUrl).toMatch(new RegExp(`^https://pos\\.example\\.test/p/pos/smartpos/callback/${res.json().referenceId}/[\\w-]{20,}$`));
  });

  it('only believes the callback URL it gave out, and only for the full amount', async () => {
    const { referenceId } = (await pay()).json();
    const cb = lastMessage().data.callbackUrl.replace('https://pos.example.test', '');
    const tx = (amount: number) => ({ status: 'PROCESSED', referenceId, transactions: [{ id: 'tx-1', status: 'CAPTURED', amounts: { transactionAmount: amount, currency: 'DKK' }, fundingSource: { card: { type: 'DANKORT', numberLast4: '4242' } }, processorResponse: { approvalCode: 'A1B2', status: 'Successful' } }] });
    expect((await app.inject({ method: 'POST', url: `/p/pos/smartpos/callback/${referenceId}/not-the-secret`, payload: tx(12500) })).statusCode).toBe(404);
    expect((await call(owner, 'GET', `/smartpos/payments/${referenceId}`)).json().state).toBe('sent');
    await app.inject({ method: 'POST', url: cb, payload: { status: 'STARTED', referenceId } });
    expect((await call(owner, 'GET', `/smartpos/payments/${referenceId}`)).json().state).toBe('started');
    await app.inject({ method: 'POST', url: cb, payload: tx(12500) });
    expect((await call(owner, 'GET', `/smartpos/payments/${referenceId}`)).json()).toMatchObject({ state: 'approved', cardBrand: 'DANKORT', last4: '4242', authCode: 'A1B2', transactionId: 'tx-1' });
    // A late retry does not undo the outcome.
    await app.inject({ method: 'POST', url: cb, payload: { status: 'CANCELED', referenceId } });
    expect((await call(owner, 'GET', `/smartpos/payments/${referenceId}`)).json().state).toBe('approved');

    const second = (await pay()).json().referenceId;
    await app.inject({ method: 'POST', url: lastMessage().data.callbackUrl.replace('https://pos.example.test', ''), payload: tx(100) });
    expect((await call(owner, 'GET', `/smartpos/payments/${second}`)).json()).toMatchObject({ state: 'declined', message: 'The terminal reported a different amount.' });
  });

  it('cancels on the terminal', async () => {
    const { referenceId } = (await pay()).json();
    expect((await call(owner, 'POST', `/smartpos/payments/${referenceId}/cancel`)).statusCode).toBe(200);
    expect(JSON.parse(lastMessage().body.data)).toEqual({ action: 'cancelPayment' });
  });

  it('refuses terminals that are not the merchant’s, and keeps payments to their account', async () => {
    expect((await pay({ deviceId: 'urn:tid:old' })).statusCode).toBe(404);
    const { referenceId } = (await pay()).json();
    const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { newAccount: true } });
    const reg = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'x@smartpos.test', password: PASSWORD, inviteCode: invite.json().code } })).json();
    setEnabled(app.zollify.db, reg.user.accountId, 'pos', true);
    const other = reg.accessToken as string;
    expect((await call(other, 'GET', `/smartpos/payments/${referenceId}`)).statusCode).toBe(404);
    expect((await call(other, 'POST', '/smartpos/payments', { amount: 1, currency: 'DKK', storeId: 'store-1', deviceId: 'urn:tid:n950' })).statusCode).toBe(409);
    // The same Nexi business cannot be claimed by a second account.
    const { url } = (await call(other, 'POST', '/smartpos/connect')).json();
    const res = await app.inject({ method: 'GET', url: `/p/pos/smartpos/authorized?code=${encodeURIComponent(code())}&status=allow&context=${new URL(url).searchParams.get('context')}` });
    expect(String(res.headers.location)).toMatch(/smartpos=in_use/);
  });

  it('lets only owners and admins connect', async () => {
    const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'member' } });
    const staff = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'staff@smartpos.test', password: PASSWORD, inviteCode: invite.json().code } })).json().accessToken;
    expect((await call(staff, 'POST', '/smartpos/connect')).statusCode).toBe(403);
    expect((await call(staff, 'DELETE', '/smartpos/connection')).statusCode).toBe(403);
  });
});

describe('each account with its own Poynt app', () => {
  let shop: string;
  const save = (t: string, body: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/m/pos/smartpos/app', headers: auth(t), payload: body });
  const lastAssertion = () => {
    const m = [...sent].reverse().find((x) => x.url.endsWith('/token'))!;
    return JSON.parse(Buffer.from(new URLSearchParams(m.body).get('assertion')!.split('.')[1]!, 'base64url').toString());
  };

  beforeAll(async () => {
    const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { newAccount: true } });
    const reg = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'shop2@smartpos.test', password: PASSWORD, inviteCode: invite.json().code } })).json();
    setEnabled(app.zollify.db, reg.user.accountId, 'pos', true);
    shop = reg.accessToken;
  });

  it('checks the app before saving it, and never hands the key back', async () => {
    expect((await save(shop, { applicationId: 'not-an-app', privateKey: app2.privateKey })).statusCode).toBe(400);
    expect((await save(shop, { applicationId: APP2, privateKey: 'garbage' })).json().message).toMatch(/RSA private key/);
    expect((await save(shop, { applicationId: APP2 })).json().message).toMatch(/private key/);
    const res = await save(shop, { applicationId: APP2, privateKey: app2.privateKey, region: 'eu', authPublicKey: poynt.publicKey });
    expect(res.statusCode).toBe(200);
    expect(lastAssertion()).toMatchObject({ iss: APP2, sub: APP2, aud: 'https://services-eu.poynt.net' });
    expect(JSON.stringify(res.json())).not.toContain('PRIVATE KEY');
    expect((await call(shop, 'GET', '/smartpos/status')).json()).toMatchObject({ configured: true, app: { applicationId: APP2, region: 'eu', hasAuthKey: true } });
    // Stored encrypted.
    const row = app.zollify.db.prepare('SELECT app FROM smartpos_apps').get() as { app: string };
    expect(row.app).not.toContain('PRIVATE KEY');
    // Saving again without the key keeps it.
    expect((await save(shop, { applicationId: APP2, region: 'eu', authPublicKey: poynt.publicKey })).statusCode).toBe(200);
  });

  it('connects and pays through that account’s own app', async () => {
    const { url } = (await call(shop, 'POST', '/smartpos/connect')).json();
    expect(new URL(url).searchParams.get('client_id')).toBe(APP2);
    const context = new URL(url).searchParams.get('context')!;
    // A code made out to the server's app is not good for this account's.
    const wrong = jwt({ iss: 'https://poynt.net', sub: APP, iat: now(), exp: now() + 300, 'poynt.biz': BIZ2 });
    expect(String((await app.inject({ method: 'GET', url: `/p/pos/smartpos/authorized?code=${encodeURIComponent(wrong)}&context=${context}` })).headers.location)).toMatch(/smartpos=failed/);
    const again = new URL((await call(shop, 'POST', '/smartpos/connect')).json().url).searchParams.get('context')!;
    const right = jwt({ iss: 'https://poynt.net', sub: APP2, iat: now(), exp: now() + 300, 'poynt.biz': BIZ2 });
    expect(String((await app.inject({ method: 'GET', url: `/p/pos/smartpos/authorized?code=${encodeURIComponent(right)}&context=${again}` })).headers.location)).toMatch(/smartpos=connected/);
    expect((await call(shop, 'GET', '/smartpos/terminals')).json().terminals.map((t: { deviceId: string }) => t.deviceId)).toEqual(['urn:tid:shop2']);
    expect((await call(shop, 'POST', '/smartpos/payments', { amount: 500, currency: 'DKK', storeId: 'store-2', deviceId: 'urn:tid:shop2' })).statusCode).toBe(201);
    expect(lastAssertion().iss).toBe(APP2);
    // The first account still uses the server's app.
    expect((await call(owner, 'POST', '/smartpos/payments', { amount: 500, currency: 'DKK', storeId: 'store-1', deviceId: 'urn:tid:n950' })).statusCode).toBe(201);
  });

  it('works without any app in the server’s environment', async () => {
    const saved = process.env.POYNT_APPLICATION_ID;
    delete process.env.POYNT_APPLICATION_ID;
    try {
      expect((await call(owner, 'GET', '/smartpos/status')).json()).toMatchObject({ configured: false, serverApp: false });
      expect((await call(owner, 'POST', '/smartpos/connect')).statusCode).toBe(409);
      expect((await call(shop, 'GET', '/smartpos/status')).json()).toMatchObject({ configured: true, connected: true });
      expect((await call(shop, 'GET', '/smartpos/terminals')).statusCode).toBe(200);
    } finally {
      process.env.POYNT_APPLICATION_ID = saved;
    }
  });

  it('only lets owners and admins change the app, and removing it drops the link', async () => {
    const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(shop), payload: { role: 'member' } });
    const staff = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'staff2@smartpos.test', password: PASSWORD, inviteCode: invite.json().code } })).json().accessToken;
    expect((await save(staff, { applicationId: APP2, privateKey: app2.privateKey })).statusCode).toBe(403);
    expect((await call(staff, 'DELETE', '/smartpos/app')).statusCode).toBe(403);
    expect((await call(staff, 'GET', '/smartpos/status')).json().canManage).toBe(false);
    expect((await call(shop, 'DELETE', '/smartpos/app')).statusCode).toBe(200);
    expect((await call(shop, 'GET', '/smartpos/status')).json()).toMatchObject({ app: null, connected: false });
  });
});

describe('helpers', () => {
  it('reads a decline and a cancel', () => {
    expect(readCallback({ status: 'CANCELED' }, { amount: 1, currency: 'DKK' }).state).toBe('cancelled');
    const declined = readCallback({ status: 'PROCESSED', transactions: [{ status: 'DECLINED', amounts: { transactionAmount: 1, currency: 'DKK' }, processorResponse: { status: 'Failure', statusMessage: 'Insufficient funds' } }] }, { amount: 1, currency: 'DKK' });
    expect(declined).toMatchObject({ state: 'declined', detail: { message: 'Insufficient funds' } });
  });

  it('checks the code claims even without a public key', () => {
    const cfg = { applicationId: APP, authPublicKey: null };
    expect(businessFromCode(code(), cfg)).toBe(BIZ);
    expect(businessFromCode(code(BIZ, { iss: 'https://evil.example' }), cfg)).toBeNull();
    expect(businessFromCode(code(BIZ, { iss: 'https://poynt-eu.secureserver.net' }), cfg)).toBe(BIZ);
    expect(businessFromCode(code(BIZ, { iss: 'https://poynt-eu.secureserver.net.evil.example' }), cfg)).toBeNull();
    expect(businessFromCode(code('not-a-uuid'), cfg)).toBeNull();
  });
});
