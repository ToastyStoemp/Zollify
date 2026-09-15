import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../app';
import { REFRESH_COOKIE } from '../refresh-cookie';

/**
 * Exercises the real gateway rather than the hook in isolation: the thing worth
 * proving is that a refresh token never reaches a response body, and that is a
 * property of the whole request pipeline.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-test-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = OWNER_PASSWORD;

  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [],
    defaultModules: [],
    allowedOrigins: [],
    // Plain HTTP so inject() requests are not rejected by the HTTPS guard; the
    // Secure attribute that follows this flag is covered separately below.
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
});

afterAll(async () => {
  await teardown(app, dataDir);
  delete process.env.OWNER_EMAIL;
  delete process.env.OWNER_PASSWORD;
});

/**
 * Closing Fastify does not close the SQLite handle, and Windows refuses to
 * delete a directory whose file is still open - so the database is closed
 * explicitly. Cleanup failure is never worth failing a test over: the directory
 * is in the OS temp folder either way.
 */
async function teardown(instance: FastifyInstance | undefined, dir: string): Promise<void> {
  try {
    instance?.zollify?.db?.close();
  } catch {
    /* already closed */
  }
  await instance?.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS will reclaim it */
  }
}

async function login(headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers,
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'Test register' },
  });
}

function cookieFrom(res: { cookies: { name: string; value: string; [k: string]: unknown }[] }) {
  return res.cookies.find((c) => c.name === REFRESH_COOKIE);
}

describe('refresh token transport', () => {
  it('signs in and returns an access token', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('accessToken');
  });

  it('never puts the refresh token in the response body', async () => {
    // The whole point: an XSS bug in this origin - where runtime modules run -
    // must not be able to read a long-lived refresh token.
    const res = await login();
    expect(res.json()).not.toHaveProperty('refreshToken');
    expect(res.payload).not.toContain('refreshToken');
  });

  it('sets the refresh token as an httpOnly, SameSite=Strict cookie', async () => {
    const cookie = cookieFrom(await login());

    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(String(cookie?.sameSite).toLowerCase()).toBe('strict');
    // Scoped to the auth routes, so it is not attached to every API call.
    expect(cookie?.path).toBe('/api/auth');
    expect(String(cookie?.value ?? '').length).toBeGreaterThanOrEqual(32);
  });

  it('refreshes using only the cookie, with no token in the request body', async () => {
    const first = cookieFrom(await login());

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { [REFRESH_COOKIE]: String(first?.value) },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('accessToken');
    expect(res.json()).not.toHaveProperty('refreshToken');
  });

  it('rotates the cookie on every refresh', async () => {
    const first = cookieFrom(await login());

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { [REFRESH_COOKIE]: String(first?.value) },
      payload: {},
    });
    const rotated = cookieFrom(res);

    expect(rotated?.value).toBeDefined();
    expect(rotated?.value).not.toBe(first?.value);
  });

  it('refuses to reuse a rotated token', async () => {
    // Single-use rotation is the ported behaviour; moving the token to a cookie
    // must not have quietly disabled it.
    const first = cookieFrom(await login());
    const cookies = { [REFRESH_COOKIE]: String(first?.value) };

    const ok = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies, payload: {} });
    expect(ok.statusCode).toBe(200);

    const replay = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies, payload: {} });
    expect(replay.statusCode).toBe(401);
  });

  it('rejects a refresh with neither cookie nor body token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: {} });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('still returns the token in the body for a native client', async () => {
    // A Capacitor shell keeps it in platform secure storage; cookies in a
    // WebView are a poorer fit than the keychain.
    const res = await login({ 'x-zollify-client': 'native' });

    expect(res.json()).toHaveProperty('refreshToken');
    // The cookie is still set, so a native client that ignores it loses nothing.
    expect(cookieFrom(res)).toBeDefined();
  });
});

describe('cookie Secure attribute', () => {
  it('is set when the gateway requires HTTPS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zollify-https-'));
    const secureApp = await buildGateway({
      dataDir: dir,
      moduleStoreDir: join(dir, 'modules'),
      jwtSecret: 'test-secret-value-long-enough-for-signing',
      serverModules: [],
      defaultModules: [],
      allowedOrigins: [],
      requireHttps: true,
      trustProxy: true,
      logLevel: 'silent',
    });
    await secureApp.ready();

    try {
      const res = await secureApp.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-proto': 'https' },
        payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
      });

      expect(res.statusCode).toBe(200);
      expect(cookieFrom(res)?.secure).toBe(true);
    } finally {
      await teardown(secureApp, dir);
    }
  });
});
