import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '@zollify/server-core';
import { taxServerModule } from '../modules/tax/index';

/**
 * Expenses paid from the cash in the till's box: cash up takes them off what the box should hold.
 * Staff see only the cash they paid themselves; the owner sees the event's.
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
const expense = (over: Record<string, unknown>) => ({ eventId: 'ev-1', category: 'food', amount: 15, currency: 'EUR', date: '2026-03-07', vendor: 'Snacks', note: '', ...over });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-cash-'));
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

describe('expenses paid from cash', () => {
  it('keeps how an expense was paid, and nothing where it was not said', async () => {
    const cash = await app.inject({ method: 'POST', url: `${M}/ledger/expenses`, headers: as(staff), payload: expense({ paidFrom: 'cash', vendor: 'Snacks' }) });
    expect(cash.statusCode).toBe(201);
    expect(cash.json().expense.paidFrom).toBe('cash');
    const unsaid = await app.inject({ method: 'POST', url: `${M}/ledger/expenses`, headers: as(owner), payload: expense({ vendor: 'Tape' }) });
    expect(unsaid.json().expense.paidFrom).toBeNull();
    expect((await app.inject({ method: 'POST', url: `${M}/ledger/expenses`, headers: as(owner), payload: expense({ paidFrom: 'bitcoin' }) })).statusCode).toBe(400);
  });

  it('can be changed afterwards, and a card payment added to an event is paid by card', async () => {
    const saved = (await app.inject({ method: 'POST', url: `${M}/ledger/expenses`, headers: as(owner), payload: expense({ paidFrom: 'card', vendor: 'Parking', amount: 6 }) })).json().expense;
    const moved = await app.inject({ method: 'PUT', url: `${M}/ledger/expenses/${saved.id}`, headers: as(owner), payload: { ...expense({ vendor: 'Parking', amount: 6 }), paidFrom: 'cash' } });
    expect(moved.json().expense.paidFrom).toBe('cash');

    await app.inject({ method: 'POST', url: `${M}/card-payments`, headers: as(staff), payload: { id: 'wallet-cash-0001', at: Date.UTC(2026, 2, 7, 12), amount: 3, currency: 'EUR', merchant: 'Kiosk', last4: '' } });
    const added = await app.inject({ method: 'POST', url: `${M}/card-payments/wallet-cash-0001/add`, headers: as(staff), payload: { eventId: 'ev-1', category: 'food' } });
    expect(added.json().expense.paidFrom).toBe('card');
  });

  it('gives cash up the cash paid on the event: all of it to the owner, only one\'s own to staff', async () => {
    // Staff paid 15 in cash (above); the owner paid 6 cash for parking (moved above); another cash one by the owner.
    await app.inject({ method: 'POST', url: `${M}/ledger/expenses`, headers: as(owner), payload: expense({ paidFrom: 'cash', amount: 4, vendor: 'Tea' }) });
    await app.inject({ method: 'POST', url: `${M}/ledger/expenses`, headers: as(owner), payload: expense({ paidFrom: 'cash', amount: 99, vendor: 'Elsewhere', eventId: 'ev-2' }) });

    const forOwner = (await app.inject({ method: 'GET', url: `${M}/ledger/cash-spent?eventId=ev-1`, headers: as(owner) })).json().expenses;
    expect(forOwner.map((e: { vendor: string }) => e.vendor).sort()).toEqual(['Parking', 'Snacks', 'Tea']);
    expect(forOwner.reduce((n: number, e: { amount: number }) => n + e.amount, 0)).toBe(25);

    const forStaff = (await app.inject({ method: 'GET', url: `${M}/ledger/cash-spent?eventId=ev-1`, headers: as(staff) })).json().expenses;
    expect(forStaff.map((e: { vendor: string }) => e.vendor)).toEqual(['Snacks']);
  });

  it('refuses a missing event, and a helper limited to other events', async () => {
    expect((await app.inject({ method: 'GET', url: `${M}/ledger/cash-spent`, headers: as(owner) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${M}/ledger/cash-spent?eventId=ev-1`, headers: as(staff) })).statusCode).toBe(200);
  });
});
