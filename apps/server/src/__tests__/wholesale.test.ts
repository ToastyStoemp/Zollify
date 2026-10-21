import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '@zollify/server-core';
import { wholesaleServerModule } from '../modules/wholesale';

const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let staff: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (t: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/wholesale${url}`, headers: auth(t), ...(payload ? { payload } : {}) });
const line = (productId: string, qty: number, unitPrice: number) => ({ productId, variantId: null, title: productId, qty, unitPrice });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-wholesale-'));
  process.env.OWNER_EMAIL = 'shop@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({ dataDir, moduleStoreDir: join(dataDir, 'modules'), jwtSecret: 'test-secret-value-long-enough-for-signing', serverModules: [wholesaleServerModule], defaultModules: ['wholesale'], allowedOrigins: [], requireHttps: false, trustProxy: false, logLevel: 'silent' });
  await app.ready();
  owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shop@example.test', password: PASSWORD } })).json().accessToken;
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'member' } });
  staff = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'staff@example.test', password: PASSWORD, inviteCode: invite.json().code } })).json().accessToken;
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('wholesale', () => {
  let customerId = '';
  let orderId = '';

  it('is the admin\'s: staff get nothing', async () => {
    expect((await call(staff, 'GET', '/orders')).statusCode).toBe(403);
  });

  it('keeps trade details per product, tiers sorted and distinct', async () => {
    const res = await call(owner, 'PUT', '/products/pin', { tiers: [{ minQty: 50, price: 6.5 }, { minQty: 10, price: 8 }], moq: 10, packSize: 5, leadDays: 3, materials: 'Zinc alloy' });
    expect(res.statusCode).toBe(200);
    expect(res.json().details.tiers).toEqual([{ minQty: 10, price: 8 }, { minQty: 50, price: 6.5 }]);
    expect((await call(owner, 'PUT', '/products/pin', { tiers: [{ minQty: 10, price: 8 }, { minQty: 10, price: 7 }] })).statusCode).toBe(400);
    expect((await call(owner, 'GET', '/products')).json().details.pin).toMatchObject({ moq: 10, packSize: 5, leadDays: 3 });
  });

  it('keeps customers', async () => {
    expect((await call(owner, 'POST', '/customers', { company: '' })).statusCode).toBe(400);
    const res = await call(owner, 'POST', '/customers', { company: 'Plush & Co', email: 'buy@plush.test', country: 'be', discountPct: 10, terms: '30 days net' });
    expect(res.statusCode).toBe(201);
    customerId = res.json().customer.id;
    expect(res.json().customer).toMatchObject({ country: 'BE', currency: 'EUR', discountPct: 10 });
    expect((await call(owner, 'PUT', `/customers/${customerId}`, { company: 'Plush & Co bvba', discountPct: 12 })).json().customer.discountPct).toBe(12);
    expect((await call(owner, 'GET', '/customers')).json().customers).toHaveLength(1);
  });

  it('numbers orders, moves them along, reserves while open, and takes the sale id on shipping', async () => {
    const made = await call(owner, 'POST', '/orders', { customerId, lines: [line('pin', 20, 7.04)], note: 'PO 4711' });
    expect(made.statusCode).toBe(201);
    orderId = made.json().order.id;
    expect(made.json().order).toMatchObject({ number: 1, status: 'draft', confirmedAt: null, saleId: null });
    expect((await call(owner, 'POST', '/orders', { customerId: 'nope', lines: [] })).statusCode).toBe(400);
    const second = (await call(owner, 'POST', '/orders', { customerId, lines: [] })).json().order;
    expect(second.number).toBe(2);
    // A draft reserves nothing; a confirmed one does, and its ship date follows the lead time.
    expect((await call(owner, 'GET', '/orders')).json().reserved).toEqual({});
    expect((await call(owner, 'POST', `/orders/${second.id}/status`, { status: 'confirmed' })).statusCode).toBe(409);
    const confirmed = (await call(owner, 'POST', `/orders/${orderId}/status`, { status: 'confirmed' })).json().order;
    expect(confirmed.confirmedAt).toBeGreaterThan(0);
    expect(confirmed.expectedShipDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(confirmed.expectedShipDate > new Date().toISOString().slice(0, 10)).toBe(true);
    expect((await call(owner, 'GET', '/orders')).json().reserved).toEqual({ 'pin:': 20 });
    // Lines can still change while confirmed, not once packed.
    expect((await call(owner, 'PUT', `/orders/${orderId}`, { customerId, lines: [line('pin', 25, 7.04)] })).json().order.lines[0].qty).toBe(25);
    await call(owner, 'POST', `/orders/${orderId}/status`, { status: 'packed' });
    expect((await call(owner, 'PUT', `/orders/${orderId}`, { customerId, lines: [line('pin', 30, 7.04)] })).statusCode).toBe(409);
    expect((await call(owner, 'POST', `/orders/${orderId}/status`, { status: 'draft' })).statusCode).toBe(409);
    const shipped = (await call(owner, 'POST', `/orders/${orderId}/status`, { status: 'shipped', saleId: 'tx-ship' })).json().order;
    expect(shipped).toMatchObject({ status: 'shipped', saleId: 'tx-ship' });
    expect(shipped.shippedAt).toBeGreaterThan(0);
    expect((await call(owner, 'GET', '/orders')).json().reserved).toEqual({});
    expect((await call(owner, 'DELETE', `/orders/${orderId}`)).statusCode).toBe(409);
    expect((await call(owner, 'DELETE', `/orders/${second.id}`)).json()).toEqual({ ok: true });
  });

  it('a customer with orders is archived, not deleted', async () => {
    expect((await call(owner, 'DELETE', `/customers/${customerId}`)).statusCode).toBe(409);
    const other = (await call(owner, 'POST', '/customers', { company: 'One-off' })).json().customer;
    expect((await call(owner, 'DELETE', `/customers/${other.id}`)).json()).toEqual({ ok: true });
  });
});
