import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../app';
import { assertion, createPush, parseServiceAccount, pushTargets } from '../push';

/**
 * Notes reach the Android app as Firebase pushes while Android keeps it frozen: to the devices
 * that would pop them up on screen, signed in and allowed to see them. Google is faked here.
 */

const PASSWORD = 'correct horse battery staple';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = JSON.stringify({ type: 'service_account', project_id: 'zollify-test', client_email: 'push@zollify-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
const TOKEN_A = `owner-phone-token-${'a'.repeat(40)}`;
const TOKEN_B = `helper-phone-token-${'b'.repeat(40)}`;

let app: FastifyInstance;
let dataDir: string;
let accountId: string;
let owner: string;
let helper: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const login = async (email: string, deviceId: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD, deviceId } })).json();

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-push-'));
  process.env.OWNER_EMAIL = 'push-owner@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({ dataDir, moduleStoreDir: join(dataDir, 'modules'), jwtSecret: 'test-secret-value-long-enough-for-signing', serverModules: [], defaultModules: [], allowedOrigins: [], requireHttps: false, trustProxy: false, logLevel: 'silent' });
  await app.ready();
  const o = await login('push-owner@example.test', 'owner-phone');
  owner = o.accessToken;
  accountId = o.user.accountId;
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'member' } });
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'push-helper@example.test', password: PASSWORD, inviteCode: invite.json().code } });
  helper = (await login('push-helper@example.test', 'helper-phone')).accessToken;
  expect((await app.inject({ method: 'PUT', url: '/api/devices/me/push', headers: auth(owner), payload: { token: TOKEN_A } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'PUT', url: '/api/devices/me/push', headers: auth(helper), payload: { token: TOKEN_B } })).statusCode).toBe(200);
  // Only the owner's phone asked for the printer.
  await app.inject({ method: 'PUT', url: '/api/devices/me/notifications', headers: auth(owner), payload: { kinds: ['print-desk'], timeZone: 'UTC' } });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('push targets', () => {
  const tokens = (n: Parameters<typeof pushTargets>[2]) => pushTargets(app.zollify.db, accountId, n).map((t) => t.token).sort();
  it('sends news to every signed-in phone, and admin news only to admins', () => {
    expect(tokens({ level: 'normal' })).toEqual([TOKEN_B, TOKEN_A].sort());
    expect(tokens({ level: 'normal', minRole: 'admin' })).toEqual([TOKEN_A]);
  });
  it('sends quiet kinds only to phones that asked for them', () => {
    expect(tokens({ level: 'low', kind: 'print-desk' })).toEqual([TOKEN_A]);
    expect(tokens({ level: 'low', kind: 'sale' })).toEqual([]);
  });
  it('turns away something that is not a push token', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/devices/me/push', headers: auth(owner), payload: { token: 'x y' } })).statusCode).toBe(400);
  });
});

describe('sending', () => {
  it('signs in to Google with the service account, sends, and forgets tokens Google no longer knows', async () => {
    const calls: { url: string; body: string }[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      if (String(url).startsWith('https://oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
      const to = JSON.parse(String(init?.body)).message.token;
      return to === TOKEN_B ? new Response(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'Requested entity was not found.' } }), { status: 404 }) : new Response('{}');
    }) as typeof fetch;
    const push = createPush(app.zollify.db, { config: () => SA, fetch: fake });
    await push.send(accountId, { title: 'Printer waiting: Kyoto A3, copy 2 of 5', body: 'Studio PC: Load a sheet.', link: '/m/print-desk', kind: 'print-desk', level: 'normal' });

    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    const sent = calls.slice(1).map((c) => JSON.parse(c.body).message);
    expect(sent.map((m) => m.token).sort()).toEqual([TOKEN_A, TOKEN_B].sort());
    expect(sent[0]).toMatchObject({ notification: { title: 'Printer waiting: Kyoto A3, copy 2 of 5', body: 'Studio PC: Load a sheet.' }, data: { link: '/m/print-desk', kind: 'print-desk' }, android: { priority: 'HIGH' } });
    expect(calls[1]!.url).toBe('https://fcm.googleapis.com/v1/projects/zollify-test/messages:send');
    // The helper's app is gone: its token is dropped, the owner's stays.
    expect(pushTargets(app.zollify.db, accountId, { level: 'normal' }).map((t) => t.token)).toEqual([TOKEN_A]);

    // The access token is kept for its hour.
    calls.length = 0;
    await push.send(accountId, { title: 'Again', level: 'normal' });
    expect(calls.map((c) => c.url)).toEqual(['https://fcm.googleapis.com/v1/projects/zollify-test/messages:send']);
  });
  it('sends nothing without a service account', async () => {
    let called = false;
    const push = createPush(app.zollify.db, { config: () => undefined, fetch: (async () => ((called = true), new Response('{}'))) as typeof fetch });
    await push.send(accountId, { title: 'Hi', level: 'normal' });
    expect(called).toBe(false);
  });
  it('signs an assertion Google can check with the service account key', () => {
    const sa = parseServiceAccount(SA)!;
    const [head, body, sig] = assertion(sa, 1_700_000_000_000).split('.');
    expect(createVerify('RSA-SHA256').update(`${head}.${body}`).verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString())).toEqual({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: 1_700_000_000, exp: 1_700_003_600 });
    expect(parseServiceAccount('{"project_id":"x"}')).toBeNull();
  });
});
