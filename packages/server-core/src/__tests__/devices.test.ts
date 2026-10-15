import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceSummary } from '@zollify/shared';
import { buildGateway } from '../app';
import { REFRESH_COOKIE } from '../refresh-cookie';
import { deviceModel, parseDevice } from '../session-info';

/**
 * Devices on an account can be told apart by what they are, and one that is
 * gone (reinstalled, lost, lent out) can be removed - which signs it out at
 * once, in-flight access token included, while a later sign-in from the same
 * device simply works again.
 */

const OWNER_EMAIL = 'dev-owner@example.test';
const PASSWORD = 'correct horse battery staple';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; SM-A536B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';

let app: FastifyInstance;
let dataDir: string;
let owner: string;
let member: string;
let memberId: string;

const login = async (email: string, deviceId: string, ua = ANDROID_UA, extra: Record<string, unknown> = {}) => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'user-agent': ua }, payload: { email, password: PASSWORD, deviceId, ...extra } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE)?.value ?? '';
  return { ...(res.json() as { accessToken: string; user: { id: string } }), cookie };
};
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const devices = async (t: string) => (await app.inject({ method: 'GET', url: '/api/devices', headers: auth(t) })).json() as DeviceSummary[];

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-devices-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({ dataDir, moduleStoreDir: join(dataDir, 'modules'), jwtSecret: 'test-secret-value-long-enough-for-signing', serverModules: [], defaultModules: [], allowedOrigins: [], requireHttps: false, trustProxy: false, logLevel: 'silent' });
  await app.ready();
  owner = (await login(OWNER_EMAIL, 'owner-phone')).accessToken;
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: {} });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'helper@example.test', password: PASSWORD, inviteCode: invite.json().code } });
  expect(reg.statusCode).toBe(200);
  memberId = reg.json().user.id;
  member = (await login('helper@example.test', 'helper-tablet', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', { flavor: 'web' })).accessToken;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('describing a device', () => {
  it('names the model when the user agent carries one', () => {
    expect(parseDevice(ANDROID_UA)).toBe('Zollify app on Android (SM-A536B)');
    expect(deviceModel('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36')).toBeNull();
    expect(deviceModel('Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UP1A.231005.007; wv) AppleWebKit/537.36')).toBe('Pixel 7');
    expect(parseDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')).toBe('Chrome on Windows');
  });

  it('lists each device with what it is, who signed in and how many sessions it holds', async () => {
    const list = await devices(owner);
    const phone = list.find((d) => d.id === 'owner-phone')!;
    expect(phone).toMatchObject({ device: 'Zollify app on Android (SM-A536B)', userEmail: OWNER_EMAIL, sessions: 1 });
    const tablet = list.find((d) => d.id === 'helper-tablet')!;
    expect(tablet).toMatchObject({ device: 'Safari on iOS (iPad)', userEmail: 'helper@example.test', userId: memberId, flavor: 'web' });
  });
});

describe('removing a device', () => {
  it('lets a member remove only a device they signed in', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/devices/owner-phone', headers: auth(member) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/devices/nope', headers: auth(owner) })).statusCode).toBe(404);
  });

  it('refuses the device you are on', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/devices/owner-phone', headers: auth(owner) });
    expect(res.statusCode).toBe(409);
  });

  it('signs the device out at once, refresh token and live access token alike', async () => {
    const second = await login(OWNER_EMAIL, 'owner-spare');
    expect((await app.inject({ method: 'GET', url: '/api/devices', headers: auth(second.accessToken) })).statusCode).toBe(200);

    const res = await app.inject({ method: 'DELETE', url: '/api/devices/owner-spare', headers: auth(owner) });
    expect(res.json()).toEqual({ ok: true, sessionsRevoked: 1 });
    expect((await devices(owner)).some((d) => d.id === 'owner-spare')).toBe(false);
    // Its access token has minutes left on the clock but is refused now.
    const dead = await app.inject({ method: 'GET', url: '/api/devices', headers: auth(second.accessToken) });
    expect(dead.statusCode).toBe(401);
    expect(dead.json().error).toMatch(/removed/);
    expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { [REFRESH_COOKIE]: second.cookie }, payload: {} })).statusCode).toBe(401);
    // The owner's own session is untouched.
    expect((await app.inject({ method: 'GET', url: '/api/devices', headers: auth(owner) })).statusCode).toBe(200);
  });

  it('a later sign-in from the same device works and lists it again', async () => {
    await new Promise((r) => setTimeout(r, 1100)); // iat has second resolution
    const back = await login(OWNER_EMAIL, 'owner-spare');
    expect((await app.inject({ method: 'GET', url: '/api/devices', headers: auth(back.accessToken) })).statusCode).toBe(200);
    expect((await devices(owner)).find((d) => d.id === 'owner-spare')).toMatchObject({ sessions: 1 });
  });
});
