import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../app';
import { REFRESH_COOKIE } from '../refresh-cookie';

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;
let token: string;
let cookie: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-profile-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = OWNER_PASSWORD;
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

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'Test' },
  });
  token = res.json().accessToken;
  cookie = String(res.cookies.find((c) => c.name === REFRESH_COOKIE)?.value);
});

afterAll(async () => {
  try {
    app.zollify?.db?.close();
  } catch {
    /* already closed */
  }
  await app.close();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
  delete process.env.OWNER_EMAIL;
  delete process.env.OWNER_PASSWORD;
  delete process.env.REQUIRE_CAPTCHA;
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe('account profile', () => {
  it('starts with setup not completed, so the wizard shows', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/account/profile', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().setupCompletedAt).toBeNull();
  });

  it('saves artist details and a new account name, and returns the fresh user', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/account/profile',
      headers: auth(),
      payload: { name: 'Harbour Prints', artist: { fullName: 'Wolf', postCodeCity: '8000 Zürich' } },
    });
    expect(res.statusCode).toBe(200);
    const user = res.json().user;
    expect(user.accountName).toBe('Harbour Prints');
    expect(user.profile.artist.fullName).toBe('Wolf');
    // Untouched fields stay as they were, not wiped by a partial update.
    expect(user.profile.artist.companyName).toBe('');
    expect(user.profile.setupCompletedAt).toBeNull();
  });

  it('marks setup complete once and keeps the first timestamp', async () => {
    const first = await app.inject({
      method: 'PUT',
      url: '/api/account/profile',
      headers: auth(),
      payload: { setupCompleted: true },
    });
    const at = first.json().user.profile.setupCompletedAt;
    expect(typeof at).toBe('number');

    const again = await app.inject({
      method: 'PUT',
      url: '/api/account/profile',
      headers: auth(),
      payload: { setupCompleted: true },
    });
    expect(again.json().user.profile.setupCompletedAt).toBe(at);
  });

  it('carries the profile on the login response so the shell needs no second call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { [REFRESH_COOKIE]: cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.profile.artist.fullName).toBe('Wolf');
  });

  it('keeps the small-business VAT exemptions, merged field by field', async () => {
    const put = (vat: unknown) => app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(), payload: { vat } });
    expect((await put({ exemptCountries: ['de', 'NL'], exNumber: 'DE123456789EX' })).statusCode).toBe(200);
    expect((await put({ homeNote: 'Kleinunternehmer' })).statusCode).toBe(200);

    const profile = (await app.inject({ method: 'GET', url: '/api/account/profile', headers: auth() })).json();
    expect(profile.vat).toEqual({ exemptCountries: ['DE', 'NL'], exNumber: 'DE123456789EX', homeNote: 'Kleinunternehmer', crossBorderNote: '' });

    expect((await put({ exemptCountries: ['Germany'] })).statusCode).toBe(400);
  });

  it('changes only the artist fields sent', async () => {
    const put = (artist: unknown) => app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(), payload: { artist } });
    await put({ companyName: 'Harbour Prints', street: 'Hafenweg 1' });
    await put({ street: 'Seestrasse 2' });
    const profile = (await app.inject({ method: 'GET', url: '/api/account/profile', headers: auth() })).json();
    expect(profile.artist).toMatchObject({ companyName: 'Harbour Prints', street: 'Seestrasse 2' });
  });

  it('keeps sales totals from staff until an admin allows it, and only an admin can', async () => {
    const get = async (t: string) => (await app.inject({ method: 'GET', url: '/api/account/profile', headers: { authorization: `Bearer ${t}` } })).json() as { staffSeesTotals: boolean };
    expect((await get(token)).staffSeesTotals).toBe(false);
    const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(), payload: { role: 'member' } });
    const staff = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'staff-totals@example.test', password: 'correct horse battery staple', inviteCode: invite.json().code } })).json().accessToken as string;
    expect((await app.inject({ method: 'PUT', url: '/api/account/profile', headers: { authorization: `Bearer ${staff}` }, payload: { staffSeesTotals: true } })).statusCode).toBe(403);
    const res = await app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(), payload: { staffSeesTotals: true } });
    expect(res.json().user.profile.staffSeesTotals).toBe(true);
    expect((await get(staff)).staffSeesTotals).toBe(true);
    // Other settings leave it alone.
    await app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(), payload: { defaultCurrency: 'EUR' } });
    expect((await get(token)).staffSeesTotals).toBe(true);
  });

  it('remembers what the account runs, and needs at least one', async () => {
    const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(), payload });
    // Not asked yet: unset, so the app falls back to what the account has.
    const before = (await app.inject({ method: 'GET', url: '/api/account/profile', headers: auth() })).json();
    expect(before.sells).toBeUndefined();
    expect((await put({ sells: { events: false, stores: true } })).json().user.profile.sells).toEqual({ events: false, stores: true });
    expect((await put({ sells: { events: false, stores: false } })).statusCode).toBe(400);
    // Other settings leave it alone.
    expect((await put({ defaultCurrency: 'CHF' })).json().user.profile.sells).toEqual({ events: false, stores: true });
  });

  it('keeps webstore and social links clean, merged field by field, and refuses anything but https', async () => {
    const put = (links: unknown) => app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(), payload: { links } });
    const get = async () => (await app.inject({ method: 'GET', url: '/api/account/profile', headers: auth() })).json();
    expect((await get()).links).toBeUndefined();

    const res = await put({ webstore: ' https://shop.example.com ', instagram: '@harbourprints', otherUrl: 'https://news.example.com', otherLabel: 'News' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().user.profile.links).toMatchObject({ webstore: 'https://shop.example.com/', instagram: 'https://www.instagram.com/harbourprints', otherLabel: 'News' });
    // Naming one link leaves the others alone.
    await put({ tiktok: 'harbour.prints' });
    expect((await get()).links).toMatchObject({ webstore: 'https://shop.example.com/', tiktok: 'https://www.tiktok.com/@harbour.prints' });

    for (const bad of ['javascript:alert(1)', 'http://shop.example.com', 'https://user:pw@shop.example.com', 'shop.example.com', `https://shop.example.com/${'a'.repeat(200)}`]) {
      const refused = await put({ webstore: bad });
      expect(refused.statusCode, bad).toBe(400);
      expect(refused.json().message).toMatch(/Webstore/);
    }
    expect((await put({ youtube: '@booth' })).statusCode).toBe(400);
    expect((await put({ otherUrl: 'https://x.example.com', otherLabel: 'x'.repeat(31) })).statusCode).toBe(400);
    // A refusal keeps what was saved, and clearing is a change like any other.
    expect((await get()).links.webstore).toBe('https://shop.example.com/');
    expect((await put({ webstore: '', instagram: '', tiktok: '', otherUrl: '' })).json().user.profile.links).toMatchObject({ webstore: '', instagram: '', otherLabel: '' });
  });

  it('stores a Belgian enterprise number in its dotted form, and refuses one that is not valid', async () => {
    const put = (enterpriseNumber: string) => app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(), payload: { artist: { enterpriseNumber } } });
    const res = await put('BE 0403 170 701');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().user.profile.artist.enterpriseNumber).toBe('0403.170.701');
    const bad = await put('0403170702');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/enterprise number/);
    expect((await put('')).json().user.profile.artist.enterpriseNumber).toBe('');
  });

  it('loads a profile saved before links and the enterprise number existed, unchanged', async () => {
    const db = app.zollify.db;
    const accountId = (db.prepare('SELECT accountId FROM users LIMIT 1').get() as { accountId: string }).accountId;
    db.prepare('UPDATE accounts SET profile = ? WHERE id = ?').run(
      JSON.stringify({ setupCompletedAt: 5, artist: { companyName: 'Old Booth', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'EUR' }),
      accountId,
    );
    const profile = (await app.inject({ method: 'GET', url: '/api/account/profile', headers: auth() })).json();
    expect(profile.artist.companyName).toBe('Old Booth');
    expect(profile.links).toBeUndefined();
    expect(profile.artist.enterpriseNumber ?? '').toBe('');
  });

  it('rejects a profile that fails validation', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/account/profile',
      headers: auth(),
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('logs out: the refresh token is dead afterwards', async () => {
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [REFRESH_COOKIE]: cookie },
      payload: {},
    });
    expect(out.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { [REFRESH_COOKIE]: cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});
