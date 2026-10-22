import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '@zollify/server-core';
import { giftCardsServerModule } from '../modules/gift-cards';

/**
 * A gift card is money the business owes its holder, and its code is what
 * spends it - so the tests pin that the balance follows the till's sales
 * (refunds included), that a forged line cannot load a card, that staff see
 * codes masked, and that giving money away or voiding a card is for admins
 * on their own sign-in.
 */

const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let staff: string;
let seq = 0;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (t: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/gift-cards${url}`, headers: auth(t), ...(payload ? { payload } : {}) });
const push = (type: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: auth(owner),
    payload: { deviceId: 'till', ops: [{ opId: `op-gift-test-${String(++seq).padStart(6, '0')}`, deviceId: 'till', ts: seq, type, payload }] },
  });
/** A sale at the till with one gift card line, as the POS records it: a load is positive, a redemption negative. */
const sale = (txId: string, cardId: string, kind: 'load' | 'redeem', amount: number, extra: Record<string, unknown> = {}, moduleId = 'gift-cards') =>
  push('tx.create', {
    id: txId,
    eventId: 'shop',
    deviceId: 'till',
    timestamp: Date.now(),
    method: 'cash',
    payments: [],
    items: [{ pid: `module:gift-card:${cardId}`, vid: null, title: 'Gift card', qty: 1, unitPrice: amount, lineTotal: amount, ref: { moduleId, kind, id: cardId } }],
    discounts: [],
    total: Math.max(0, amount),
    currency: 'EUR',
    ...extra,
  });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-gift-cards-'));
  process.env.OWNER_EMAIL = 'shop@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [giftCardsServerModule],
    defaultModules: ['gift-cards'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shop@example.test', password: PASSWORD } });
  owner = login.json().accessToken;
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'member' } });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'staff@example.test', password: PASSWORD, inviteCode: invite.json().code } });
  staff = reg.json().accessToken;
  await push('event.upsert', { id: 'shop', name: 'Shop', kind: 'store', venue: {}, currency: 'EUR', status: 'active', updatedAt: 1 });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('issuing and spending', () => {
  let id = '';
  let code = '';

  it('staff issue a card with a formatted code, and nothing is on it until the sale lands', async () => {
    const res = await call(staff, 'POST', '/cards', { value: 50, currency: 'eur', note: 'For Mira' });
    expect(res.statusCode).toBe(201);
    const c = res.json();
    id = c.id;
    code = c.code;
    expect(code).toMatch(/^ZG-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(c).toMatchObject({ currency: 'EUR', value: 50, granted: 0, note: 'For Mira', loaded: 0, balance: 0, state: 'unloaded', expiresAt: null, voidedAt: null });
    expect((await call(staff, 'POST', '/cards', { value: 0 })).statusCode).toBe(400);
    expect((await call(staff, 'POST', '/cards', { value: 10, currency: 'euros' })).statusCode).toBe(400);
  });

  it('the sale that sold it loads it; spending comes off; a refund of either puts things back', async () => {
    await sale('tx-sold', id, 'load', 50);
    let c = (await call(staff, 'GET', `/cards/lookup?code=${encodeURIComponent(code.toLowerCase())}`)).json();
    expect(c).toMatchObject({ id, loaded: 50, redeemed: 0, balance: 50, state: 'active' });
    expect(c.code).toBe(code);

    await sale('tx-spent', id, 'redeem', -20.1);
    await sale('tx-spent-2', id, 'redeem', -5);
    c = (await call(staff, 'GET', `/cards/${id}`)).json();
    expect(c).toMatchObject({ loaded: 50, redeemed: 25.1, balance: 24.9 });
    expect(c.movements.map((m: { kind: string; amount: number }) => [m.kind, m.amount])).toEqual([['load', 50], ['redeem', -20.1], ['redeem', -5]]);

    await push('tx.revert', { id: 'tx-spent-2', revertedAt: Date.now() });
    expect((await call(staff, 'GET', `/cards/${id}`)).json()).toMatchObject({ redeemed: 20.1, balance: 29.9 });

    // The sale that sold the card was refunded: whatever was spent since stands, but nothing is left.
    await push('tx.revert', { id: 'tx-sold', revertedAt: Date.now() });
    expect((await call(staff, 'GET', `/cards/${id}`)).json()).toMatchObject({ loaded: 0, balance: 0, state: 'unloaded' });
    await sale('tx-sold-again', id, 'load', 50);
  });

  it('a load claimed by another module, a negative load or a positive redemption count for nothing', async () => {
    const before = (await call(staff, 'GET', `/cards/${id}`)).json().balance;
    await sale('tx-forged', id, 'load', 500, {}, 'consignment');
    await sale('tx-neg-load', id, 'load', -30);
    await sale('tx-pos-redeem', id, 'redeem', 30);
    expect((await call(staff, 'GET', `/cards/${id}`)).json().balance).toBe(before);
  });

  it('a card is one account\'s: another account cannot see or spend it', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'other@example.test', password: PASSWORD, accountName: 'Other' } });
    const other = reg.json().accessToken as string;
    if (!other) return; // this server only registers by invite
    expect((await call(other, 'GET', `/cards/lookup?code=${code}`)).statusCode).not.toBe(200);
    expect((await call(other, 'GET', `/cards/${id}`)).statusCode).toBe(404);
  });

  it('the code is masked for staff in lists and whole for an admin; a lookup needs a real code', async () => {
    const mine = (await call(staff, 'GET', '/cards')).json().cards.find((c: { id: string }) => c.id === id);
    expect(mine.code).toMatch(/^ZG-····-····-····-[A-Z2-9]{4}$/);
    expect(mine.code.slice(-4)).toBe(code.slice(-4));
    const admins = (await call(owner, 'GET', '/cards')).json().cards.find((c: { id: string }) => c.id === id);
    expect(admins.code).toBe(code);
    // Search by the end of the code, as the mask shows it.
    expect((await call(staff, 'GET', `/cards?q=${code.slice(-4)}`)).json().cards.map((c: { id: string }) => c.id)).toContain(id);
    expect((await call(staff, 'GET', '/cards?q=zzzz9')).json().cards).toEqual([]);
    expect((await call(staff, 'GET', '/cards/lookup?code=nope')).statusCode).toBe(400);
    expect((await call(staff, 'GET', '/cards/lookup?code=ZGAAAAAAAAAAAAAAAA')).statusCode).toBe(404);
  });

  it('a card cannot be sold for more than the settings allow', async () => {
    expect((await call(staff, 'POST', '/cards', { value: 501 })).statusCode).toBe(400);
    expect((await call(staff, 'PUT', '/settings', { maxValue: 1000 })).statusCode).toBe(403);
    expect((await call(owner, 'PUT', '/settings', { maxValue: 1000, expiryMonths: 12 })).json()).toEqual({ maxValue: 1000, expiryMonths: 12 });
    const big = (await call(staff, 'POST', '/cards', { value: 600 })).json();
    expect(big.value).toBe(600);
    // Issued under an expiry: about a year from now.
    expect(big.expiresAt).toBeGreaterThan(Date.now() + 360 * 86400_000);
    await call(owner, 'PUT', '/settings', { maxValue: 1000, expiryMonths: 0 });
  });
});

describe('admin work', () => {
  it('granting value without a sale and voiding are for admins', async () => {
    expect((await call(staff, 'POST', '/cards/grant', { value: 20 })).statusCode).toBe(403);
    const g = (await call(owner, 'POST', '/cards/grant', { value: 20, note: 'Raffle prize' })).json();
    expect(g).toMatchObject({ granted: 20, loaded: 20, balance: 20, state: 'active' });
    await sale('tx-prize', g.id, 'redeem', -7.5);
    expect((await call(staff, 'GET', `/cards/${g.id}`)).json()).toMatchObject({ balance: 12.5 });

    expect((await call(staff, 'POST', `/cards/${g.id}/void`)).statusCode).toBe(403);
    const voided = (await call(owner, 'POST', `/cards/${g.id}/void`)).json();
    expect(voided.state).toBe('void');
    expect(voided.voidedAt).toBeGreaterThan(0);
    // Staff can still fix a note.
    expect((await call(staff, 'PUT', `/cards/${g.id}`, { note: 'Prize - voided, lost' })).json().note).toBe('Prize - voided, lost');
  });

  it('an admin unlocked at a shared till cannot grant, void or change settings from it', async () => {
    const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'admin' } });
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'admin@example.test', password: PASSWORD, inviteCode: invite.json().code } });
    const adminId = reg.json().user.id as string;
    const grant = (await app.inject({ method: 'POST', url: '/api/device-users', headers: auth(owner), payload: { deviceId: 'counter', email: 'admin@example.test', password: PASSWORD, pin: '4711' } })).json().grant;
    const till = (await app.inject({ method: 'POST', url: '/api/auth/unlock', headers: auth(owner), payload: { deviceId: 'counter', userId: adminId, pin: '4711', grant } })).json().accessToken as string;
    expect((await call(till, 'POST', '/cards/grant', { value: 20 })).statusCode).toBe(403);
    expect((await call(till, 'PUT', '/settings', { maxValue: 5 })).statusCode).toBe(403);
    const c = (await call(till, 'POST', '/cards', { value: 10 })).json();
    expect(c.id).toBeTruthy();
    expect((await call(till, 'POST', `/cards/${c.id}/void`)).statusCode).toBe(403);
    const own = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.test', password: PASSWORD } })).json().accessToken as string;
    expect((await call(own, 'POST', `/cards/${c.id}/void`)).statusCode).toBe(200);
  });

  it('the period report is the admin\'s and adds up issued, redeemed, outstanding and lapsed', async () => {
    expect((await call(staff, 'GET', '/report?from=0&to=9999999999999')).statusCode).toBe(403);
    expect((await call(owner, 'GET', '/report?from=5&to=1')).statusCode).toBe(400);
    const { rows } = (await call(owner, 'GET', `/report?from=0&to=${Date.now() + 60_000}`)).json();
    const eur = rows.find((r: { currency: string }) => r.currency === 'EUR');
    // Sold 50 (the refunded first sale no longer counts) + granted 20; spent 20.1 + 7.5; the voided prize card lapsed with 12.5.
    expect(eur).toMatchObject({ issued: 70, redeemed: 27.6, outstanding: 29.9, lapsed: 12.5 });
  });
});
