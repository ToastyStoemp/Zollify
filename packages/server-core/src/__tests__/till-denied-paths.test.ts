import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../app';

/**
 * What a person unlocked at a shared till may not do must hold however the
 * path is spelled. The router decodes percent-encoding before it matches, so
 * a deny-list that judged the path as sent let `/api/%69nvites` through to
 * the invites route: an admin invite, an API token or an account wipe from
 * a till anyone can walk up to.
 */

const PASSWORD = 'correct horse battery staple';
const TILL = 'till-device-1';
let app: FastifyInstance;
let dataDir: string;
let till: string;
let own: string;

const call = (token: string, method: 'GET' | 'POST', url: string) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(method === 'POST' ? { payload: {} } : {}) });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-tillpaths-'));
  process.env.OWNER_EMAIL = 'owner@tillpaths.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [],
    defaultModules: [],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  const login = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@tillpaths.test', password: PASSWORD, deviceId: TILL } })).json();
  own = login.accessToken;
  // The owner, unlocked at the till: the same person and role, but through the till's token.
  app.zollify.db
    .prepare('INSERT INTO device_users (accountId, deviceId, userId, grantHash, unlockedUntil, createdAt) VALUES (?,?,?,?,?,?)')
    .run(login.user.accountId, TILL, login.user.id, 'grant', Date.now() + 3_600_000, Date.now());
  till = app.jwt.sign({ sub: login.user.id, accountId: login.user.accountId, role: login.user.role, till: TILL }, { expiresIn: '15m' });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('what a shared till may not do', () => {
  const denied: ['GET' | 'POST', string][] = [
    ['POST', '/api/invites'],
    ['POST', '/api/%69nvites'],
    ['POST', '/api/in%76ites'],
    ['POST', '/api/tokens'],
    ['POST', '/api/%74okens'],
    ['GET', '/api/webhooks'],
    ['GET', '/api/%77ebhooks'],
    ['POST', '/api/account/wipe'],
    ['POST', '/api/account/%77ipe'],
    ['POST', '/api/%61ccount/wipe'],
    ['POST', '/api/sessions/revoke-others'],
    ['POST', '/api/session%73/revoke-others'],
  ];

  it.each(denied)('refuses %s %s', async (method, url) => {
    const res = await call(till, method, url);
    // Refused as a till, or no such route at all - never carried out.
    expect([403, 404]).toContain(res.statusCode);
    if (res.statusCode === 403) expect(res.json().error).toMatch(/shared till/);
  });

  it('an encoded spelling reaches the same route as the plain one, so it must get the same answer', async () => {
    const plain = await call(till, 'POST', '/api/invites');
    const encoded = await call(till, 'POST', '/api/%69nvites');
    expect(plain.statusCode).toBe(403);
    expect(encoded.statusCode).toBe(403);
  });

  it('nothing was created or wiped by the attempts above', async () => {
    const invites = (await call(own, 'GET', '/api/invites')).json();
    expect(JSON.stringify(invites)).not.toMatch(/"role":"admin"/);
  });

  it('still lets the till do its job', async () => {
    expect((await call(till, 'GET', '/api/sync/pull?since=0')).statusCode).toBe(200);
  });

  it("leaves the person's own sign-in alone", async () => {
    expect((await call(own, 'POST', '/api/%69nvites')).statusCode).not.toBe(403);
  });
});
