import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGateway } from '../app';
import { GOOGLE_PASSWORD, readIdToken } from '../google-auth';

/**
 * Sign in with Google: Google's answer lands on a waiting row that only the
 * app's poll secret can collect; an unknown person still needs an invite
 * code; a known one is signed in; a Google-only user has no password to
 * guess; and a cancelled sign-in says so.
 */

const OWNER_EMAIL = 'g-owner@example.test';
const PASSWORD = 'correct horse battery staple';
const CLIENT_ID = 'test-client.apps.googleusercontent.com';

let app: FastifyInstance;
let dataDir: string;
let owner: string;

const idToken = (claims: Record<string, unknown>): string =>
  ['e30', Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 3600, email_verified: true, ...claims })).toString('base64url'), 'sig'].join('.');
/** Google's token endpoint, as the callback sees it: the code names the person. */
const realFetch = globalThis.fetch;
const fakeGoogle = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url) !== 'https://oauth2.googleapis.com/token') return realFetch(url, init);
  const code = new URLSearchParams(String(init?.body)).get('code') ?? '';
  const [sub, email] = code.split('|');
  if (!email) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  return new Response(JSON.stringify({ id_token: idToken({ sub, email }) }), { status: 200 });
});

const begin = async (flavor = 'full') => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/google/begin', payload: { deviceId: `dev-${flavor}`, flavor } });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; pollSecret: string; url: string };
};
/** Walks the browser half: start → Google → callback, for the given Google identity. */
const comeBack = async (link: { url: string }, code: string) => {
  const start = await app.inject({ method: 'GET', url: new URL(link.url).pathname + new URL(link.url).search });
  expect(start.statusCode).toBe(302);
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  return app.inject({ method: 'GET', url: `/api/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` });
};
const poll = (link: { id: string; pollSecret: string }, extra: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/api/auth/google/poll', payload: { id: link.id, pollSecret: link.pollSecret, ...extra } });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-google-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  vi.stubGlobal('fetch', fakeGoogle);
  app = await buildGateway({ dataDir, moduleStoreDir: join(dataDir, 'modules'), jwtSecret: 'test-secret-value-long-enough-for-signing', serverModules: [], defaultModules: [], allowedOrigins: [], requireHttps: false, trustProxy: false, logLevel: 'silent' });
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER_EMAIL, password: PASSWORD } });
  owner = res.json().accessToken;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

describe('setup', () => {
  it('is off until both client id and secret are set', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/providers' })).json()).toEqual({ google: false });
    expect((await app.inject({ method: 'POST', url: '/api/auth/google/begin', payload: {} })).statusCode).toBe(404);
    process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = 'shh';
    expect((await app.inject({ method: 'GET', url: '/api/auth/providers' })).json()).toEqual({ google: true });
  });

  it('reads only an ID token that is Google\'s, for this app, current, with a verified email', () => {
    expect(readIdToken(idToken({ sub: '1', email: 'A@x.test' }), CLIENT_ID)).toEqual({ ok: true, sub: '1', email: 'a@x.test' });
    expect(readIdToken(idToken({ sub: '1', email: 'a@x.test', aud: 'other' }), CLIENT_ID)).toMatchObject({ ok: false, error: /different app/ });
    expect(readIdToken(idToken({ sub: '1', email: 'a@x.test', email_verified: false }), CLIENT_ID)).toMatchObject({ ok: false, error: /verified/ });
    expect(readIdToken(idToken({ sub: '1', email: 'a@x.test', exp: 1 }), CLIENT_ID)).toMatchObject({ ok: false, error: /expired/ });
    expect(readIdToken('nope', CLIENT_ID).ok).toBe(false);
  });
});

describe('a new person', () => {
  const link: { id: string; pollSecret: string; url: string } = { id: '', pollSecret: '', url: '' };

  it('is sent to Google from the start address and lands on a page for the app', async () => {
    Object.assign(link, await begin('full'));
    expect(link.url).toMatch(/\/api\/auth\/google\/start\?id=.+&s=.+/);
    expect((await poll(link)).json()).toMatchObject({ status: 'pending' });
    // A guessed start address, without the secret, goes nowhere.
    expect((await app.inject({ method: 'GET', url: `/api/auth/google/start?id=${link.id}&s=wrong` })).statusCode).toBe(410);
    const back = await comeBack(link, 'sub-new|New.Artist@example.test');
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain('Signed in with Google');
  });

  it('still needs an invite code, and a wrong one is refused', async () => {
    expect((await poll(link)).json()).toEqual({ status: 'needsInvite', email: 'new.artist@example.test' });
    const bad = await poll(link, { inviteCode: 'NOPE' });
    expect(bad.statusCode).toBe(403);
    expect(bad.json()).toMatchObject({ status: 'needsInvite', error: /invite/i });
  });

  it('joins with a valid invite, once, and has no password to guess', async () => {
    const invite = (await app.inject({ method: 'POST', url: '/api/invites', headers: { authorization: `Bearer ${owner}` }, payload: { newAccount: true } })).json().code;
    const ok = await poll(link, { inviteCode: invite, accountName: 'New Studio' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'approved', user: { email: 'new.artist@example.test', accountName: 'New Studio', role: 'admin' } });
    // The waiting row is spent.
    expect((await poll(link)).statusCode).toBe(410);
    const row = app.zollify.db.prepare('SELECT googleSub, passwordHash FROM users WHERE email = ?').get('new.artist@example.test') as { googleSub: string; passwordHash: string };
    expect(row).toEqual({ googleSub: 'sub-new', passwordHash: GOOGLE_PASSWORD });
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'new.artist@example.test', password: GOOGLE_PASSWORD } })).statusCode).toBe(401);
  });

  it('is signed straight in next time', async () => {
    const again = await begin('web');
    const back = await comeBack(again, 'sub-new|new.artist@example.test');
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toContain(`/#/login?google=${again.id}`);
    expect((await poll(again)).json()).toMatchObject({ status: 'approved', user: { email: 'new.artist@example.test' } });
  });
});

describe('a known person', () => {
  it('with a password is matched by email and gets the Google id attached', async () => {
    const link = await begin();
    await comeBack(link, 'sub-owner|G-Owner@example.test');
    expect((await poll(link)).json()).toMatchObject({ status: 'approved', user: { email: OWNER_EMAIL, role: 'owner' } });
    expect((app.zollify.db.prepare('SELECT googleSub FROM users WHERE email = ?').get(OWNER_EMAIL) as { googleSub: string }).googleSub).toBe('sub-owner');
  });

  it('is told when Google sign-in was cancelled', async () => {
    const link = await begin();
    const start = await app.inject({ method: 'GET', url: new URL(link.url).pathname + new URL(link.url).search });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    await app.inject({ method: 'GET', url: `/api/auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}` });
    const res = await poll(link);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ status: 'failed', error: /cancelled/ });
  });

  it('cannot be collected without the poll secret, and a replayed callback does nothing', async () => {
    const link = await begin();
    const back = await comeBack(link, 'sub-owner|g-owner@example.test');
    expect(back.statusCode).toBe(200);
    expect((await poll({ id: link.id, pollSecret: 'x'.repeat(40) })).statusCode).toBe(410);
    const state = new URL(link.url).searchParams.get('s')!;
    expect((await app.inject({ method: 'GET', url: `/api/auth/google/callback?code=sub-x|x@example.test&state=${link.id}.${state}` })).statusCode).toBe(410);
    expect((await poll(link)).json()).toMatchObject({ status: 'approved', user: { email: OWNER_EMAIL } });
  });
});
