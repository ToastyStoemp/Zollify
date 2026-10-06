import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, reduceDiscounts, setEnabled } from '@zollify/server-core';
import { consignmentArtistServerModule, consignmentServerModule } from '../modules/consignment';

/**
 * Artists discount their own work in a store, within what the store allows,
 * and the store can end it. An artist's account also hears about its work in
 * stores through its own webhooks.
 */

const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let store: string;
let storeAccountId: string;
let artist: string;
let receiver: Server;
let base = '';
const received: { path: string; body: { embeds?: { title: string; description?: string; fields?: { name: string; value: string }[] }[] } }[] = [];

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (t: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/${url.startsWith('/links') ? 'consignment-artist' : 'consignment'}${url}`, headers: auth(t), ...(payload ? { payload } : {}) });
let n = 0;
const push = (t: string, ops: { type: string; payload: unknown }[]) =>
  app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(t), payload: { deviceId: 'dev', ops: ops.map((o) => ({ opId: `op-disc-${String(++n).padStart(10, '0')}`, deviceId: 'dev', ts: n, ...o })) } });
const storeRules = async () =>
  reduceDiscounts((await app.inject({ method: 'GET', url: '/api/sync/pull?since=0&limit=1000', headers: auth(store) })).json().ops).filter((r) => !r.deletedAt);
const link = (path: string) => `/links/${storeAccountId}/ana${path}`;
const settle = () => new Promise((r) => setTimeout(r, 200));

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: JSON.parse(raw || '{}') });
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  dataDir = mkdtempSync(join(tmpdir(), 'zollify-disc-'));
  process.env.OWNER_EMAIL = 'shop@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  process.env.WEBHOOK_ALLOW_PRIVATE = '1';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [consignmentServerModule, consignmentArtistServerModule],
    defaultModules: ['consignment', 'consignment-artist'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shop@example.test', password: PASSWORD } });
  store = login.json().accessToken;
  storeAccountId = login.json().user.accountId;
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(store), payload: { newAccount: true } });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'ana@example.test', password: PASSWORD, inviteCode: invite.json().code } });
  artist = reg.json().accessToken;
  setEnabled(app.zollify.db, reg.json().user.accountId, 'consignment', true);
  setEnabled(app.zollify.db, reg.json().user.accountId, 'consignment-artist', true);

  await push(store, [
    { type: 'event.upsert', payload: { id: 'zh', name: 'Zurich shop', kind: 'store', venue: {}, currency: 'CHF', status: 'active', updatedAt: 1 } },
    { type: 'event.upsert', payload: { id: 'be', name: 'Bern shop', kind: 'store', venue: {}, currency: 'CHF', status: 'active', updatedAt: 1 } },
    { type: 'product.upsert', payload: { id: 'p1', title: 'Fox print', forSale: true, unlisted: false, price: 100, variants: [], consignorId: 'ana', sortOrder: 0, updatedAt: 1 } },
    { type: 'product.upsert', payload: { id: 'mug', title: 'House mug', forSale: true, unlisted: false, price: 12, variants: [], sortOrder: 1, updatedAt: 1 } },
  ]);
  await call(store, 'PUT', '/consignors/ana', { name: 'Ana', commissionPct: 40, storeIds: ['zh'] });
  const { code } = (await call(store, 'POST', '/consignors/ana/link-code')).json();
  await call(artist, 'POST', '/links', { code });
});

afterAll(async () => {
  await app.close();
  receiver.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
});

describe("artists' own discounts", () => {
  it('shows the artist what they may do and on what', async () => {
    const res = (await call(artist, 'GET', link('/discounts'))).json();
    expect(res).toMatchObject({ allowed: true, maxPct: 30, discounts: [] });
    expect(res.items).toEqual([{ productId: 'p1', title: 'Fox print' }]);
    expect(res.stores).toEqual([{ id: 'zh', name: 'Zurich shop' }]);
  });

  it("puts a discount on the artist's work in the store, within the limit and on their own items", async () => {
    expect((await call(artist, 'PUT', link('/discounts/spring'), { name: 'Spring sale', percent: 50 })).json().message).toMatch(/at most 30%/);
    expect((await call(artist, 'PUT', link('/discounts/spring'), { name: 'x', percent: 10, productIds: ['mug'] })).statusCode).toBe(400);
    expect((await call(artist, 'PUT', link('/discounts/spring'), { name: 'x', percent: 10, eventIds: ['be'] })).statusCode).toBe(400);
    const res = await call(artist, 'PUT', link('/discounts/spring'), { name: 'Spring sale', percent: 20, validFrom: '2026-03-01', validUntil: '2026-03-31' });
    expect(res.statusCode).toBe(200);
    const [rule] = await storeRules();
    expect(rule).toMatchObject({ id: 'artist:ana:spring', type: 'nth_pct', nth: 1, percent: 20, consignorIds: ['ana'], managedBy: 'consignment-artist', validFrom: '2026-03-01' });
    const bell = (await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(store) })).json().notifications;
    expect(bell[0].title).toBe('Ana set a discount: 20% off their work');
    expect((await call(artist, 'GET', link('/discounts'))).json().discounts).toEqual([expect.objectContaining({ id: 'spring', percent: 20 })]);
  });

  it('the store ending it from its own devices tells the artist', async () => {
    await push(store, [{ type: 'discount.delete', payload: { id: 'artist:ana:spring', deletedAt: Date.now() } }]);
    expect(await storeRules()).toEqual([]);
    const bell = (await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(artist) })).json().notifications;
    expect(bell[0].title).toMatch(/ended your discount/);
  });

  it('a store that stops allowing them ends the ones running, and refuses new ones', async () => {
    await call(artist, 'PUT', link('/discounts/autumn'), { name: 'Autumn', percent: 15, productIds: ['p1'] });
    expect(await storeRules()).toHaveLength(1);
    await call(store, 'PUT', '/books/settings', { artistDiscounts: false });
    expect(await storeRules()).toEqual([]);
    expect((await call(artist, 'PUT', link('/discounts/winter'), { name: 'Winter', percent: 10 })).statusCode).toBe(403);
  });
});

describe("an artist's webhooks", () => {
  it('hear each sale of their work in a store, and their summaries count it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/webhooks', headers: auth(artist), payload: { name: 'My Discord', url: `${base}/ana`, format: 'discord', events: ['consigned-sale', 'report.daily'], timeZone: 'UTC' } });
    expect(res.statusCode).toBe(201);
    received.length = 0;
    await push(store, [
      { type: 'tx.create', payload: { id: 'sale1', eventId: 'zh', deviceId: 'dev', timestamp: Date.now(), method: 'card', payments: [{ kind: 'card', amount: 112 }], items: [{ pid: 'p1', vid: null, title: 'Fox print', qty: 1, unitPrice: 100, lineTotal: 100, consignorId: 'ana' }, { pid: 'mug', vid: null, title: 'House mug', qty: 1, unitPrice: 12, lineTotal: 12 }], discounts: [], total: 112, currency: 'CHF' } },
    ]);
    await settle();
    expect(received).toHaveLength(1);
    const embed = received[0]!.body.embeds![0]!;
    expect(embed.title).toMatch(/^Sold at .+: CHF 60\.00 for you$/);
    expect(embed.description).toContain('Fox print');
    expect(embed.description).not.toContain('House mug');

    received.length = 0;
    await app.zollify.webhooks.sendDueReports(); // the first look only remembers yesterday
    await app.zollify.webhooks.sendDueReports(Date.now() + 86_400_000);
    const report = received[0]!.body.embeds![0]!;
    expect(report.fields).toContainEqual(expect.objectContaining({ name: 'Sold in stores', value: expect.stringContaining('1 item, CHF 60.00 for you') }));
  });
});
