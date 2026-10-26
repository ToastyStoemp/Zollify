import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, isSandbox, setEnabled, type MailMessage } from '@zollify/server-core';
import { consignmentArtistServerModule, consignmentServerModule } from '../modules/consignment';
import { commissionsServerModule } from '../modules/commissions';

/**
 * Test accounts (sandboxes): a throwaway store and a throwaway artist that
 * work with each other for real - and never with a real account, never on a
 * real card, and never in an unmarked email.
 */

const PASSWORD = 'correct horse battery staple';
const sent: MailMessage[] = [];
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let realArtist: string;
let testStore: string;
let testArtist: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const me = async (t: string) => (await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(t) })).json().user;
const sandbox = (t: string, on: boolean) => app.inject({ method: 'POST', url: '/api/account/sandbox', headers: auth(t), payload: { on } });
const consign = (t: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/${url.startsWith('/links') ? 'consignment-artist' : 'consignment'}${url}`, headers: auth(t), ...(payload ? { payload } : {}) });

async function newAccount(email: string, accountName: string): Promise<string> {
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { newAccount: true } });
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: PASSWORD, inviteCode: invite.json().code, accountName } });
  expect(res.statusCode).toBe(200);
  for (const m of ['consignment', 'consignment-artist', 'commissions']) setEnabled(app.zollify.db, res.json().user.accountId, m, true);
  return res.json().accessToken;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-sandbox-'));
  process.env.OWNER_EMAIL = 'owner@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [consignmentServerModule, consignmentArtistServerModule, commissionsServerModule],
    defaultModules: ['consignment', 'consignment-artist', 'commissions'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
    mailer: { enabled: true, send: async (m) => (sent.push(m), true) },
  });
  await app.ready();
  owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.test', password: PASSWORD } })).json().accessToken;
  realArtist = await newAccount('real@example.test', 'Real Artist');
  testStore = await newAccount('store@example.test', 'Test Store');
  testArtist = await newAccount('artist@example.test', 'Test Artist');
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('making a test account', () => {
  it('is switched by an admin, through its own call only', async () => {
    const res = await sandbox(testStore, true);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.profile.sandbox).toBe(true);
    expect(isSandbox(app.zollify.db, (await me(testStore)).accountId)).toBe(true);
    // A profile update neither sets nor clears it.
    await app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(testStore), payload: { defaultCurrency: 'EUR', sandbox: false } });
    expect((await me(testStore)).profile.sandbox).toBe(true);
    await app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(realArtist), payload: { sandbox: true } });
    expect((await me(realArtist)).profile.sandbox).toBeUndefined();
  });

  it('marks every email of the account TEST', async () => {
    const made = (await app.inject({
      method: 'POST',
      url: '/api/m/commissions/commissions',
      headers: auth(testStore),
      payload: { title: 'Dragon', price: 50, customer: { name: 'Sam', email: 'sam@example.test', phone: '' }, forceNewCustomer: true },
    })).json();
    sent.length = 0;
    await app.inject({ method: 'POST', url: `/api/m/commissions/commissions/${made.id}/email-link`, headers: auth(testStore) });
    expect(sent[0]?.subject).toBe('[TEST] Follow your commission: Dragon');
    expect(sent[0]?.text).toMatch(/^This comes from a Zollify test account/);
  });
});

describe('linking a test store and artists', () => {
  it('never links a test store with a real artist', async () => {
    expect((await consign(testStore, 'PUT', '/consignors/real', { name: 'Real', commissionPct: 30, storeIds: [] })).statusCode).toBe(200);
    const { code } = (await consign(testStore, 'POST', '/consignors/real/link-code')).json();
    const res = await consign(realArtist, 'POST', '/links', { code });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/test account/);
  });

  it('links two test accounts, and then neither can turn real alone', async () => {
    expect((await sandbox(testArtist, true)).statusCode).toBe(200);
    expect((await consign(testStore, 'PUT', '/consignors/tara', { name: 'Tara', commissionPct: 30, storeIds: [] })).statusCode).toBe(200);
    const { code } = (await consign(testStore, 'POST', '/consignors/tara/link-code')).json();
    expect((await consign(testArtist, 'POST', '/links', { code })).statusCode).toBe(200);
    const off = await sandbox(testArtist, false);
    expect(off.statusCode).toBe(409);
    expect(off.json().message).toMatch(/Unlink/);
  });

  it('makes an artist who signs up from a test store\'s invite a test account too', async () => {
    expect((await consign(testStore, 'PUT', '/consignors/nina', { name: 'Nina', commissionPct: 30, storeIds: [] })).statusCode).toBe(200);
    const { code } = (await consign(testStore, 'POST', '/consignors/nina/link-code')).json();
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'nina@example.test', password: PASSWORD, inviteCode: code, accountName: 'Nina' } });
    expect(reg.statusCode).toBe(200);
    expect(isSandbox(app.zollify.db, reg.json().user.accountId)).toBe(true);
    const storeId = (await me(testStore)).accountId;
    expect((await consign(reg.json().accessToken, 'POST', `/links/offers/${storeId}/nina`, { accept: true })).statusCode).toBe(200);
  });

  it('is not for staff to switch', async () => {
    const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(testStore), payload: { role: 'member' } });
    const staff = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'staff@example.test', password: PASSWORD, inviteCode: invite.json().code } })).json().accessToken;
    expect((await sandbox(staff, false)).statusCode).toBe(403);
  });
});
