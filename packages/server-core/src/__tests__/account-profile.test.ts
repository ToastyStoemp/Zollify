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
