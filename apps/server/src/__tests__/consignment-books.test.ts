import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled, type MailMessage } from '@zollify/server-core';
import { localDay, reportPeriod, type ArtistConsignment, type ConsignmentFee, type ReportPeriod, type StoreReport } from '@zollify/shared';
import { consignmentServerModule } from '../modules/consignment';
import { sendClosedReports } from '../modules/consignment-books';

/**
 * Fees and reports move money on paper: a fee comes off what the artist is
 * owed, a report says what to pay. The tests pin that the artist hears about
 * every fee, can object, that waiving gives it back, and that paying out from
 * a report never pays the same money twice.
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
  app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(t), payload: { deviceId: 'dev', ops: ops.map((o) => ({ opId: `op-books-${String(++n).padStart(10, '0')}`, deviceId: 'dev', ts: n, ...o })) } });
const balance = async (): Promise<number> => (await call(store, 'GET', '/statement')).json().statements.find((s: { consignorId: string }) => s.consignorId === 'ana').totals[0].balance;
const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-books-'));
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

  // Ana sold a 100 print today, by card, at 40% commission: she is owed 60.
  await push(store, [
    { type: 'event.upsert', payload: { id: 'zh', name: 'Zurich shop', kind: 'store', venue: {}, currency: 'CHF', status: 'active', updatedAt: 1 } },
    { type: 'product.upsert', payload: { id: 'p1', title: 'Fox print', forSale: true, unlisted: false, price: 100, variants: [], consignorId: 'ana', sortOrder: 0, updatedAt: 1 } },
    { type: 'tx.create', payload: { id: 't1', eventId: 'zh', deviceId: 'dev', timestamp: Date.now(), method: 'card', payments: [{ kind: 'card', amount: 100 }], items: [{ pid: 'p1', vid: null, title: 'Fox print', qty: 1, unitPrice: 100, lineTotal: 100, consignorId: 'ana' }], discounts: [], total: 100, currency: 'CHF' } },
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

describe('fees', () => {
  let fee: ConsignmentFee;

  it('charges a missed setup, tells the artist, and comes off the balance', async () => {
    expect(await balance()).toBe(60);
    const setup = (await call(store, 'POST', '/setups', { consignorId: 'ana', storeId: 'zh', date: today, time: '10:00' })).json().setup;
    sent.length = 0;
    const res = await call(store, 'POST', '/fees', { consignorId: 'ana', reason: 'no_show', amount: 25, currency: 'CHF', date: today, setupId: setup.id, note: 'Shelf stayed empty' });
    expect(res.statusCode).toBe(201);
    fee = res.json().fee;
    expect(fee).toMatchObject({ status: 'charged', storeId: 'zh' });
    expect(res.json().delivery).toMatchObject({ notified: true, emailedTo: 'ana@example.test' });
    expect(sent[0]?.subject).toMatch(/charged a fee of CHF 25.00/);
    expect(sent[0]?.text).toContain('Missed a setup');
    expect(await balance()).toBe(35);

    const bell = (await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(artist) })).json().notifications;
    expect(bell[0].title).toMatch(/charged a fee: CHF 25.00/);
    const [mine] = (await call(artist, 'GET', '/links')).json().links as ArtistConsignment[];
    expect(mine!.fees.map((f) => f.id)).toEqual([fee.id]);
    expect(mine!.statement.totals[0]).toMatchObject({ fees: 25, balance: 35 });

    // Once per setup.
    expect((await call(store, 'POST', '/fees', { consignorId: 'ana', reason: 'no_show', amount: 25, currency: 'CHF', date: today, setupId: setup.id })).statusCode).toBe(409);
  });

  it('lets the artist object, which reaches the store', async () => {
    sent.length = 0;
    const res = await call(artist, 'POST', `/links/${storeAccountId}/ana/fees/${fee.id}/dispute`, { note: 'I was there at 10, the shop was closed.' });
    expect(res.json().fee.dispute).toContain('shop was closed');
    expect(sent[0]).toMatchObject({ to: 'shop@example.test' });
    const bell = (await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(store) })).json().notifications;
    expect(bell[0].title).toBe('Ana objects to a fee of CHF 25.00');
    // Only her own link.
    expect((await call(store, 'POST', `/links/${storeAccountId}/ana/fees/${fee.id}/dispute`, { note: 'x' })).statusCode).toBe(404);
  });

  it('waiving gives it back and tells the artist', async () => {
    sent.length = 0;
    const res = await call(store, 'POST', `/fees/${fee.id}/waive`, { note: 'Sorry - we were closed.' });
    expect(res.json().fee.status).toBe('waived');
    expect(sent[0]?.subject).toMatch(/waived a fee/);
    expect(await balance()).toBe(60);
    expect((await call(store, 'POST', `/fees/${fee.id}/waive`)).statusCode).toBe(409);
  });
});

describe('reports', () => {
  let current: ReportPeriod;

  it('passes card costs on to artists when the store says so', async () => {
    expect((await call(store, 'PUT', '/books/settings', { timeZone: 'Nowhere/City' })).statusCode).toBe(400);
    const res = await call(store, 'PUT', '/books/settings', { reportPeriod: 'monthly', timeZone: 'Europe/Zurich', cardFeePct: 2, passCardFees: true, feePresets: { no_show: 25 } });
    expect(res.json().settings).toMatchObject({ cardFeePct: 2, passCardFees: true, feePresets: { no_show: 25 } });
    expect(await balance()).toBe(58.8); // 60 less her 60% of the 2.00 card fee
  });

  it('reports the current period, as JSON and as a spreadsheet', async () => {
    const list = (await call(store, 'GET', '/reports')).json();
    expect(list.periods).toHaveLength(12);
    current = list.periods[0];
    expect(current).toEqual(reportPeriod({ reportPeriod: 'monthly', biweeklyAnchor: '2024-01-01' }, localDay(Date.now(), 'Europe/Zurich')));
    const { report, venues } = (await call(store, 'GET', `/reports/${current.from}`)).json() as { report: StoreReport; venues: Record<string, string> };
    expect(report.totals[0]).toMatchObject({ sales: 1, gross: 100, card: 100, cardFees: 2, commission: 40, artistShare: 60, cardFeesPassed: 1.2 });
    expect(report.artists[0]).toMatchObject({ name: 'Ana', earned: 58.8, balance: 58.8 });
    expect(venues).toEqual({ zh: 'Zurich shop' });
    const csv = await call(store, 'GET', `/reports/${current.from}/csv`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body).toContain('Zurich shop,CHF,1,1,100');
    expect((await call(store, 'GET', '/reports/2026-01-02')).statusCode).toBe(404); // not a period start
  });

  it('pays out what the period left owing, once', async () => {
    const first = (await call(store, 'POST', `/reports/${current.from}/payouts`, { date: current.to })).json();
    expect(first.payouts).toEqual([{ consignorId: 'ana', amount: 58.8, currency: 'CHF' }]);
    expect(await balance()).toBe(0);
    expect((await call(store, 'POST', `/reports/${current.from}/payouts`, { date: current.to })).json().payouts).toEqual([]);
  });

  it('emails the owner the closed period with the spreadsheet, once', async () => {
    // A month on, the period with Ana's sale has closed.
    const later = Date.parse(`${current.to}T12:00:00Z`) + 5 * 86_400_000;
    sent.length = 0;
    expect(await sendClosedReports(servicesFor(), later)).toBe(1);
    expect(sent[0]).toMatchObject({ to: 'shop@example.test' });
    expect(sent[0]!.subject).toMatch(/report for/);
    expect(sent[0]!.attachments?.[0]).toMatchObject({ filename: `report-${current.from}.csv`, contentType: 'text/csv' });
    expect(await sendClosedReports(servicesFor(), later)).toBe(0);
  });

  it('is not for staff', async () => {
    const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(store), payload: { role: 'member' } });
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'sam@example.test', password: PASSWORD, inviteCode: invite.json().code } });
    const staff = reg.json().accessToken as string;
    for (const url of ['/reports', '/fees', '/books/settings']) expect((await call(staff, 'GET', url)).statusCode).toBe(403);
  });
});

/** The services a module's timer gets, built the way the gateway builds them. */
function servicesFor() {
  return { db: app.zollify.db, notify: () => undefined, mail: { enabled: true, send: async (m: MailMessage) => (sent.push(m), true) }, writeOps: () => 0 };
}
