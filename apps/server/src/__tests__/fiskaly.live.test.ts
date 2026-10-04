import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '@zollify/server-core';
import { FiskalyApi } from '../modules/fiskaly/api';

/**
 * The fiskaly routes against fiskaly's real TEST environment. Runs only with
 * a TEST key in FISKALY_API_KEY and FISKALY_API_SECRET. Each run creates a
 * new TEST TSS, and fiskaly allows 5 active ones in TEST: disable old ones in
 * the fiskaly dashboard. Behind a proxy, run with NODE_USE_ENV_PROXY=1.
 */

const KEY = process.env.FISKALY_API_KEY;
const SECRET = process.env.FISKALY_API_SECRET;
const { posServerModule } = await import('../modules/receipts');

describe.skipIf(!KEY || !SECRET)('fiskaly TEST environment', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let token: string;
  const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api/m/pos${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'zollify-fiskaly-live-'));
    process.env.OWNER_EMAIL = 'owner@example.test';
    process.env.OWNER_PASSWORD = 'correct horse battery staple';
    app = await buildGateway({
      dataDir,
      moduleStoreDir: join(dataDir, 'modules'),
      jwtSecret: 'test-secret-value-long-enough-for-signing',
      serverModules: [posServerModule('test-secret-value-long-enough-for-signing', { fiskaly: new FiskalyApi((url, init) => fetch(url, init)) })],
      defaultModules: ['pos'],
      allowedOrigins: [],
      requireHttps: false,
      trustProxy: false,
      logLevel: 'silent',
    });
    await app.ready();
    token = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.test', password: 'correct horse battery staple', deviceName: 'Test' } })).json().accessToken;
  });

  afterAll(async () => {
    await app?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses a wrong secret, and takes the right one', async () => {
    const bad = await call('PUT', '/fiskaly', { apiKey: KEY, apiSecret: 'wrong' });
    expect(bad.statusCode).toBe(422);
    expect((await call('PUT', '/fiskaly', { apiKey: KEY, apiSecret: SECRET })).json()).toEqual({ configured: true, env: 'TEST' });
  });

  it('creates and initialises a TSS', async () => {
    const res = await call('POST', '/fiskaly/setup');
    expect(res.statusCode).toBe(200);
    expect(res.json().tss).toMatchObject({ state: 'INITIALIZED', serial: expect.stringMatching(/^[0-9a-f]{64}$/) });
  }, 120_000);

  it('signs exactly the processData sent', async () => {
    const started = await call('POST', '/fiskaly/start', { clientId: 'ZOLLIFY-LIVE' });
    expect(started.statusCode).toBe(200);
    const processData = 'Beleg^21.00_0.00_0.00_0.00_0.00^21.00:Unbar';
    const finished = await call('POST', '/fiskaly/finish', { clientId: 'ZOLLIFY-LIVE', number: started.json().number, processType: 'Kassenbeleg-V1', processData });
    expect(finished.statusCode).toBe(200);
    expect(finished.json()).toMatchObject({
      number: started.json().number,
      info: { algorithm: 'ecdsa-plain-SHA256', timeFormat: 'unixTime', certified: false },
      exact: { clientId: 'ZOLLIFY-LIVE', processType: 'Kassenbeleg-V1', processData },
    });
  }, 60_000);

  it('registers tills that sign for the first time at the same moment', async () => {
    const res = await Promise.all(['ZOLLIFY-A', 'ZOLLIFY-B', 'ZOLLIFY-C', 'ZOLLIFY-A', 'ZOLLIFY-B'].map((clientId) => call('POST', '/fiskaly/start', { clientId })));
    expect(res.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
  }, 60_000);
});
