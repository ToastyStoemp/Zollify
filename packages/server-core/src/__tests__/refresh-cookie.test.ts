import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGateway } from '../app';
import { REFRESH_COOKIE } from '../refresh-cookie';

/** Mirrors auth.ts's own (unexported) REFRESH_REUSE_GRACE_MS - keep in sync. */
const REFRESH_REUSE_GRACE_MS = 20_000;

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

afterEach(() => {
  vi.useRealTimers();
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

  it('still honours a just-rotated token once more (reuse grace window)', async () => {
    // Rotation is soft now, not hard-deleted: an Android WebView process
    // restart can race its own in-flight refresh, and a straggler request
    // presenting the just-rotated token is that device's own prior attempt
    // arriving late, not a stolen token being replayed. Moving the token to a
    // cookie must not change this - it's the same DB-level behaviour either way.
    const first = cookieFrom(await login());
    const cookies = { [REFRESH_COOKIE]: String(first?.value) };

    const ok = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies, payload: {} });
    expect(ok.statusCode).toBe(200);

    const straggler = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies, payload: {} });
    expect(straggler.statusCode).toBe(200);
  });

  it('refuses to reuse a rotated token once the grace window has passed', async () => {
    const first = cookieFrom(await login());
    const cookies = { [REFRESH_COOKIE]: String(first?.value) };

    const ok = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies, payload: {} });
    expect(ok.statusCode).toBe(200);

    // toFake: ['Date'] only - faking timers wholesale breaks Fastify's own
    // use of real setTimeout/microtasks and app.inject() never resolves.
    vi.useFakeTimers({ now: Date.now() + REFRESH_REUSE_GRACE_MS + 1_000, toFake: ['Date'] });
    const stale = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies, payload: {} });
    expect(stale.statusCode).toBe(401);
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
