import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGateway } from '@zollify/server-core';

/**
 * Refresh-token rotation is soft: an already-rotated token is still honoured
 * once more within a short grace window, then rejected. This covers the race
 * that fix was for - Android can kill and restart the WebView process mid-
 * request, so a straggler request presenting the just-rotated token is the
 * device's own prior attempt arriving late, not a stolen token being replayed.
 *
 * REFRESH_REUSE_GRACE_MS mirrors auth.ts's own (unexported) constant - keep
 * this in sync if that value ever changes.
 */
const REFRESH_REUSE_GRACE_MS = 20_000;

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-authrefresh-'));
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
});

afterEach(() => {
  vi.useRealTimers();
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

// Native header: keeps the refresh token in the JSON body instead of being
// moved to an httpOnly cookie (refresh-cookie.ts) - this test manipulates
// the token directly, same as the Android client this fix is actually for.
const NATIVE = { 'x-zollify-client': 'native' };

async function login(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: NATIVE,
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'Test', deviceId: 'dev-1' },
  });
  return res.json().refreshToken;
}

async function refresh(token: string) {
  return app.inject({ method: 'POST', url: '/api/auth/refresh', headers: NATIVE, payload: { refreshToken: token } });
}

describe('POST /api/auth/refresh - reuse grace window', () => {
  it('rotates normally: the new token works, the old one still works once more (grace)', async () => {
    const original = await login();

    const first = await refresh(original);
    expect(first.statusCode).toBe(200);
    const rotated = first.json().refreshToken as string;
    expect(rotated).not.toBe(original);

    // Straggler: the same already-rotated token, presented again almost
    // immediately. Must still succeed, not 401.
    const straggler = await refresh(original);
    expect(straggler.statusCode).toBe(200);
    expect(straggler.json().accessToken).toBeTruthy();
  });

  it('rejects the old token once the grace window has passed', async () => {
    const original = await login();
    const first = await refresh(original);
    expect(first.statusCode).toBe(200);

    // toFake: ['Date'] only - faking timers wholesale breaks Fastify's own
    // use of real setTimeout/microtasks and app.inject() never resolves.
    vi.useFakeTimers({ now: Date.now() + REFRESH_REUSE_GRACE_MS + 1_000, toFake: ['Date'] });
    const stale = await refresh(original);
    expect(stale.statusCode).toBe(401);
  });

  it('rejects a token that never existed', async () => {
    const res = await refresh('0'.repeat(64));
    expect(res.statusCode).toBe(401);
  });
});
