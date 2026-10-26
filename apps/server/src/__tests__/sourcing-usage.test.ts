import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled } from '@zollify/server-core';
import { sourcingServerModule } from '../modules/sourcing';

/**
 * Paper on hand: bought less used, and the printing app taking off what it
 * prints with a printer key - a key that can do that and nothing else.
 */

const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let accountId: string;
let secret = '';
let keyId = '';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/sourcing${url}`, headers: auth(owner), ...(payload ? { payload } : {}) });
const printer = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>, key = secret) =>
  app.inject({ method, url: `/p/sourcing${url}`, headers: auth(key), ...(payload ? { payload } : {}) });
const onHand = async (id: string) => {
  const snap = (await call('GET', '/snapshot')).json();
  const m = snap.materials.find((x: { id: string }) => x.id === id);
  const bought = m.purchases.reduce((s: number, p: { qty: number }) => s + p.qty, 0);
  return bought - (snap.usage[id]?.used ?? 0);
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-sourcing-'));
  process.env.OWNER_EMAIL = 'owner@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [sourcingServerModule],
    defaultModules: ['sourcing'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.test', password: PASSWORD } });
  owner = login.json().accessToken;
  accountId = login.json().user.accountId;
  setEnabled(app.zollify.db, accountId, 'sourcing', true);
  await call('PUT', '/materials/a3', { id: 'a3', name: 'Hahnemühle A3', type: 'paper', unit: 'sheet', lowAt: 20, purchases: [{ id: 'p1', qty: 50, cost: 40, date: '2026-10-01' }] });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('paper on hand', () => {
  it('is what was bought, less what is used by hand', async () => {
    expect(await onHand('a3')).toBe(50);
    expect((await call('POST', '/materials/a3/use', { qty: 2, note: 'misprint' })).json().onHand).toBe(48);
  });

  it('takes a recount, logging the difference', async () => {
    expect((await call('POST', '/materials/a3/count', { onHand: 45 })).json().onHand).toBe(45);
    const recent = (await call('GET', '/snapshot')).json().usage.a3.recent;
    expect(recent[0]).toMatchObject({ source: 'count', qty: 3, note: 'Counted 45' });
  });
});

describe('an order that comes in parts', () => {
  it('counts only what arrived, and the rest as on order', async () => {
    // 3 boxes of 25 ordered, 1 box sent so far.
    await call('PUT', '/materials/a4', { id: 'a4', name: 'Matte A4', type: 'paper', unit: 'sheet', packSize: 25, packName: 'box', purchases: [{ id: 'o1', qty: 75, cost: 30, date: '2026-10-20', deliveries: [{ id: 'd1', qty: 25, date: '2026-10-22' }] }] });
    expect((await call('POST', '/materials/a4/use', { qty: 1 })).json().onHand).toBe(24);
    await call('PUT', '/materials/a4', { id: 'a4', name: 'Matte A4', type: 'paper', unit: 'sheet', packSize: 25, packName: 'box', purchases: [{ id: 'o1', qty: 75, cost: 30, date: '2026-10-20', deliveries: [{ id: 'd1', qty: 25, date: '2026-10-22' }, { id: 'd2', qty: 25, date: '2026-10-29' }] }] });
    // A second box arrives a week later.
    expect((await call('POST', '/materials/a4/use', { qty: 4 })).json().onHand).toBe(45);
  });
});

describe('the printing app', () => {
  it('gets a key, shown once and kept hashed', async () => {
    const res = await call('POST', '/keys', { label: 'Studio PC' });
    expect(res.statusCode).toBe(201);
    secret = res.json().secret;
    keyId = res.json().key.id;
    expect(secret).toMatch(/^zpk_/);
    expect((await call('GET', '/keys')).json().keys).toEqual([expect.objectContaining({ label: 'Studio PC', lastUsedAt: null })]);
    const stored = app.zollify.db.prepare('SELECT hash FROM sourcing_keys WHERE id = ?').get(keyId) as { hash: string };
    expect(stored.hash).not.toContain(secret);
  });

  it('lists the materials with what is on hand', async () => {
    const res = await printer('GET', '/materials');
    expect(res.statusCode).toBe(200);
    expect(res.json().materials.filter((m: { id: string }) => m.id === 'a3')).toEqual([{ id: 'a3', name: 'Hahnemühle A3', type: 'paper', unit: 'sheet', onHand: 45, onOrder: 0, lowAt: 20 }]);
  });

  it('takes off what it prints, by name, and counts a resent job once', async () => {
    const first = await printer('POST', '/usage', { material: 'hahnemühle a3', qty: 10, id: 'job-0001', note: 'Harbour prints' });
    expect(first.statusCode).toBe(201);
    expect(first.json().material.onHand).toBe(35);
    const again = await printer('POST', '/usage', { material: 'a3', qty: 10, id: 'job-0001' });
    expect(again.json()).toMatchObject({ duplicate: true, material: { onHand: 35 } });
    expect((await call('GET', '/snapshot')).json().usage.a3.recent[0]).toMatchObject({ source: 'printer', qty: 10, note: 'Harbour prints' });
    expect((await call('GET', '/keys')).json().keys[0].lastUsedAt).toBeGreaterThan(0);
  });

  it('says when the paper runs low, once', async () => {
    await printer('POST', '/usage', { material: 'a3', qty: 16, id: 'job-0002' });
    await printer('POST', '/usage', { material: 'a3', qty: 1, id: 'job-0003' });
    const bell = (await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(owner) })).json().notifications;
    expect(bell.filter((n: { title: string }) => n.title === 'Hahnemühle A3 is running low')).toHaveLength(1);
  });

  it('names a material it does not know', async () => {
    const res = await printer('POST', '/usage', { material: 'A2 gloss', qty: 1 });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/A2 gloss/);
  });

  it('can do nothing else with the key', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/m/sourcing/snapshot', headers: auth(secret) })).statusCode).toBe(401);
    expect((await printer('GET', '/materials', undefined, 'zpk_made-up')).statusCode).toBe(401);
    expect((await printer('GET', '/materials', undefined, owner)).statusCode).toBe(401);
  });

  it('stops working when the key is revoked or Sourcing is off', async () => {
    setEnabled(app.zollify.db, accountId, 'sourcing', false);
    expect((await printer('GET', '/materials')).statusCode).toBe(401);
    setEnabled(app.zollify.db, accountId, 'sourcing', true);
    await call('DELETE', `/keys/${keyId}`);
    expect((await printer('POST', '/usage', { material: 'a3', qty: 1 })).statusCode).toBe(401);
  });

  it('forgets a removed material\'s uses', async () => {
    await call('DELETE', '/materials/a3');
    const left = app.zollify.db.prepare("SELECT COUNT(*) AS n FROM sourcing_material_use WHERE accountId = ? AND materialId = 'a3'").get(accountId) as { n: number };
    expect(left.n).toBe(0);
  });
});
