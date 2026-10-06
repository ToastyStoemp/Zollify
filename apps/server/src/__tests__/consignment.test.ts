import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled } from '@zollify/server-core';
import type { ArtistConsignment } from '@zollify/shared';
import { consignmentArtistServerModule, consignmentServerModule } from '../modules/consignment';

/**
 * Consignment crosses accounts, so what is worth proving is the boundary: a
 * store's statement adds up, an artist sees their own sales at the store and
 * nothing else of it, and only a code the owner issued opens that view.
 */

const OWNER_EMAIL = 'store-owner@example.test';
const PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;
let store: string; // store owner's access token
let artist: string; // the artist's own booth account
let stranger: string; // an unrelated account

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
let opSeq = 0;
const op = (type: string, payload: unknown) => ({ opId: `op-${String(++opSeq).padStart(16, '0')}`, deviceId: 'dev-1', ts: opSeq, type, payload });

async function newAccount(email: string, accountName: string): Promise<string> {
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(store), payload: { newAccount: true } });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: PASSWORD, inviteCode: invite.json().code, accountName },
  });
  expect(res.statusCode).toBe(200);
  setEnabled(app.zollify.db, res.json().user.accountId, 'consignment', true);
  setEnabled(app.zollify.db, res.json().user.accountId, 'consignment-artist', true);
  return res.json().accessToken;
}

const call = (token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/${url.startsWith('/links') ? 'consignment-artist' : 'consignment'}${url}`, headers: auth(token), ...(payload ? { payload } : {}) });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-consign-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';

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

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER_EMAIL, password: PASSWORD } });
  store = login.json().accessToken;
  artist = await newAccount('artist@example.test', 'Ana Prints');
  stranger = await newAccount('stranger@example.test', 'Someone Else');

  // The artist's own booth: one product for sale, with a cost that must not leak.
  await app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: auth(artist),
    payload: {
      deviceId: 'dev-a',
      ops: [op('product.upsert', { id: 'ap1', title: 'Fox print', forSale: true, unlisted: false, price: 30, cost: 4, variants: [], sortOrder: 0, updatedAt: 1 })],
    },
  });

  // The store: two shops, an event, the artist's print and its own mug.
  const sale = (id: string, eventId: string, items: unknown[], extra: Record<string, unknown> = {}) =>
    op('tx.create', { id, eventId, deviceId: 'dev-1', timestamp: opSeq, method: 'cash', payments: [], items, discounts: [], total: 0, currency: 'CHF', ...extra });
  await app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: auth(store),
    payload: {
      deviceId: 'dev-1',
      ops: [
        op('event.upsert', { id: 'zurich', name: 'Zurich shop', kind: 'store', venue: { city: 'Zurich' }, currency: 'CHF', status: 'active', updatedAt: 1 }),
        op('event.upsert', { id: 'bern', name: 'Bern shop', kind: 'store', venue: { city: 'Bern' }, currency: 'CHF', status: 'active', updatedAt: 1 }),
        op('event.upsert', { id: 'fair', name: 'Secret fair', venue: {}, currency: 'CHF', status: 'active', updatedAt: 1 }),
        op('product.upsert', { id: 'sp1', title: 'Fox print', forSale: true, unlisted: false, price: 30, variants: [], consignorId: 'ana', consignorProductId: 'ap1', sortOrder: 0, updatedAt: 1 }),
        op('product.upsert', { id: 'mug', title: 'House mug', forSale: true, unlisted: false, price: 12, variants: [], sortOrder: 1, updatedAt: 1 }),
        op('inventory.set', { productId: 'sp1', variantId: '', onHand: 10, updatedAt: 0 }),
        sale('t1', 'zurich', [
          { pid: 'sp1', vid: null, title: 'Fox print', qty: 2, unitPrice: 30, lineTotal: 60, consignorId: 'ana' },
          { pid: 'mug', vid: null, title: 'House mug', qty: 1, unitPrice: 12, lineTotal: 12 },
        ]),
        sale('t2', 'bern', [{ pid: 'sp1', vid: null, title: 'Fox print', qty: 1, unitPrice: 30, lineTotal: 30, consignorId: 'ana' }]),
        sale('t3', 'bern', [{ pid: 'sp1', vid: null, title: 'Fox print', qty: 1, unitPrice: 30, lineTotal: 30, consignorId: 'ana' }]),
        op('tx.revert', { id: 't3', revertedAt: 99 }),
        sale('t4', 'fair', [{ pid: 'mug', vid: null, title: 'House mug', qty: 1, unitPrice: 12, lineTotal: 12 }]),
      ],
    },
  });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('consignment', () => {
  it('keeps artists per store, with a commission override for one of them', async () => {
    const res = await call(store, 'PUT', '/consignors/ana', {
      name: 'Ana',
      commissionPct: 40,
      storeCommission: { bern: 30 },
      storeIds: ['zurich', 'bern'],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().consignor).toMatchObject({ id: 'ana', storeIds: ['zurich', 'bern'], linked: false, linkPending: false });
    expect((await call(store, 'PUT', '/consignors/ben', { name: 'Ben', commissionPct: 101 })).statusCode).toBe(400);
  });

  it('adds up what each artist earned in each store, against payouts', async () => {
    expect((await call(store, 'POST', '/payouts', { consignorId: 'ana', amount: 20, currency: 'CHF', date: '2026-10-01' })).statusCode).toBe(201);
    const body = (await call(store, 'GET', '/statement')).json();
    const ana = body.statements.find((s: { consignorId: string }) => s.consignorId === 'ana');
    expect(ana.byStore).toEqual([
      { storeId: 'bern', currency: 'CHF', units: 1, gross: 30, commission: 9, artistShare: 21 },
      { storeId: 'zurich', currency: 'CHF', units: 2, gross: 60, commission: 24, artistShare: 36 },
    ]);
    expect(ana.totals).toEqual([{ currency: 'CHF', units: 3, gross: 90, commission: 33, artistShare: 57, paid: 20, rent: 0, fees: 0, cardFees: 0, balance: 37 }]);
  });

  it('links the artist account only with a live code, once', async () => {
    expect((await call(artist, 'POST', '/links', { code: 'NOPE0-NOPE0' })).statusCode).toBe(404);
    const { code } = (await call(store, 'POST', '/consignors/ana/link-code')).json();
    expect((await call(store, 'GET', '/consignors')).json().consignors[0].linkPending).toBe(true);

    // The owner cannot link the artist to their own store account.
    expect((await call(store, 'POST', '/links', { code })).statusCode).toBe(400);

    const linked = await call(artist, 'POST', '/links', { code: code.toLowerCase().replace('-', ' ') });
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toEqual({ storeAccountName: 'Owner', consignorName: 'Ana' });
    expect((await call(stranger, 'POST', '/links', { code })).statusCode).toBe(404);
    expect((await call(store, 'GET', '/consignors')).json().consignors[0]).toMatchObject({ linked: true, linkedAccountName: 'Ana Prints', linkPending: false });
  });

  it('shows the artist their items, sales and payouts - and nothing else of the store', async () => {
    const res = await call(artist, 'GET', '/links');
    const [link] = res.json().links as ArtistConsignment[];
    expect(link).toBeDefined();
    expect(link!.paused).toBe(false);
    expect(link!.currency).toBe('CHF');
    expect(link!.venues.map((v) => [v.id, v.kind, v.city])).toEqual([
      ['zurich', 'store', 'Zurich'],
      ['bern', 'store', 'Bern'],
    ]);
    expect(link!.items).toEqual([
      { productId: 'sp1', variantId: '', title: 'Fox print', price: 30, sourceProductId: 'ap1', onHand: 10, remaining: 7, sold: 3 },
    ]);
    expect(link!.lines.map((l) => l.txId).sort()).toEqual(['t1', 't2']);
    expect(link!.statement.totals[0]).toMatchObject({ artistShare: 57, paid: 20, balance: 37 });
    expect(JSON.stringify(res.json())).not.toMatch(/House mug|Secret fair/);

    expect((await call(stranger, 'GET', '/links')).json().links).toEqual([]);
  });

  it('lets the owner import from the linked catalogue without the artist\'s costs', async () => {
    const res = await call(store, 'GET', '/consignors/ana/catalog');
    expect(res.statusCode).toBe(200);
    expect(res.json().products).toEqual([{ id: 'ap1', title: 'Fox print', price: 30, variants: [] }]);
  });

  it('pauses sharing while the owner has the module off', async () => {
    const owner = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(store) })).json().user.accountId;
    setEnabled(app.zollify.db, owner, 'consignment', false);
    const [link] = (await call(artist, 'GET', '/links')).json().links as ArtistConsignment[];
    expect(link).toMatchObject({ paused: true, items: [], lines: [] });
    setEnabled(app.zollify.db, owner, 'consignment', true);
  });

  it('refuses to delete an artist with history, and lets the artist unlink', async () => {
    expect((await call(store, 'DELETE', '/consignors/ana')).statusCode).toBe(409);
    const owner = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(store) })).json().user.accountId;
    expect((await call(artist, 'DELETE', `/links/${owner}/ana`)).statusCode).toBe(200);
    expect((await call(artist, 'GET', '/links')).json().links).toEqual([]);
    expect((await call(store, 'GET', '/consignors/ana/catalog')).statusCode).toBe(409);
  });
});
