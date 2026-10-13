import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGateway, setEnabled } from '@zollify/server-core';
import { economicServerModule } from '../modules/economic';

/**
 * e-conomic: a closed day books once as one balanced voucher, never twice,
 * and a voucher that may or may not have arrived is never silently re-sent.
 */

const PASSWORD = 'correct horse battery staple';
const SECRET = 'test-secret-value-long-enough-for-signing';
const DAY = '2026-10-05';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let seq = 0;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/economic${url}`, headers: auth(owner), ...(payload ? { payload } : {}) });
const push = (type: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: auth(owner),
    payload: { deviceId: 'till', ops: [{ opId: `op-economic-test-${String(++seq).padStart(6, '0')}`, deviceId: 'till', ts: seq, type, payload }] },
  });
const sale = (id: string, amount: number, method: 'cash' | 'card', timestamp = Date.parse(`${DAY}T10:00:00Z`)) =>
  push('tx.create', {
    id,
    eventId: 'shop',
    deviceId: 'till',
    timestamp,
    method,
    payments: [{ kind: method, amount }],
    items: [{ pid: 'mug', vid: null, title: 'Mug', qty: 1, unitPrice: amount, lineTotal: amount }],
    discounts: [],
    total: amount,
    currency: 'DKK',
    tax: { country: 'DK', exempt: false, rates: [25] },
  });

/** e-conomic as far as booking needs it; `posted` keeps every voucher it was sent. */
const posted: unknown[] = [];
let answer: 'ok' | 'refuse' | 'silence' = 'ok';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-economic-'));
  process.env.OWNER_EMAIL = 'shop@economic.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: SECRET,
    serverModules: [economicServerModule(SECRET, 'app-secret')],
    defaultModules: ['economic'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  const login = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shop@economic.test', password: PASSWORD } })).json();
  owner = login.accessToken;
  setEnabled(app.zollify.db, login.user.accountId, 'economic', true);

  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://restapi.e-conomic.com')) return realFetch(input, init);
    const headers = init?.headers as Record<string, string>;
    if (headers['X-AppSecretToken'] !== 'app-secret' || headers['X-AgreementGrantToken'] !== 'grant-token-123') return json({ message: 'Unauthorized' }, 401);
    if (url.endsWith('/self')) return json({ company: { name: 'Loppehjørnet ApS' }, agreementNumber: 42 });
    if (url.includes('/accounting-years')) return json({ collection: [{ year: '2026', fromDate: '2026-01-01', toDate: '2026-12-31' }] });
    if (answer === 'silence') throw new TypeError('fetch failed');
    if (answer === 'refuse') return json({ message: 'Validation error', errors: { account: { errors: [{ message: 'Account 9999 does not exist.' }] } } }, 400);
    posted.push(JSON.parse(String(init?.body)));
    return json({ voucherNumber: 1000 + posted.length });
  });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
  vi.restoreAllMocks();
});

describe('e-conomic', () => {
  it('never sends the grant token back', async () => {
    expect((await call('PUT', '/grant', { token: 'grant-token-123' })).json()).toEqual({ server: true, grant: true });
    const res = await call('GET', '/settings');
    expect(res.body).not.toContain('grant-token-123');
    expect((await call('POST', '/test')).json()).toMatchObject({ ok: true, company: 'Loppehjørnet ApS' });
  });

  it('shows a day and what is missing before it can book', async () => {
    await sale('a', 100, 'cash');
    await sale('b', 250, 'card');
    const { days } = (await call('GET', `/days?from=${DAY}&to=${DAY}`)).json();
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ day: DAY, total: 350, sales: 2, booking: null });
    expect(days[0].problems.join(' ')).toMatch(/Set the e-conomic account/);
    expect((await call('POST', `/days/${DAY}/book`)).statusCode).toBe(422);
  });

  it('books a closed day once, as one balanced voucher', async () => {
    await call('PUT', '/settings', { journalNumber: 3, accounts: { sales: 1010, commission: 1020, renters: 6800, cash: 5800, card: 5810 } });
    const res = await call('POST', `/days/${DAY}/book`);
    expect(res.json().booking).toMatchObject({ status: 'booked', voucherNumber: 1001, year: '2026', totalMinor: 35000 });
    const voucher = posted[0] as { journal: { journalNumber: number }; entries: { financeVouchers: { account: { accountNumber: number }; amount: number; vatAccount?: { vatCode: string } }[] } };
    expect(voucher.journal.journalNumber).toBe(3);
    const lines = voucher.entries.financeVouchers;
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(0);
    expect(lines.find((l) => l.account.accountNumber === 1010)).toMatchObject({ amount: -350, vatAccount: { vatCode: 'U25' } });
    expect((await call('POST', `/days/${DAY}/book`)).statusCode).toBe(409);
    expect(posted).toHaveLength(1);
  });

  it('frees a day e-conomic refused, and holds one it never answered for', async () => {
    await sale('c', 40, 'card', Date.parse('2026-10-06T10:00:00Z'));
    answer = 'refuse';
    const refused = await call('POST', '/days/2026-10-06/book');
    expect(refused.statusCode).toBe(502);
    expect(refused.json().message).toContain('Account 9999 does not exist.');
    answer = 'silence';
    expect((await call('POST', '/days/2026-10-06/book')).statusCode).toBe(504);
    const held = (await call('GET', '/days/2026-10-06')).json().booking;
    expect(held).toMatchObject({ status: 'pending' });
    answer = 'ok';
    expect((await call('POST', '/days/2026-10-06/book')).statusCode).toBe(409);
    // Someone checked e-conomic and it is not there: free the day and book it.
    await call('DELETE', '/days/2026-10-06/booking');
    expect((await call('POST', '/days/2026-10-06/book')).json().booking.status).toBe('booked');
  });

  it('will not book a day that is still running', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(Date.now());
    expect((await call('POST', `/days/${today}/book`)).json().error).toBe('open_day');
  });
});
