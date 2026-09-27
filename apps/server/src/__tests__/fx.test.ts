import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGateway } from '@zollify/server-core';

/**
 * /api/fx/rates proxies Frankfurter server-side - Frankfurter itself sends no
 * CORS headers, so a browser's own fetch to it is blocked outright regardless
 * of origin. This is what History's real-day-rate currency toggle calls.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;
let accessToken: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-fx-'));
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

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-zollify-client': 'native' },
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'Test' },
  });
  accessToken = login.json().accessToken;
});

afterEach(() => {
  vi.unstubAllGlobals();
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

function fx(query: string) {
  return app.inject({ method: 'GET', url: `/api/fx/rates?${query}`, headers: { authorization: `Bearer ${accessToken}` } });
}

describe('GET /api/fx/rates', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fx/rates?from=SEK&to=EUR&dates=2026-07-23' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request missing required params', async () => {
    const res = await fx('from=SEK&to=EUR');
    expect(res.statusCode).toBe(400);
  });

  it('short-circuits same-currency pairs without calling upstream', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await fx('from=EUR&to=EUR&dates=2026-07-23,2026-07-24');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rates: { '2026-07-23': 1, '2026-07-24': 1 } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches a settled date from Frankfurter and caches the result', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { EUR: 0.0889 } }) });
    vi.stubGlobal('fetch', fetchSpy);

    const first = await fx('from=SEK&to=EUR&dates=2020-01-15');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ rates: { '2020-01-15': 0.0889 } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://api.frankfurter.app/2020-01-15?from=SEK&to=EUR');

    const second = await fx('from=SEK&to=EUR&dates=2020-01-15');
    expect(second.json()).toEqual({ rates: { '2020-01-15': 0.0889 } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('omits a date the upstream has no rate for, instead of failing the whole request', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchSpy);

    const res = await fx('from=SEK&to=EUR&dates=2020-02-02');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rates: {} });
  });

  it('never caches "latest" (today/future), since it can still move', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { EUR: 0.09 } }) });
    vi.stubGlobal('fetch', fetchSpy);

    await fx(`from=SEK&to=EUR&dates=${today}`);
    await fx(`from=SEK&to=EUR&dates=${today}`);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://api.frankfurter.app/latest?from=SEK&to=EUR');
  });
});
