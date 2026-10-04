import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, makeSecretBox } from '@zollify/server-core';
import { FISKALY_BASE, FiskalyApi } from '../modules/fiskaly/api';

/**
 * The fiskaly routes against fiskaly's real TEST environment. Runs only with
 * a TEST key in FISKALY_API_KEY and FISKALY_API_SECRET. Each run creates a
 * TEST TSS and disables it at the end - fiskaly allows only 5 active TSS in
 * TEST, and a TSS can only be disabled with its admin PIN, which lives in
 * this run's database. Behind a proxy, run with NODE_USE_ENV_PROXY=1;
 * FISKALY_BASE_URL points it at another fiskaly, as for the server.
 */

const KEY = process.env.FISKALY_API_KEY;
const SECRET = process.env.FISKALY_API_SECRET;
const JWT_SECRET = 'test-secret-value-long-enough-for-signing';
const api = new FiskalyApi((url, init) => fetch(url, init), process.env.FISKALY_BASE_URL || FISKALY_BASE);
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
      jwtSecret: JWT_SECRET,
      serverModules: [posServerModule(JWT_SECRET, { fiskaly: api })],
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
    try {
      await disableTss();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);

  /** Disables this run's TSS, from wherever its setup got to, with the PUK and PIN kept (encrypted) in the run's database. */
  async function disableTss(): Promise<void> {
    const db = new Database(join(dataDir, 'zollify.db'), { readonly: true });
    const row = db.prepare('SELECT blob, tssId, tssState FROM fiskaly_config').get() as { blob: string; tssId: string | null; tssState: string | null } | undefined;
    db.close();
    if (!row?.tssId || row.tssState === 'DISABLED') return;
    const s = makeSecretBox(JWT_SECRET, 'zollify-module-credentials-v1').decrypt(row.blob) as { apiKey: string; apiSecret: string; adminPuk?: string; adminPin?: string };
    const { token: t } = await api.auth(s.apiKey, s.apiSecret);
    const state = String((await api.getTss(t, row.tssId)).state ?? '');
    if (state === 'DISABLED') return;
    if (state === 'CREATED') await api.setTssState(t, row.tssId, 'UNINITIALIZED');
    let pin = s.adminPin;
    if (!pin) {
      if (!s.adminPuk) throw new Error(`TSS ${row.tssId} has neither PIN nor PUK - disable it in the fiskaly dashboard.`);
      pin = '1234567890';
      await api.setAdminPin(t, row.tssId, s.adminPuk, pin);
    }
    await api.adminLogin(t, row.tssId, pin);
    await api.setTssState(t, row.tssId, 'DISABLED');
    expect(String((await api.getTss(t, row.tssId)).state)).toBe('DISABLED');
  }

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
