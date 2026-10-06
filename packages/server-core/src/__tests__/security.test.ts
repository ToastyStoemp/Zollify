import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell } from '@zollify/shared';
import { buildGateway } from '../app';
import { issueChallenge, verifyChallenge } from '../captcha';
import { privateAddress } from '../webhooks';

/**
 * Regression tests for the security sweep: each one is an attack that used
 * to work, or nearly did.
 */

const PASSWORD = 'correct horse battery staple';
const TILL = 'till-security-1';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (t: string, url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers: auth(t), payload });

async function member(email: string, role: 'member' | 'admin' = 'member'): Promise<{ token: string; id: string }> {
  const invite = await post(owner, '/api/invites', { role });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: PASSWORD, inviteCode: invite.json().code } });
  return { token: reg.json().accessToken, id: reg.json().user.id };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-security-'));
  process.env.OWNER_EMAIL = 'owner@sec.test';
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
  owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@sec.test', password: PASSWORD, deviceId: TILL } })).json().accessToken;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('captcha', () => {
  const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  it('refuses a challenge signed with the old built-in key', () => {
    const payload = b64url(Buffer.from(JSON.stringify({ nonce: 'n1', difficulty: 0, exp: Date.now() + 60_000, purpose: 'register' })));
    const forged = `${payload}.${b64url(createHmac('sha256', 'zolltool-captcha-secret').update(payload).digest())}`;
    expect(verifyChallenge(forged, 0, 'register')).toMatchObject({ ok: false, error: 'Invalid CAPTCHA.' });
  });

  it('refuses a genuine challenge that asks for too little work', () => {
    const easy = issueChallenge('receipt', 0);
    expect(verifyChallenge(easy.token, 0, 'receipt').ok).toBe(false);
  });
});

describe('invite codes', () => {
  it('are long enough not to be guessed, and forgive how they are typed', async () => {
    const code = (await post(owner, '/api/invites', { role: 'member' })).json().code as string;
    expect(code).toMatch(/^[A-Z2-9]{16}$/);
    const typed = `${code.slice(0, 4)}-${code.slice(4, 8)} ${code.slice(8)}`.toLowerCase();
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'typed@sec.test', password: PASSWORD, inviteCode: typed } });
    expect(reg.statusCode).toBe(200);
  });
});

describe('tokens', () => {
  it('stop working as soon as the person is removed, and carry the current role', async () => {
    const kim = await member('kim@sec.test', 'admin');
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: auth(kim.token) })).statusCode).toBe(200);
    // Demoted: the old token no longer opens admin routes.
    app.zollify.db.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(kim.id);
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: auth(kim.token) })).statusCode).toBe(403);
    // Removed: nothing at all. A fresh token, so the old one is the only thing left.
    const fresh = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'kim@sec.test', password: PASSWORD } })).json().accessToken as string;
    expect((await post(fresh, '/api/users/me/delete', { password: PASSWORD })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(kim.token) })).statusCode).toBe(401);
  });
});

describe('a shared till', () => {
  let grant = '';
  let alex: { token: string; id: string };

  it('gives an unlocked admin a token that cannot make access last or lock them out', async () => {
    alex = await member('alex@sec.test', 'admin');
    grant = (await post(owner, '/api/device-users', { deviceId: TILL, email: 'alex@sec.test', password: PASSWORD, pin: '4711' })).json().grant;
    const till = (await post(owner, '/api/auth/unlock', { deviceId: TILL, userId: alex.id, pin: '4711', grant })).json().accessToken as string;
    // Everyday work is fine.
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: auth(till) })).statusCode).toBe(200);
    // Making it last, sending data out, or locking the person out is not.
    for (const url of ['/api/invites', '/api/tokens', '/api/webhooks', '/api/2fa/setup', '/api/sessions/revoke-others', '/api/account/delete', '/api/users/me/delete'])
      expect((await post(till, url)).statusCode, url).toBe(403);
    // Locked: after the short grace for syncing, the token is dead.
    await post(owner, '/api/auth/lock', { deviceId: TILL, userId: alex.id });
    app.zollify.db.prepare('UPDATE device_users SET unlockedUntil = 1 WHERE userId = ?').run(alex.id);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(till) })).statusCode).toBe(401);
  });

  it('counts PIN guesses sent in parallel before checking them', async () => {
    const guesses = await Promise.all(Array.from({ length: 12 }, (_, i) => post(owner, '/api/auth/unlock', { deviceId: TILL, userId: alex.id, pin: String(1000 + i), grant })));
    const codes = guesses.map((r) => r.statusCode);
    // At most five wrong answers are even checked; the rest are locked out.
    expect(codes.filter((c) => c === 403).length).toBeLessThanOrEqual(4);
    expect(codes.filter((c) => c === 423).length).toBeGreaterThanOrEqual(7);
    expect((await post(owner, '/api/auth/unlock', { deviceId: TILL, userId: alex.id, pin: '4711', grant })).statusCode).toBe(423);
  });
});

describe('first-run setup', () => {
  it('never reopens, even if every user is gone', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/setup' })).json().needsOwner).toBe(false);
    app.zollify.db.pragma('foreign_keys = OFF');
    app.zollify.db.prepare('DELETE FROM users').run();
    app.zollify.db.pragma('foreign_keys = ON');
    expect((await app.inject({ method: 'GET', url: '/api/setup' })).json().needsOwner).toBe(false);
    const grab = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'grab@sec.test', password: PASSWORD } });
    expect(grab.statusCode).not.toBe(200);
  });
});

describe('unauthenticated requests', () => {
  it('cannot make the server read a large body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'x'.repeat(400_000) }) });
    expect(res.statusCode).toBe(413);
  });
});

describe('helpers', () => {
  it('treat every private and wrapped address as private', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '198.18.0.1', '192.0.0.8', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', 'fec0::1', 'fd00::1', 'fe80::1'])
      expect(privateAddress(ip), ip).toBe(true);
    for (const ip of ['1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(privateAddress(ip), ip).toBe(false);
  });

  it('keep spreadsheet formulas out of CSV exports', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    expect(csvCell(-5)).toBe('-5');
  });
});
