import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled, type MailMessage } from '@zollify/server-core';
import type { ArtistConsignment, InventoryItem } from '@zollify/shared';
import { consignmentServerModule } from '../modules/consignment';

/**
 * An artist's stock in a store changes from outside the store's own
 * devices - by the artist walking in, or by post. The store's count is what
 * its till sells against, so the tests pin that count: what is left plus
 * what was added, only for the artist's own items, and for a package only
 * what the store says arrived.
 */

const PASSWORD = 'correct horse battery staple';
const sent: MailMessage[] = [];
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
  app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(t), payload: { deviceId: 'dev', ops: ops.map((o) => ({ opId: `op-stock-${String(++n).padStart(10, '0')}`, deviceId: 'dev', ts: n, ...o })) } });
/** The store's current count of an item, as its devices would apply it. */
async function onHand(productId: string, variantId = ''): Promise<number | undefined> {
  const ops = (await app.inject({ method: 'GET', url: '/api/sync/pull?since=0&limit=1000', headers: auth(store) })).json().ops as { type: string; payload: InventoryItem }[];
  const rows = ops.filter((o) => o.type === 'inventory.set' && o.payload.productId === productId && o.payload.variantId === variantId);
  return rows.sort((a, b) => a.payload.updatedAt - b.payload.updatedAt).at(-1)?.payload.onHand;
}
const link = (path: string) => `/links/${storeAccountId}/ana${path}`;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-stock-'));
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
    mailer: { enabled: true, send: async (m) => (sent.push(m), true) },
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shop@example.test', password: PASSWORD } });
  store = login.json().accessToken;
  storeAccountId = login.json().user.accountId;
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(store), payload: { newAccount: true } });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'ana@example.test', password: PASSWORD, inviteCode: invite.json().code } });
  artist = reg.json().accessToken;
  setEnabled(app.zollify.db, reg.json().user.accountId, 'consignment', true);

  // The store: a shop with Ana's print (counted at 4, sold 1 since) and its own mug.
  await push(store, [
    { type: 'event.upsert', payload: { id: 'zh', name: 'Zurich shop', kind: 'store', venue: {}, currency: 'CHF', status: 'active', updatedAt: 1 } },
    { type: 'product.upsert', payload: { id: 'p1', title: 'Fox print', forSale: true, unlisted: false, price: 30, variants: [], consignorId: 'ana', sortOrder: 0, updatedAt: 1 } },
    { type: 'product.upsert', payload: { id: 'tee', title: 'Fox tee', forSale: true, unlisted: false, price: 25, variants: [{ id: 's' , name: 'S' }, { id: 'm', name: 'M' }], consignorId: 'ana', sortOrder: 1, updatedAt: 1 } },
    { type: 'product.upsert', payload: { id: 'mug', title: 'House mug', forSale: true, unlisted: false, price: 12, variants: [], sortOrder: 2, updatedAt: 1 } },
    { type: 'inventory.set', payload: { productId: 'p1', variantId: '', onHand: 4, updatedAt: 1 } },
    { type: 'stock.set', payload: { eventId: 'zh', productId: 'p1', variantId: '', broughtQty: 4, updatedAt: 1 } },
    { type: 'tx.create', payload: { id: 't1', eventId: 'zh', deviceId: 'dev', timestamp: 5, method: 'cash', payments: [], items: [{ pid: 'p1', vid: null, title: 'Fox print', qty: 1, unitPrice: 30, lineTotal: 30, consignorId: 'ana' }], discounts: [], total: 30, currency: 'CHF' } },
  ]);
  await call(store, 'PUT', '/consignors/ana', { name: 'Ana', commissionPct: 40, storeIds: ['zh'] });
  const { code } = (await call(store, 'POST', '/consignors/ana/link-code')).json();
  await call(artist, 'POST', '/links', { code });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('artists restocking in person', () => {
  it('adds to what is left, grows the store reservation, and tells the store', async () => {
    const res = await call(artist, 'POST', link('/stock'), { storeId: 'zh', lines: [{ productId: 'p1', qty: 5 }, { productId: 'mug', qty: 50 }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().change.lines).toEqual([{ productId: 'p1', variantId: '', qty: 5 }]);
    expect(await onHand('p1')).toBe(8); // 4 counted, 1 sold, 5 added
    expect(await onHand('mug')).toBeUndefined(); // not hers
    const bell = (await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(store) })).json().notifications;
    expect(bell[0].title).toBe('Ana restocked 5 items');
  });

  it('can recount instead, and only for real variants', async () => {
    await call(artist, 'POST', link('/stock'), { mode: 'set', lines: [{ productId: 'tee', variantId: 'm', qty: 3 }, { productId: 'tee', variantId: 'xl', qty: 9 }, { productId: 'tee', qty: 9 }] });
    expect(await onHand('tee', 'm')).toBe(3);
    expect(await onHand('tee', 'xl')).toBeUndefined();
    expect(await onHand('tee', '')).toBeUndefined();
  });
});

describe('packages from remote artists', () => {
  let id = '';

  it('changes nothing until the store confirms it, and tells the store it is coming', async () => {
    sent.length = 0;
    const res = await call(artist, 'POST', link('/shipments'), { storeId: 'zh', lines: [{ productId: 'p1', qty: 6 }, { productId: 'tee', variantId: 's', qty: 4 }], carrier: 'Post', tracking: 'CH123' });
    expect(res.statusCode).toBe(201);
    id = res.json().shipment.id;
    expect(res.json().shipment.lines.map((l: { title: string }) => l.title)).toEqual(['Fox print', 'Fox tee · S']);
    expect(await onHand('p1')).toBe(8);
    expect(sent[0]).toMatchObject({ to: 'shop@example.test', subject: 'Ana sent a package: 10 items' });
    expect((await call(store, 'GET', '/shipments')).json().shipments[0]).toMatchObject({ id, status: 'sent' });
  });

  it('adds what the store counted on arrival, and tells the artist about any difference', async () => {
    sent.length = 0;
    const res = await call(store, 'POST', `/shipments/${id}/receive`, { lines: [{ productId: 'p1', qty: 6 }, { productId: 'tee', variantId: 's', qty: 3 }] });
    expect(res.json().shipment).toMatchObject({ status: 'received' });
    expect(await onHand('p1')).toBe(14);
    expect(await onHand('tee', 's')).toBe(3);
    expect(sent[0]?.subject).toMatch(/received your package: 9 items/);
    expect(sent[0]?.text).toContain('Fox tee · S: sent 4, counted 3');
    expect((await call(store, 'POST', `/shipments/${id}/receive`)).statusCode).toBe(409);

    const [mine] = (await call(artist, 'GET', '/links')).json().links as ArtistConsignment[];
    expect(mine!.shipments[0]).toMatchObject({ status: 'received' });
    expect(mine!.stockChanges.map((c) => c.kind)).toEqual(['package', 'recount', 'restock']);
  });

  it('lets the artist cancel a package the store has not confirmed', async () => {
    const res = await call(artist, 'POST', link('/shipments'), { storeId: 'zh', lines: [{ productId: 'p1', qty: 1 }] });
    expect((await call(artist, 'DELETE', link(`/shipments/${res.json().shipment.id}`))).statusCode).toBe(200);
    expect((await call(store, 'POST', `/shipments/${res.json().shipment.id}/receive`)).statusCode).toBe(409);
    expect((await call(artist, 'DELETE', link(`/shipments/${id}`))).statusCode).toBe(409);
  });
});
