import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '@zollify/server-core';
import { localDay, recentPeriods, reportPeriod, type ReportPeriod } from '@zollify/shared';
import { consignmentArtistServerModule, consignmentServerModule } from '../modules/consignment';

/**
 * A closed period is invoiced once per artist with a gap-free number, the
 * payment file pays exactly what is owed (and names who it could not pay),
 * and the journal CSV carries the invoice numbers into the books.
 */

const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let store: string;
let closed: ReportPeriod;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/consignment${url}`, headers: auth(store), ...(payload ? { payload } : {}) });
let n = 0;
const push = (ops: { type: string; payload: unknown }[]) =>
  app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(store), payload: { deviceId: 'dev', ops: ops.map((o) => ({ opId: `op-acc-${String(++n).padStart(10, '0')}`, deviceId: 'dev', ts: n, ...o })) } });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-acc-'));
  process.env.OWNER_EMAIL = 'shop@example.test';
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
    mailer: { enabled: false, send: async () => false },
  });
  await app.ready();
  store = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shop@example.test', password: PASSWORD } })).json().accessToken;

  await call('PUT', '/books/settings', { reportPeriod: 'monthly', timeZone: 'UTC' });
  const settings = (await call('GET', '/books/settings')).json().settings;
  const today = localDay(Date.now(), 'UTC');
  closed = recentPeriods(settings, reportPeriod(settings, today).from, 2)[1]!;
  const ts = new Date(`${closed.from}T12:00:00Z`).getTime();
  const sale = (id: string, pid: string, consignorId: string, price: number) => ({
    type: 'tx.create',
    payload: { id, eventId: 'zh', deviceId: 'dev', timestamp: ts, method: 'card', payments: [{ kind: 'card', amount: price }], items: [{ pid, vid: null, title: pid, qty: 1, unitPrice: price, lineTotal: price, consignorId }], discounts: [], total: price, currency: 'EUR' },
  });
  await push([
    { type: 'event.upsert', payload: { id: 'zh', name: 'Shop', kind: 'store', venue: {}, currency: 'EUR', status: 'active', updatedAt: 1 } },
    { type: 'product.upsert', payload: { id: 'p1', title: 'Fox', forSale: true, unlisted: false, price: 100, variants: [], consignorId: 'ana', sortOrder: 0, updatedAt: 1 } },
    { type: 'product.upsert', payload: { id: 'p2', title: 'Owl', forSale: true, unlisted: false, price: 50, variants: [], consignorId: 'bo', sortOrder: 0, updatedAt: 1 } },
    sale('t1', 'p1', 'ana', 100),
    sale('t2', 'p2', 'bo', 50),
  ]);
  await call('PUT', '/consignors/ana', { name: 'Ana Ærø', commissionPct: 40, storeIds: ['zh'], iban: 'DK50 0040 0440 1162 43' });
  await call('PUT', '/consignors/bo', { name: 'Bo', commissionPct: 50, storeIds: ['zh'] });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('artist bank details', () => {
  it('rejects an IBAN that fails the check and stores a good one without spaces', async () => {
    expect((await call('PUT', '/consignors/bo', { name: 'Bo', commissionPct: 50, iban: 'DK00 0000 0000 0000 00' })).statusCode).toBe(400);
    const ana = (await call('GET', '/consignors')).json().consignors.find((c: { id: string }) => c.id === 'ana');
    expect(ana.iban).toBe('DK5000400440116243');
  });
});

describe('invoices', () => {
  it('refuses to invoice a period still running', async () => {
    const settings = (await call('GET', '/books/settings')).json().settings;
    const current = reportPeriod(settings, localDay(Date.now(), 'UTC'));
    expect((await call('POST', `/reports/${current.from}/invoices`)).statusCode).toBe(409);
  });

  it('numbers one invoice per artist, and issuing again changes nothing', async () => {
    const first = (await call('POST', `/reports/${closed.from}/invoices`)).json().invoices;
    expect(first.map((i: { number: string }) => i.number)).toEqual([`SB-${closed.to.slice(0, 4)}-00001`, `SB-${closed.to.slice(0, 4)}-00002`]);
    const ana = first.find((i: { consignorId: string }) => i.consignorId === 'ana');
    expect(ana).toMatchObject({ total: 60, currency: 'EUR', date: closed.to });
    expect(ana.lines.map((l: { kind: string; amount: number }) => [l.kind, l.amount])).toEqual([['sales', 100], ['commission', -40]]);
    const again = (await call('POST', `/reports/${closed.from}/invoices`)).json().invoices;
    expect(again).toEqual(first);
  });
});

describe('payment file', () => {
  it('needs the store account first', async () => {
    expect((await call('POST', `/reports/${closed.from}/payment-file`, { date: closed.to })).statusCode).toBe(409);
  });

  it('pays Ana by invoice number and names Bo, who has no IBAN', async () => {
    await call('PUT', '/books/settings', { reportPeriod: 'monthly', timeZone: 'UTC', accounting: { payerName: 'Shop ApS', payerIban: 'DE89 3704 0044 0532 0130 00', accountArtistPayable: '2400', accountCommission: '1000' } });
    const res = (await call('POST', `/reports/${closed.from}/payment-file`, { date: '2030-01-02' })).json();
    expect(res.included).toEqual([{ consignorId: 'ana', name: 'Ana Ærø', amount: 60, currency: 'EUR', reference: `SB-${closed.to.slice(0, 4)}-00001` }]);
    expect(res.skipped).toEqual([{ consignorId: 'bo', name: 'Bo', reason: 'No IBAN on file.' }]);
    expect(res.xml).toContain('xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"');
    expect(res.xml).toContain('<InstdAmt Ccy="EUR">60.00</InstdAmt>');
    expect(res.xml).toContain(`<EndToEndId>SB-${closed.to.slice(0, 4)}-00001</EndToEndId>`);
    expect(res.xml).toContain('<Nm>Ana AEro</Nm>');
    expect(res.xml).toContain('<IBAN>DK5000400440116243</IBAN>');
  });

  it('pays nothing again once the payout is recorded', async () => {
    await call('POST', `/reports/${closed.from}/payouts`, { date: closed.to, consignorIds: ['ana'] });
    const res = (await call('POST', `/reports/${closed.from}/payment-file`, { date: '2030-01-02' })).json();
    expect(res).toMatchObject({ xml: null, included: [] });
  });
});

describe('journal', () => {
  it('carries invoice numbers and the store ledger accounts', async () => {
    const csv = (await call('GET', `/reports/${closed.from}/journal.csv`)).body;
    const y = closed.to.slice(0, 4);
    expect(csv).toContain(`${closed.to},SB-${y}-00001,Sales of your work - Ana Ærø,2400,,100.00,EUR`);
    expect(csv).toContain(`${closed.to},SB-${y}-00001,Store commission - Ana Ærø,1000,2400,40.00,EUR`);
  });
});
