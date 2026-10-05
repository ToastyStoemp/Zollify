import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, reduceProducts, setEnabled } from '@zollify/server-core';
import { shortBarcode, type AppNotification, type Product, type ShareableItem } from '@zollify/shared';
import { consignmentServerModule } from '../modules/consignment';

/**
 * Sharing crosses accounts in the other direction: the artist decides, and
 * the server writes into the store's catalogue. What matters is that the
 * store gets exactly the shared items, priced in its own currency, with
 * photos, following the artist's edits - and that a scanned label of an
 * unshared item gets it on the till.
 */

const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let store: string;
let storeAccountId: string;
let artist: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (t: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/consignment${url}`, headers: auth(t), ...(payload ? { payload } : {}) });
let n = 0;
const push = (t: string, ops: { type: string; payload: unknown }[]) =>
  app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(t), payload: { deviceId: 'dev', ops: ops.map((o) => ({ opId: `op-share-${String(++n).padStart(10, '0')}`, deviceId: 'dev', ts: n, ...o })) } });
const storeOps = async () =>
  (await app.inject({ method: 'GET', url: '/api/sync/pull?since=0&limit=1000', headers: auth(store) })).json().ops as { opId: string; type: string; deviceId: string; payload: unknown }[];
const storeProducts = async () => new Map(reduceProducts(await storeOps()).map((p) => [p.id, p]));
const sharesPath = () => `/links/${storeAccountId}/ana/shares`;

const fox: Product = { id: 'a1', title: 'Fox print', sku: 'FOX-A4', type: 'Print', forSale: true, unlisted: false, price: 30, cost: 4, imageId: 'img1', variants: [], sortOrder: 0, updatedAt: 1 };
const tote: Product = { id: 'a2', title: 'Heron tote', type: 'Tote', forSale: true, unlisted: false, price: 25, variants: [{ id: 'n', name: 'Natural' }, { id: 'b', name: 'Black', price: 27 }], sortOrder: 1, updatedAt: 1 };

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-sharing-'));
  process.env.OWNER_EMAIL = 'shop@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [consignmentServerModule],
    defaultModules: ['consignment'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shop@example.test', password: PASSWORD } });
  store = login.json().accessToken;
  storeAccountId = login.json().user.accountId;
  await app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(store), payload: { defaultCurrency: 'CHF' } });

  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(store), payload: { newAccount: true } });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'ana@example.test', password: PASSWORD, inviteCode: invite.json().code, accountName: 'Ana Prints' } });
  artist = reg.json().accessToken;
  setEnabled(app.zollify.db, reg.json().user.accountId, 'consignment', true);
  await app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(artist), payload: { defaultCurrency: 'EUR' } });

  await push(artist, [
    { type: 'product.upsert', payload: fox },
    { type: 'product.upsert', payload: tote },
    { type: 'image.meta', payload: { imageId: 'img1', productId: 'a1', updatedAt: 5, thumbB64: 'AAAA' } },
  ]);
  await call(store, 'PUT', '/consignors/ana', { name: 'Ana', commissionPct: 40 });
  const { code } = (await call(store, 'POST', '/consignors/ana/link-code')).json();
  await call(artist, 'POST', '/links', { code });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('sharing items with a store', () => {
  it('shows the artist their catalogue, nothing shared yet', async () => {
    const res = (await call(artist, 'GET', sharesPath())).json();
    expect(res).toMatchObject({ artistCurrency: 'EUR', storeCurrency: 'CHF' });
    expect((res.items as ShareableItem[]).map((i) => [i.productId, i.shared, i.storePrice])).toEqual([
      ['a1', false, null],
      ['a2', false, null],
    ]);
    expect((await storeProducts()).size).toBe(0);
  });

  it('puts a shared item in the store with its photo, but not on sale until it has a rate', async () => {
    const res = await call(artist, 'PUT', sharesPath(), { productIds: ['a1'], shared: true });
    expect(res.statusCode).toBe(200);
    const p = (await storeProducts()).get('a1')!;
    expect(p).toMatchObject({ title: 'Fox print', consignorId: 'ana', consignorName: 'Ana', consignorProductId: 'a1', forSale: false, imageId: 'img1' });
    expect(p).not.toHaveProperty('cost');
    const img = (await storeOps()).find((o) => o.type === 'image.meta');
    expect(img?.payload).toMatchObject({ imageId: 'img1', thumbB64: 'AAAA' });
    expect(img?.deviceId).toBe('server:consignment');
    const bell = (await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(store) })).json().notifications as AppNotification[];
    expect(bell[0]?.title).toBe('Ana shared 1 item');
  });

  it('prices it in the store currency once the store sets a rate', async () => {
    expect((await call(store, 'PUT', '/consignors/ana/pricing', { rate: 0.95, rounding: 0.5 })).statusCode).toBe(200);
    expect((await storeProducts()).get('a1')).toMatchObject({ forSale: true, price: 28.5 });
    const pricing = (await call(store, 'GET', '/consignors/ana/pricing')).json();
    expect(pricing.items.map((i: ShareableItem) => [i.productId, i.storePrice])).toEqual([['a1', 28.5]]);
  });

  it('follows the artist editing the item, and does not resend an unchanged photo', async () => {
    const before = (await storeOps()).filter((o) => o.type === 'image.meta').length;
    await push(artist, [{ type: 'product.upsert', payload: { ...fox, title: 'Fox print A4', price: 40, updatedAt: 2 } }]);
    expect((await storeProducts()).get('a1')).toMatchObject({ title: 'Fox print A4', price: 38 });
    expect((await storeOps()).filter((o) => o.type === 'image.meta').length).toBe(before);
  });

  it('a per-item price wins over the conversion', async () => {
    await call(store, 'PUT', '/consignors/ana/pricing', { rate: 0.95, rounding: 0.5, overrides: { 'a1:': 35 } });
    expect((await storeProducts()).get('a1')?.price).toBe(35);
  });

  it('scanning an unshared item shares it and tells the artist', async () => {
    const code = shortBarcode('Tote', 'a2', 'b');
    const res = await call(store, 'POST', '/scan', { code });
    expect(res.json()).toMatchObject({ productId: 'a2', variantId: 'b', consignorName: 'Ana', autoShared: true, priced: true });
    const tote2 = (await storeProducts()).get('a2')!;
    expect(tote2.variants.map((v) => [v.id, v.price])).toEqual([['n', undefined], ['b', 25.5]]);
    expect(tote2.price).toBe(24);
    const bell = (await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(artist) })).json().notifications as AppNotification[];
    expect(bell[0]?.title).toMatch(/Heron tote was scanned at .* and is now shared/);
    const mine = (await call(artist, 'GET', sharesPath())).json().items as ShareableItem[];
    expect(mine.find((i) => i.productId === 'a2')).toMatchObject({ shared: true, autoShared: true });

    expect((await call(store, 'POST', '/scan', { code: 'NOPE' })).statusCode).toBe(404);
    expect((await call(store, 'POST', '/scan', { code: 'fox-a4' })).json()).toMatchObject({ productId: 'a1', autoShared: false });
  });

  it('unsharing takes it off the store till', async () => {
    await call(artist, 'PUT', sharesPath(), { productIds: ['a1'], shared: false });
    expect((await storeProducts()).get('a1')?.deletedAt).toBeTruthy();
    // Someone else's account cannot share into the store.
    expect((await call(store, 'PUT', sharesPath(), { productIds: ['a1'], shared: true })).statusCode).toBe(404);
  });

  it('the artist deleting a shared item removes it from the store too', async () => {
    await push(artist, [{ type: 'product.delete', payload: { id: 'a2', deletedAt: 9 } }]);
    expect((await storeProducts()).get('a2')?.deletedAt).toBeTruthy();
  });
});

describe('staff at the till', () => {
  it('may resolve a scanned label, but not see artists, commissions or payouts', async () => {
    const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(store), payload: { role: 'member' } });
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'sam@example.test', password: PASSWORD, inviteCode: invite.json().code } });
    const staff = reg.json().accessToken as string;
    expect((await call(staff, 'POST', '/scan', { code: 'nothing-here' })).statusCode).toBe(404);
    for (const [method, url] of [['GET', '/consignors'], ['GET', '/statement'], ['GET', '/planner'], ['PUT', '/consignors/ana/pricing']] as const) {
      expect((await call(staff, method, url, method === 'PUT' ? { rate: 1 } : undefined)).statusCode).toBe(403);
    }
  });
});
