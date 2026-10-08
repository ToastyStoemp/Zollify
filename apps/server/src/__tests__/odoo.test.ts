import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGateway } from '@zollify/server-core';
import { odooServerModule } from '../modules/odoo';

/**
 * Odoo sync against a pretend Odoo: a sale at the till lowers Odoo's quantity
 * on hand and is invoiced there; a change in Odoo comes back as a fresh count
 * on the next sync; a reverted sale gets a credit note; nothing is written
 * twice.
 */

const PASSWORD = 'correct horse battery staple';
const ODOO = 'https://odoo.test';

// ── A small Odoo ─────────────────────────────────────────────────────────────
interface Quant { id: number; product_id: number; location_id: number; quantity: number; inventory_quantity?: number }
const odoo = {
  products: [
    { id: 101, name: 'Fox print', display_name: '[FOX] Fox print', default_code: 'FOX', barcode: false, lst_price: 100, product_tmpl_id: [11, 'Fox print'] as [number, string], active: true },
    { id: 102, name: 'Owl mug', display_name: '[OWL] Owl mug', default_code: 'OWL', barcode: false, lst_price: 20, product_tmpl_id: [12, 'Owl mug'] as [number, string], active: true },
  ],
  quants: [{ id: 1, product_id: 101, location_id: 8, quantity: 5 }] as Quant[],
  moves: [] as Record<string, unknown>[],
  partners: [] as { id: number; name: string }[],
  calls: [] as string[],
  nextId: 500,
};
const qtyOf = (productId: number, locationId: number): number => odoo.quants.filter((q) => q.product_id === productId && q.location_id === locationId).reduce((s, q) => s + q.quantity, 0);

function execute(model: string, method: string, args: unknown[], kwargs: Record<string, unknown>): unknown {
  odoo.calls.push(`${model}.${method}`);
  const ctx = (kwargs.context ?? {}) as Record<string, unknown>;
  switch (`${model}.${method}`) {
    case 'product.product.search_read':
      return odoo.products.map((p) => ({ ...p, qty_available: qtyOf(p.id, 8) }));
    case 'product.product.read': {
      const [ids] = args as [number[]];
      return ids.map((id) => ({ id, qty_available: qtyOf(id, Number(ctx.location)) }));
    }
    case 'stock.location.search_read':
      return [{ id: 8, complete_name: 'WH/Stock', warehouse_id: [1, 'WH'] }];
    case 'account.journal.search_read':
      return [{ id: 3, name: 'Customer Invoices' }];
    case 'stock.quant.search_read': {
      const [domain] = args as [[string, string, unknown][]];
      const product = domain.find((d) => d[0] === 'product_id')![2];
      const location = domain.find((d) => d[0] === 'location_id')![2];
      return odoo.quants.filter((q) => q.product_id === product && q.location_id === location).map((q) => ({ id: q.id }));
    }
    case 'stock.quant.write': {
      const [ids, vals] = args as [number[], { inventory_quantity: number }];
      for (const q of odoo.quants) if (ids.includes(q.id)) q.inventory_quantity = vals.inventory_quantity;
      return true;
    }
    case 'stock.quant.create': {
      const [vals] = args as [{ product_id: number; location_id: number; inventory_quantity: number }];
      const q: Quant = { id: ++odoo.nextId, product_id: vals.product_id, location_id: vals.location_id, quantity: 0, inventory_quantity: vals.inventory_quantity };
      odoo.quants.push(q);
      return q.id;
    }
    case 'stock.quant.action_apply_inventory': {
      const [ids] = args as [number[]];
      for (const q of odoo.quants) if (ids.includes(q.id) && q.inventory_quantity !== undefined) q.quantity = q.inventory_quantity;
      return true;
    }
    case 'res.partner.search_read':
      return odoo.partners.map((p) => ({ id: p.id }));
    case 'res.partner.create': {
      const [vals] = args as [{ name: string }];
      const p = { id: ++odoo.nextId, name: vals.name };
      odoo.partners.push(p);
      return p.id;
    }
    case 'res.currency.search_read':
      return [{ id: 1 }];
    case 'account.move.create': {
      const [vals] = args as [Record<string, unknown>];
      const m = { id: ++odoo.nextId, state: 'draft', ...vals };
      odoo.moves.push(m);
      return m.id;
    }
    case 'account.move.action_post': {
      const [ids] = args as [number[]];
      for (const m of odoo.moves) if (ids.includes(m.id as number)) m.state = 'posted';
      return true;
    }
    case 'account.move.search_read':
      return [];
    case 'account.move.reversal.create':
      return 900;
    case 'account.move.reversal.reverse_moves': {
      const original = (ctx.active_ids as number[])[0]!;
      const m = { id: ++odoo.nextId, state: 'draft', move_type: 'out_refund', reversed_entry_id: original };
      odoo.moves.push(m);
      return { res_id: m.id };
    }
  }
  throw new Error(`pretend Odoo has no ${model}.${method}`);
}

const realFetch = globalThis.fetch;
const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url) !== `${ODOO}/jsonrpc`) return realFetch(url, init);
  const { id, params } = JSON.parse(String(init?.body)) as { id: number; params: { service: string; method: string; args: unknown[] } };
  const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
  const fail = (message: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { message: 'Odoo Server Error', data: { message } } }), { status: 200 });
  try {
    if (params.service === 'common' && params.method === 'authenticate') return reply(params.args[2] === 'key-ok-123' ? 2 : false);
    if (params.service === 'common' && params.method === 'version') return reply({ server_version: '17.0' });
    const [, , key, model, method, args, kwargs] = params.args as [string, number, string, string, string, unknown[], Record<string, unknown>];
    if (key !== 'key-ok-123') return fail('Access Denied');
    return reply(execute(model, method, args, kwargs ?? {}));
  } catch (err) {
    return fail((err as Error).message);
  }
});

// ── Zollify ──────────────────────────────────────────────────────────────────
let app: FastifyInstance;
let dataDir: string;
let token: string;
let accountId: string;
const auth = () => ({ authorization: `Bearer ${token}` });
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) => app.inject({ method, url: `/api/m/odoo-sync${url}`, headers: auth(), ...(payload !== undefined ? { payload } : {}) });
let n = 0;
const push = (ops: { type: string; payload: unknown; opId?: string }[]) =>
  app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(), payload: { deviceId: 'dev', ops: ops.map((o) => ({ opId: o.opId ?? `op-odoo-${String(++n).padStart(10, '0')}`, deviceId: 'dev', ts: n, type: o.type, payload: o.payload })) } });
/** onOps runs after the push answers; wait for the pretend Odoo to see it. */
const settle = async (until: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !until(); i++) await new Promise((r) => setTimeout(r, 20));
};
const SETTINGS = { url: ODOO, db: 'shop', login: 'owner@shop.test', apiKey: 'key-ok-123', locationId: 8, syncStock: true, invoiceSales: true, journalId: null, partnerId: null };

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-odoo-'));
  process.env.OWNER_EMAIL = 'shop@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  vi.stubGlobal('fetch', fakeFetch);
  app = await buildGateway({ dataDir, moduleStoreDir: join(dataDir, 'modules'), jwtSecret: 'test-secret-value-long-enough-for-signing', serverModules: [odooServerModule('test-secret-value-long-enough-for-signing')], defaultModules: ['odoo-sync'], allowedOrigins: [], requireHttps: false, trustProxy: false, logLevel: 'silent' });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shop@example.test', password: PASSWORD } });
  token = login.json().accessToken;
  accountId = login.json().user.accountId;
  await push([
    { type: 'event.upsert', payload: { id: 'shop', name: 'Shop', kind: 'store', venue: {}, currency: 'EUR', status: 'active', updatedAt: 1 } },
    { type: 'product.upsert', payload: { id: 'p1', title: 'Fox print', sku: 'FOX', forSale: true, unlisted: false, price: 100, variants: [], sortOrder: 0, updatedAt: 1 } },
    { type: 'product.upsert', payload: { id: 'p2', title: 'Owl cup', forSale: true, unlisted: false, price: 20, variants: [], sortOrder: 0, updatedAt: 1 } },
    { type: 'inventory.set', payload: { productId: 'p1', variantId: '', onHand: 5, updatedAt: 1000 } },
  ]);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('connecting', () => {
  it('refuses a key Odoo does not accept, and keeps a working one', async () => {
    const bad = await call('POST', '/connection', { ...SETTINGS, apiKey: 'wrong-key-1' });
    expect([bad.statusCode, bad.json()]).toEqual([401, expect.anything()]);
    const ok = await call('POST', '/connection', SETTINGS);
    expect([ok.statusCode, ok.json()]).toEqual([200, expect.anything()]);
    expect(ok.json()).toMatchObject({ connected: true, url: ODOO, locationId: 8 });
    expect(ok.body).not.toContain('key-ok-123');
    expect((await call('GET', '/choices')).json()).toMatchObject({ version: '17.0', locations: [{ id: 8, name: 'WH/Stock', warehouse: 'WH' }], journals: [{ id: 3 }] });
  });
});

describe('matching', () => {
  it('matches by SKU and saves what is confirmed', async () => {
    const products = [
      { id: 'p1', title: 'Fox print', sku: 'FOX', price: 100, variants: [], updatedAt: 1 },
      { id: 'p2', title: 'Owl cup', price: 20, variants: [], updatedAt: 1 },
    ];
    const res = await call('POST', '/match', { products });
    const fox = res.json().matches.find((m: { zt: { id: string } }) => m.zt.id === 'p1');
    expect(fox.variants[0]).toMatchObject({ kind: 'sku', shop: { variantId: '101', productTitle: 'Fox print' } });
    const owl = res.json().matches.find((m: { zt: { id: string } }) => m.zt.id === 'p2');
    expect(['fuzzy', 'none']).toContain(owl.variants[0].kind);
    await call('POST', '/matches/save', { matches: { p1: { shopProductId: '11', variants: { '': { productId: '11', variantId: '101' } } } } });
    expect((await call('GET', '/matches')).json().saved.p1.variants[''].variantId).toBe('101');
  });
});

describe('stock', () => {
  it('a first sync with both sides equal agrees without moving anything', async () => {
    expect((await call('POST', '/sync')).json()).toEqual({ pushed: 0, pulled: 0 });
    expect(qtyOf(101, 8)).toBe(5);
  });

  it('a sale at the till lowers the quantity on hand in Odoo and is invoiced there', async () => {
    odoo.calls.length = 0;
    await push([{ type: 'tx.create', payload: { id: 'sale-1', eventId: 'shop', deviceId: 'dev', timestamp: 2000, method: 'cash', payments: [{ kind: 'cash', amount: 200 }], items: [{ pid: 'p1', vid: null, title: 'Fox print', qty: 2, unitPrice: 100, lineTotal: 200 }], discounts: [], total: 200, currency: 'EUR' } }]);
    await settle(() => qtyOf(101, 8) === 3 && odoo.moves.some((m) => m.state === 'posted'));
    expect(qtyOf(101, 8)).toBe(3);
    const invoice = odoo.moves.find((m) => m.move_type === 'out_invoice')!;
    expect(invoice).toMatchObject({ state: 'posted', ref: 'Zollify sale sale-1', invoice_date: '1970-01-01', currency_id: 1 });
    expect(invoice.invoice_line_ids).toEqual([[0, 0, { product_id: 101, name: 'Fox print', quantity: 2, price_unit: 100 }]]);
    expect(odoo.partners).toEqual([{ id: expect.any(Number), name: 'Zollify till sales' }]);
    expect((await call('GET', '/connection')).json().partnerId).toBe(odoo.partners[0]!.id);
  });

  it('the same sale pushed again is not invoiced twice', async () => {
    const before = odoo.moves.length;
    await push([{ type: 'tx.create', opId: 'op-odoo-0000000005', payload: { id: 'sale-1', eventId: 'shop', deviceId: 'dev', timestamp: 2000, method: 'cash', payments: [], items: [{ pid: 'p1', vid: null, title: 'Fox print', qty: 2, unitPrice: 100, lineTotal: 200 }], discounts: [], total: 200, currency: 'EUR' } }]);
    await new Promise((r) => setTimeout(r, 100));
    expect(odoo.moves.length).toBe(before);
  });

  it('a change in Odoo comes back as a fresh count on the next sync', async () => {
    odoo.quants[0]!.quantity = 1; // two sold on the web shop
    expect((await call('POST', '/sync')).json()).toEqual({ pushed: 0, pulled: 1 });
    const counts = app.zollify.db.prepare("SELECT payload FROM ops WHERE accountId = ? AND type = 'inventory.set' ORDER BY seq DESC LIMIT 1").get(accountId) as { payload: string };
    expect(JSON.parse(counts.payload)).toMatchObject({ productId: 'p1', variantId: '', onHand: 1 });
    // Nothing more to do: both sides now agree on 1.
    expect((await call('POST', '/sync')).json()).toEqual({ pushed: 0, pulled: 0 });
  });

  it('a recount here goes to Odoo', async () => {
    await push([{ type: 'inventory.set', payload: { productId: 'p1', variantId: '', onHand: 9, updatedAt: Date.now() } }]);
    await settle(() => qtyOf(101, 8) === 9);
    expect(qtyOf(101, 8)).toBe(9);
  });

  it('a reverted sale gets a credit note', async () => {
    await push([{ type: 'tx.revert', payload: { txId: 'sale-1', revertedAt: Date.now() } }]);
    await settle(() => odoo.moves.some((m) => m.move_type === 'out_refund'));
    const note = odoo.moves.find((m) => m.move_type === 'out_refund')!;
    expect(note).toMatchObject({ state: 'posted', reversed_entry_id: odoo.moves[0]!.id });
    expect((await call('GET', '/status')).json()).toMatchObject({ matched: 1, invoices: 1, creditNotes: 1 });
  });

  it('an Odoo that is down is reported, not fatal, and the next sync catches up', async () => {
    odoo.quants[0]!.quantity = 4; // sold on the web while Odoo was unreachable from here
    vi.mocked(fakeFetch).mockImplementationOnce(async () => new Response('', { status: 503 }));
    expect((await call('POST', '/sync')).json()).toEqual({ pushed: 0, pulled: 0 });
    const log = (await call('GET', '/status')).json().log as { kind: string; message: string }[];
    expect(log.find((l) => l.kind === 'error')?.message).toMatch(/Odoo HTTP 503/);
    expect((await call('POST', '/sync')).json()).toEqual({ pushed: 0, pulled: 1 });
  });

  it('disconnecting forgets everything here and touches nothing there', async () => {
    const moves = odoo.moves.length;
    expect((await call('DELETE', '/connection')).json()).toEqual({ connected: false });
    expect((await call('GET', '/connection')).json()).toEqual({ connected: false });
    expect((await call('GET', '/status')).json()).toMatchObject({ matched: 0, levels: 0, invoices: 0 });
    expect(odoo.moves.length).toBe(moves);
  });
});
