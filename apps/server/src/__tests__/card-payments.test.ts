import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '@zollify/server-core';
import { taxServerModule } from '../modules/tax/index';

/**
 * Card payments the phone saw (Google Wallet notifications): kept by last four digits, hidden
 * once a card is marked personal, quick-added as an expense, and open to staff to record.
 */

const SECRET = 'test-secret-value-long-enough-for-signing';
const PASSWORD = 'correct horse battery staple';
const OWNER = 'owner@example.test';
const M = '/api/m/tax';
let app: FastifyInstance;
let dataDir: string;
let owner = '';
let staff = '';
const as = (t: string) => ({ authorization: `Bearer ${t}` });
const pay = (id: string, last4: string, amount = 12.5, merchant = 'Bäckerei Stern') => ({ id, at: Date.UTC(2026, 2, 7, 10), amount, currency: 'EUR', merchant, last4 });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-cards-'));
  process.env.OWNER_EMAIL = OWNER;
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: SECRET,
    serverModules: [taxServerModule(SECRET)],
    defaultModules: ['tax'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER, password: PASSWORD, deviceName: 'Test' } })).json().accessToken;
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: as(owner), payload: { role: 'member' } });
  staff = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'helper@example.test', password: PASSWORD, inviteCode: invite.json().code } })).json().accessToken;
  await app.inject({ method: 'POST', url: '/api/sync/push', headers: as(owner), payload: { deviceId: 'dev-1', ops: [{ opId: 'ev'.padEnd(16, '0'), deviceId: 'dev-1', ts: 1, type: 'event.upsert', payload: { id: 'ev-1', name: 'Leipzig Con', dateStart: '2026-03-07', dateEnd: '2026-03-08', venue: { country: 'Germany' }, currency: 'EUR', status: 'closed', updatedAt: 1 } }] } });
});

afterAll(async () => {
  try {
    app.zollify?.db?.close();
  } catch {
    /* closed */
  }
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('card payments from the phone', () => {
  it('stores a payment once, by the phone\'s own id, for staff and owner alike', async () => {
    const first = await app.inject({ method: 'POST', url: `${M}/card-payments`, headers: as(staff), payload: pay('wallet-0001', '4242') });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ stored: true, duplicate: false });
    const again = await app.inject({ method: 'POST', url: `${M}/card-payments`, headers: as(staff), payload: pay('wallet-0001', '4242') });
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicate).toBe(true);
    const list = (await app.inject({ method: 'GET', url: `${M}/card-payments`, headers: as(staff) })).json().payments;
    expect(list).toEqual([expect.objectContaining({ id: 'wallet-0001', amount: 12.5, currency: 'EUR', merchant: 'Bäckerei Stern', last4: '4242', addedExpenseId: null })]);
  });

  it('keeps a card the phone named, unmarked until the owner says what it is', async () => {
    expect((await app.inject({ method: 'GET', url: `${M}/cards`, headers: as(staff) })).json().cards).toEqual([{ last4: '4242', role: null, label: '' }]);
    expect((await app.inject({ method: 'PUT', url: `${M}/cards/4242`, headers: as(owner), payload: { role: 'business', label: 'Ink Booth Visa' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${M}/cards`, headers: as(staff) })).json().cards).toEqual([{ last4: '4242', role: 'business', label: 'Ink Booth Visa' }]);
  });

  it('quick-adds a payment as an expense on the event, once it is paid by card', async () => {
    const add = await app.inject({ method: 'POST', url: `${M}/card-payments/wallet-0001/add`, headers: as(staff), payload: { eventId: 'ev-1', category: 'food', note: 'snacks' } });
    expect(add.statusCode).toBe(201);
    const expense = add.json().expense;
    expect(expense).toMatchObject({ eventId: 'ev-1', category: 'food', amount: 12.5, currency: 'EUR', date: '2026-03-07', vendor: 'Bäckerei Stern', note: 'snacks' });
    expect(expense.createdBy).toMatchObject({ email: 'helper@example.test' });
    const list = (await app.inject({ method: 'GET', url: `${M}/card-payments`, headers: as(staff) })).json().payments;
    expect(list[0]).toMatchObject({ id: 'wallet-0001', addedExpenseId: expense.id });
    // The same payment can be added again, as a second expense: quick add from the history.
    expect((await app.inject({ method: 'POST', url: `${M}/card-payments/wallet-0001/add`, headers: as(staff), payload: { eventId: 'ev-1', category: 'food' } })).statusCode).toBe(201);
  });

  it('hides a personal card, and drops what it would have sent', async () => {
    expect((await app.inject({ method: 'POST', url: `${M}/card-payments`, headers: as(staff), payload: pay('wallet-0002', '9999', 40, 'Lidl') })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `${M}/card-payments`, headers: as(staff), payload: pay('wallet-0003', '9999', 9, 'Kino') })).statusCode).toBe(201);
    expect((await app.inject({ method: 'PUT', url: `${M}/cards/9999`, headers: as(owner), payload: { role: 'personal' } })).statusCode).toBe(200);

    const list = (await app.inject({ method: 'GET', url: `${M}/card-payments`, headers: as(owner) })).json().payments;
    expect(list.map((p: { id: string }) => p.id)).toEqual(['wallet-0001']);
    expect(app.zollify.db.prepare("SELECT COUNT(*) AS n FROM tax_card_payments WHERE accountId IS NOT NULL AND last4 = '9999'").get()).toEqual({ n: 0 });

    // A payment that arrives for a personal card is refused, not stored.
    const late = await app.inject({ method: 'POST', url: `${M}/card-payments`, headers: as(staff), payload: pay('wallet-0004', '9999', 3, 'Bus') });
    expect(late.json()).toEqual({ stored: false, duplicate: false });
    // And cannot be added as an expense.
    expect((await app.inject({ method: 'POST', url: `${M}/card-payments/wallet-0002/add`, headers: as(staff), payload: { eventId: 'ev-1', category: 'food' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `${M}/cards`, headers: as(staff) })).json().cards.map((c: { last4: string }) => c.last4)).toEqual(['4242', '9999']);
  });

  it('dismissing a payment takes it off the list without touching the expenses', async () => {
    expect((await app.inject({ method: 'POST', url: `${M}/card-payments`, headers: as(staff), payload: pay('wallet-0005', '4242', 7, 'Tankstelle') })).statusCode).toBe(201);
    expect((await app.inject({ method: 'DELETE', url: `${M}/card-payments/wallet-0005`, headers: as(staff) })).statusCode).toBe(200);
    const ids = (await app.inject({ method: 'GET', url: `${M}/card-payments`, headers: as(owner) })).json().payments.map((p: { id: string }) => p.id);
    expect(ids).not.toContain('wallet-0005');
    expect((await app.inject({ method: 'POST', url: `${M}/card-payments/wallet-0005/add`, headers: as(staff), payload: { eventId: 'ev-1', category: 'food' } })).statusCode).toBe(404);
  });

  it('keeps staff out of marking cards, and checks the input', async () => {
    expect((await app.inject({ method: 'PUT', url: `${M}/cards/4242`, headers: as(staff), payload: { role: 'personal' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `${M}/cards/42`, headers: as(owner), payload: { role: 'business' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${M}/card-payments`, headers: as(staff), payload: { ...pay('wallet-0006', '4242'), last4: 'abcd' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${M}/card-payments`, headers: as(staff), payload: { ...pay('wallet-0007', '4242'), amount: -3 } })).statusCode).toBe(400);
  });
});
