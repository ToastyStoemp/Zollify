import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled } from '@zollify/server-core';
import { sourcingServerModule } from '../modules/sourcing';
import { taxServerModule } from '../modules/tax/index';

/**
 * The year in review's printing side: what Sourcing's materials cost in a
 * year, and what the misprints came to - read by the tax module.
 */

const PASSWORD = 'correct horse battery staple';
const SECRET = 'test-secret-value-long-enough-for-signing';
let app: FastifyInstance;
let dataDir: string;
let token: string;
let accountId: string;
const auth = () => ({ authorization: `Bearer ${token}` });
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) => app.inject({ method, url, headers: auth(), ...(payload ? { payload } : {}) });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-tax-year-'));
  process.env.OWNER_EMAIL = 'owner@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: SECRET,
    serverModules: [taxServerModule(SECRET), sourcingServerModule],
    defaultModules: ['tax', 'sourcing'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.test', password: PASSWORD } });
  token = login.json().accessToken;
  accountId = login.json().user.accountId;
  setEnabled(app.zollify.db, accountId, 'sourcing', true);
  setEnabled(app.zollify.db, accountId, 'tax', true);
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the year in review', () => {
  it('adds up the materials bought in the year by type, and the misprints at the average price', async () => {
    await call('PUT', '/api/m/sourcing/materials/a3', { id: 'a3', name: 'Hahnemühle A3', type: 'paper', unit: 'sheet', purchases: [{ id: 'p1', qty: 50, cost: 100, date: '2026-01-15' }, { id: 'p2', qty: 50, cost: 150, date: '2026-06-01' }, { id: 'p0', qty: 50, cost: 80, date: '2025-11-20' }] });
    await call('PUT', '/api/m/sourcing/materials/ink', { id: 'ink', name: 'Cyan', type: 'ink', unit: 'ml', purchases: [{ id: 'i1', qty: 80, cost: 40, date: '2026-03-03' }] });
    expect((await call('POST', '/api/m/sourcing/materials/a3/use', { qty: 10 })).statusCode).toBe(200);
    // A misprint, as Sourcing logs one.
    app.zollify.db.prepare('INSERT INTO sourcing_material_use (accountId, id, materialId, qty, at, source, note, keyId) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run(accountId, 'w1', 'a3', 4, Date.now(), 'waste', 'banding');

    const thisYear = new Date().getUTCFullYear();
    const res = await call('GET', `/api/m/tax/year/2026`);
    expect(res.statusCode).toBe(200);
    expect(res.json().materials).toEqual({ spent: 290, orders: 3, byType: { paper: 250, ink: 40 } });
    // Waste is logged now, so it lands in this year; 4 sheets at the average 330 / 150 = 2.20.
    const waste = (await call('GET', `/api/m/tax/year/${thisYear}`)).json().waste;
    expect(waste).toEqual({ qty: 4, cost: 8.8, byMaterial: [{ id: 'a3', name: 'Hahnemühle A3', unit: 'sheet', qty: 4, cost: 8.8 }] });
    expect((await call('GET', '/api/m/tax/year/2024')).json()).toEqual({ materials: { spent: 0, orders: 0, byType: {} }, waste: { qty: 0, cost: 0, byMaterial: [] } });
    expect((await call('GET', '/api/m/tax/year/abc')).statusCode).toBe(400);
  });
});
