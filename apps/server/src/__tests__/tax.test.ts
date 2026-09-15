import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '@zollify/server-core';
import { taxServerModule } from '../modules/tax/index';

/**
 * The server half without any real provider: secrets stay secret, mock mode
 * feeds the importer, a dry run builds a correct voucher, the ledger sums, and
 * cash comes from the account's own sales.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'correct horse battery staple';
const SECRET = 'test-secret-value-long-enough-for-signing';

let app: FastifyInstance;
let dataDir: string;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });
const M = '/api/m/tax';

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-tax-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = OWNER_PASSWORD;
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
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'Test' } });
  token = login.json().accessToken;

  // One event and two sales - one cash, one card, one reverted - through the real sync path.
  const op = (opId: string, type: string, payload: unknown) => ({ opId: opId.padEnd(16, '0'), deviceId: 'dev-1', ts: 1, type, payload });
  const tx = (id: string, kind: 'cash' | 'card', amount: number) => ({
    id, eventId: 'ev-1', deviceId: 'dev-1', timestamp: 1, method: kind, payments: [{ kind, amount }], items: [], discounts: [], total: amount, currency: 'EUR',
  });
  const push = await app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: auth(),
    payload: {
      deviceId: 'dev-1',
      ops: [
        op('ev', 'event.upsert', { id: 'ev-1', name: 'Leipzig Con', dateStart: '2026-03-07', dateEnd: '2026-03-08', venue: { country: 'Germany' }, currency: 'EUR', status: 'closed', updatedAt: 1 }),
        op('t1', 'tx.create', tx('t1', 'cash', 40)),
        op('t2', 'tx.create', tx('t2', 'card', 25)),
        op('t3', 'tx.create', tx('t3', 'cash', 99)),
        op('r3', 'tx.revert', { id: 't3', revertedAt: 2, revertedBy: 'r3' }),
      ],
    },
  });
  expect(push.statusCode).toBe(200);
});

afterAll(async () => {
  try {
    app.zollify?.db?.close();
  } catch {
    /* closed */
  }
  await app.close();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* temp */
  }
  delete process.env.OWNER_EMAIL;
  delete process.env.OWNER_PASSWORD;
});

describe('tax module', () => {
  it('stores secrets encrypted and never echoes them', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `${M}/config`,
      headers: auth(),
      payload: { set: { LEXWARE_API_KEY: 'lx-secret-123', LEXWARE_DOMESTIC_VAT: '19' } },
    });
    expect(put.statusCode).toBe(200);
    const values = put.json().values;
    expect(values.LEXWARE_API_KEY).toBeUndefined();
    expect(values.LEXWARE_API_KEY__set).toBe(true);
    expect(values.LEXWARE_DOMESTIC_VAT).toBe('19');

    const row = app.zollify.db.prepare('SELECT blob FROM tax_config').get() as { blob: string };
    expect(row.blob).not.toContain('lx-secret-123');
    expect(row.blob.startsWith('v1.')).toBe(true);
  });

  it('keeps a saved secret when the field is left blank, and clears it on request', async () => {
    await app.inject({ method: 'PUT', url: `${M}/config`, headers: auth(), payload: { set: { LEXWARE_API_KEY: '' } } });
    let cfg = await app.inject({ method: 'GET', url: `${M}/config`, headers: auth() });
    expect(cfg.json().values.LEXWARE_API_KEY__set).toBe(true);
    await app.inject({ method: 'PUT', url: `${M}/config`, headers: auth(), payload: { clear: ['LEXWARE_API_KEY'] } });
    cfg = await app.inject({ method: 'GET', url: `${M}/config`, headers: auth() });
    expect(cfg.json().values.LEXWARE_API_KEY__set).toBe(false);
  });

  it('serves mock transactions from every source when nothing is configured', async () => {
    const st = await app.inject({ method: 'GET', url: `${M}/status`, headers: auth() });
    expect(st.json().mypos.mode).toBe('mock');
    const my = await app.inject({ method: 'GET', url: `${M}/mypos/transactions?from=2026-03-01&to=2026-03-31`, headers: auth() });
    expect(my.json().transactions.length).toBeGreaterThan(0);
    expect(my.json().transactions[0]).toMatchObject({ source: 'mypos', type: 'Payment' });
    const sh = await app.inject({ method: 'GET', url: `${M}/shopify/orders?from=2026-03-01&to=2026-03-31`, headers: auth() });
    expect(sh.json().orders.some((o: { isOnline: boolean }) => o.isOnline)).toBe(true);
    const su = await app.inject({ method: 'GET', url: `${M}/sumup/transactions?from=2026-03-01&to=2026-03-31`, headers: auth() });
    expect(su.json().transactions.some((t: { type: string }) => t.type === 'Fee')).toBe(true);
  });

  it('rejects a malformed range', async () => {
    const res = await app.inject({ method: 'GET', url: `${M}/mypos/transactions?from=march&to=april`, headers: auth() });
    expect(res.statusCode).toBe(400);
  });

  it('builds a gross revenue voucher on a dry run without touching Lexware', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${M}/lexware/book`,
      headers: auth(),
      payload: {
        kind: 'revenue',
        dryRun: true,
        voucherNumber: 'PN_2026_03_001_P',
        totalGrossAmount: 119,
        event: { name: 'Leipzig Con', country: 'Germany', startDate: '2026-03-07', endDate: '2026-03-08', vatRate: 19 },
      },
    });
    expect(res.statusCode).toBe(200);
    const v = res.json().voucher;
    expect(v.type).toBe('salesinvoice');
    expect(v.totalGrossAmount).toBe(119);
    expect(v.totalTaxAmount).toBe(19);
    expect(v.voucherDate).toMatch(/^2026-03-07T00:00:00\.000\+01:00$/);
    expect(res.json().customerName).toBe('Revenue - Leipzig Con');
  });

  it('refuses a fees voucher until a fee category is set', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${M}/lexware/book`,
      headers: auth(),
      payload: { kind: 'fees', dryRun: true, voucherNumber: 'PN_2026_03_F', voucherDate: '2026-03-28', totalGrossAmount: 12.5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/fee expense category/i);
  });

  it('refuses a live booking with no API key rather than failing at Lexware', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${M}/lexware/book`,
      headers: auth(),
      payload: { kind: 'revenue', dryRun: false, voucherNumber: 'X', totalGrossAmount: 1, voucherDate: '2026-03-07', taxRatePercent: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('not_configured');
  });

  it('reads cash for an event from the op-log, skipping reverted sales', async () => {
    const res = await app.inject({ method: 'GET', url: `${M}/events/ev-1/cash`, headers: auth() });
    expect(res.json()).toMatchObject({ cash: 40, count: 1, currency: 'EUR' });
  });

  it('keeps a ledger and folds it into a per-event P&L', async () => {
    const add = await app.inject({
      method: 'POST',
      url: `${M}/ledger/expenses`,
      headers: auth(),
      payload: { eventId: 'ev-1', category: 'accommodation', amount: 12.34, currency: 'EUR', date: '2026-03-06', vendor: 'Hotel' },
    });
    expect(add.statusCode).toBe(201);
    const id = add.json().expense.id;

    const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
    const att = await app.inject({ method: 'POST', url: `${M}/ledger/expenses/${id}/invoice`, headers: auth(), payload: { base64: pdf, filename: 'hotel.pdf' } });
    expect(att.json().expense.invoice.filename).toBe('hotel.pdf');
    const back = await app.inject({ method: 'GET', url: `${M}/ledger/expenses/${id}/invoice`, headers: auth() });
    expect(back.json().base64).toBe(pdf);

    const pnl = await app.inject({ method: 'GET', url: `${M}/ledger/pnl`, headers: auth() });
    const row = pnl.json().rows.find((r: { eventId: string }) => r.eventId === 'ev-1');
    // 40 cash + 25 card, the reverted 99 excluded; minus the hotel.
    expect(row).toMatchObject({ revenue: 65, expenses: 12.34, margin: 52.66, expenseCount: 1, unbooked: 1 });
    expect(row.byCategory.accommodation).toBe(12.34);
  });

  it('is off for the invoice reader until a key is saved', async () => {
    const res = await app.inject({ method: 'POST', url: `${M}/ledger/parse`, headers: auth(), payload: { base64: 'AAAA' } });
    expect(res.statusCode).toBe(503);
  });
});
