import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled, type MailMessage } from '@zollify/server-core';
import { commissionsServerModule } from '../modules/commissions';
import { fmtStamp, renderCommission } from '../modules/commissions-page';
import type { PublicCommission } from '@zollify/shared';

/**
 * Commissions hold a customer's name and contact details, and their tracking
 * page is open to anyone with the link - so the tests pin what that page may
 * say, that the link can be retired, that nothing works with the module off,
 * and that what was paid follows the till's sales, refunds included.
 */

const PASSWORD = 'correct horse battery staple';
const sent: MailMessage[] = [];
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let staff: string;
let ownerAccountId: string;
let seq = 0;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (t: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/commissions${url}`, headers: auth(t), ...(payload ? { payload } : {}) });
const push = (type: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: auth(owner),
    payload: { deviceId: 'till', ops: [{ opId: `op-commission-test-${String(++seq).padStart(6, '0')}`, deviceId: 'till', ts: seq, type, payload }] },
  });
/** A sale at the till with one commission line, as the POS records it. */
const pay = (txId: string, commissionId: string, amount: number, extra: Record<string, unknown> = {}) =>
  push('tx.create', {
    id: txId,
    eventId: 'shop',
    deviceId: 'till',
    timestamp: Date.now(),
    method: 'cash',
    payments: [],
    items: [{ pid: `module:commission:${commissionId}`, vid: null, title: 'Deposit', qty: 1, unitPrice: amount, lineTotal: amount, ref: { moduleId: 'commissions', kind: 'commission', id: commissionId } }],
    discounts: [],
    total: amount,
    currency: 'EUR',
    ...extra,
  });

const MIRA = { name: 'Mira Keller', email: 'mira@example.test', phone: '+41 79 555 01 02' };
/** Mira orders several pieces below; each is "add as a new customer anyway" so these tests do not depend on picking her. */
const NEW = { customer: MIRA, forceNewCustomer: true, title: 'Fox portrait', description: 'A3, charcoal, from my own photo', price: 200, depositAsked: 50, dueDate: '2099-01-31', notes: 'asked for rush, said no' };

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-commissions-'));
  process.env.OWNER_EMAIL = 'shop@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [commissionsServerModule],
    defaultModules: ['commissions'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
    mailer: { enabled: true, send: async (m) => (sent.push(m), true) },
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shop@example.test', password: PASSWORD } });
  owner = login.json().accessToken;
  ownerAccountId = login.json().user.accountId;
  await app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(owner), payload: { name: 'Ink & Charcoal' } });
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'member' } });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'staff@example.test', password: PASSWORD, inviteCode: invite.json().code } });
  staff = reg.json().accessToken;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('the owner and staff side', () => {
  let id = '';
  let token = '';

  it('staff create a commission, which starts as requested with a long random link', async () => {
    const res = await call(staff, 'POST', '/commissions', NEW);
    expect(res.statusCode).toBe(201);
    const c = res.json();
    id = c.id;
    token = c.token;
    expect(c).toMatchObject({ status: 'requested', customerName: 'Mira Keller', paid: 0, balance: 200, publicPath: `/p/commissions/${token}` });
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(c.publicUrl).toMatch(/^https?:\/\/.+\/p\/commissions\//);
    expect(c.updates).toHaveLength(1);
  });

  it('refuses nonsense and unknown fields never land on the record', async () => {
    expect((await call(staff, 'POST', '/commissions', { ...NEW, customer: { ...MIRA, name: '' } })).statusCode).toBe(400);
    expect((await call(staff, 'POST', '/commissions', { ...NEW, price: -5 })).statusCode).toBe(400);
    expect((await call(staff, 'POST', '/commissions', { ...NEW, customer: { ...MIRA, email: 'not an email' } })).statusCode).toBe(400);
    const res = await call(staff, 'POST', '/commissions', { ...NEW, title: 'Extra', token: 'A'.repeat(32), status: 'collected', id: 'mine' });
    expect(res.json()).toMatchObject({ status: 'requested' });
    expect(res.json().token).not.toBe('A'.repeat(32));
    expect(res.json().id).not.toBe('mine');
    await call(owner, 'DELETE', `/commissions/${res.json().id}`);
  });

  it('moves through the pipeline with a message per step', async () => {
    const a = await call(staff, 'POST', `/commissions/${id}/updates`, { status: 'accepted', message: 'Happy to do it - starting next week.' });
    expect(a.json().commission.status).toBe('accepted');
    // A message with no new status is a note for the customer.
    const note = await call(staff, 'POST', `/commissions/${id}/updates`, { message: 'Sketch is done.' });
    expect(note.json().commission.updates.at(-1)).toMatchObject({ status: 'accepted', changed: false, message: 'Sketch is done.' });
    expect((await call(staff, 'POST', `/commissions/${id}/updates`, {})).statusCode).toBe(400);

    sent.length = 0;
    const ready = await call(staff, 'POST', `/commissions/${id}/updates`, { status: 'ready', message: 'Come by any time.', email: true });
    expect(ready.json().emailed).toBe(true);
    expect(sent[0]).toMatchObject({ to: 'mira@example.test', subject: 'Fox portrait: Ready for pickup', replyTo: 'shop@example.test' });
    expect(sent[0]?.text).toContain(`/p/commissions/${token}`);
    expect(sent[0]?.text).toContain('Come by any time.');
  });

  it('keeps the email off unless asked, and emails the link on request', async () => {
    sent.length = 0;
    const quiet = await call(staff, 'POST', `/commissions/${id}/updates`, { message: 'Framed it.' });
    expect(quiet.json().emailed).toBe(false);
    expect(sent).toEqual([]);
    expect((await call(staff, 'POST', `/commissions/${id}/email-link`)).json().emailed).toBe(true);
    expect(sent[0]?.subject).toBe('Follow your commission: Fox portrait');
  });

  it('a collected commission cannot move to another step', async () => {
    await call(staff, 'POST', `/commissions/${id}/updates`, { status: 'collected' });
    expect((await call(staff, 'POST', `/commissions/${id}/updates`, { status: 'in_progress' })).statusCode).toBe(409);
  });

  it('settings, a new link and erasure are for admins', async () => {
    expect((await call(staff, 'PUT', '/settings', { pickupName: 'x' })).statusCode).toBe(403);
    expect((await call(staff, 'POST', `/commissions/${id}/link`)).statusCode).toBe(403);
    expect((await call(staff, 'DELETE', `/commissions/${id}`)).statusCode).toBe(403);
    // Staff can still read the settings the till needs.
    expect((await call(staff, 'GET', '/settings')).statusCode).toBe(200);
  });

  it('an admin unlocked at a shared till cannot change settings or retire a link from it', async () => {
    const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'admin' } });
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'admin@example.test', password: PASSWORD, inviteCode: invite.json().code } });
    const adminId = reg.json().user.id as string;
    const grant = (await app.inject({ method: 'POST', url: '/api/device-users', headers: auth(owner), payload: { deviceId: 'counter', email: 'admin@example.test', password: PASSWORD, pin: '4711' } })).json().grant;
    const till = (await app.inject({ method: 'POST', url: '/api/auth/unlock', headers: auth(owner), payload: { deviceId: 'counter', userId: adminId, pin: '4711', grant } })).json().accessToken as string;
    expect((await call(till, 'PUT', '/settings', { pickupName: 'x' })).statusCode).toBe(403);
    expect((await call(till, 'POST', `/commissions/${id}/link`)).statusCode).toBe(403);
    // Everyday work at the till is fine.
    expect((await call(till, 'GET', '/settings')).statusCode).toBe(200);
    expect((await call(till, 'POST', `/commissions/${id}/updates`, { message: 'Hello' })).statusCode).not.toBe(403);
    // The same admin signed in on their own device can.
    const own = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.test', password: PASSWORD } })).json().accessToken as string;
    expect((await call(own, 'POST', `/commissions/${id}/link`)).statusCode).toBe(200);
  });
});

describe('what was paid follows the till', () => {
  let id = '';

  it('sums sale lines that point at the commission, and a refund gives the balance back', async () => {
    id = (await call(staff, 'POST', '/commissions', { ...NEW, title: 'Cat study', price: 120 })).json().id;
    await push('event.upsert', { id: 'shop', name: 'Shop', kind: 'store', venue: {}, currency: 'EUR', status: 'active', updatedAt: 1 });
    await pay('tx-dep', id, 40);
    await pay('tx-bal', id, 30.1);
    // A sale for some other commission changes nothing here.
    await pay('tx-other', 'no-such-commission', 999);
    let c = (await call(staff, 'GET', `/commissions/${id}`)).json();
    expect(c).toMatchObject({ paid: 70.1, balance: 49.9 });
    expect(c.payments.map((p: { amount: number }) => p.amount)).toEqual([40, 30.1]);

    await push('tx.revert', { id: 'tx-dep', revertedAt: Date.now() });
    c = (await call(staff, 'GET', `/commissions/${id}`)).json();
    expect(c).toMatchObject({ paid: 30.1, balance: 89.9 });
  });

  it('a line another module claims to be from commissions does not count', async () => {
    const other = (await call(staff, 'POST', '/commissions', { ...NEW, title: 'Forged', price: 50 })).json().id;
    await push('tx.create', {
      id: 'tx-forged', eventId: 'shop', deviceId: 'till', timestamp: Date.now(), method: 'cash', payments: [], discounts: [], total: 50, currency: 'EUR',
      items: [{ pid: 'x', vid: null, title: 'Other', qty: 1, unitPrice: 50, lineTotal: 50, ref: { moduleId: 'consignment', kind: 'commission', id: other } }],
    });
    expect((await call(staff, 'GET', `/commissions/${other}`)).json().paid).toBe(0);
  });

  it('never reports a negative balance', async () => {
    const over = (await call(staff, 'POST', '/commissions', { ...NEW, title: 'Overpaid', price: 10 })).json().id;
    await pay('tx-over', over, 25);
    expect((await call(staff, 'GET', `/commissions/${over}`)).json()).toMatchObject({ paid: 25, balance: 0 });
  });
});

describe('test mode', () => {
  const testPay = (txId: string, commissionId: string, amount: number) =>
    push('tx.test.create', {
      id: txId, eventId: 'test-ev', deviceId: 'till', timestamp: Date.now(), method: 'cash', payments: [], discounts: [], total: amount, currency: 'EUR', testRun: 'run-1',
      items: [{ pid: `module:commission:${commissionId}`, vid: null, title: 'Deposit', qty: 1, unitPrice: amount, lineTotal: amount, ref: { moduleId: 'commissions', kind: 'commission', id: commissionId } }],
    });
  const SAM = { name: 'Sam Tester', email: 'sam@example.test', phone: '+41 79 555 09 09' };
  let testId = '';
  let realId = '';
  let testPath = '';

  it('keeps test commissions to devices in test mode', async () => {
    const made = (await call(staff, 'POST', '/commissions', { ...NEW, customer: SAM, title: 'Practice piece', price: 80, test: true })).json();
    testId = made.id;
    testPath = made.publicPath;
    realId = (await call(staff, 'POST', '/commissions', { ...NEW, title: 'Real piece', price: 80 })).json().id;
    const real = (await call(staff, 'GET', '/commissions')).json().commissions.map((c: { id: string }) => c.id);
    const tests = (await call(staff, 'GET', '/commissions?test=1')).json().commissions.map((c: { id: string }) => c.id);
    expect(real).toContain(realId);
    expect(real).not.toContain(testId);
    expect(tests).toEqual([testId]);
  });

  it('pays a test commission with test sales only, and a real one with real sales only', async () => {
    await testPay('tt-1', testId, 20);
    await pay('rt-1', testId, 99);
    await testPay('tt-2', realId, 99);
    await pay('rt-2', realId, 30);
    expect((await call(staff, 'GET', `/commissions/${testId}`)).json()).toMatchObject({ paid: 20, balance: 60 });
    expect((await call(staff, 'GET', `/commissions/${realId}`)).json()).toMatchObject({ paid: 30, balance: 50 });
    await push('tx.test.revert', { id: 'tt-1', revertedAt: Date.now() });
    expect((await call(staff, 'GET', `/commissions/${testId}`)).json().paid).toBe(0);
  });

  it('says TEST in its emails and on its page', async () => {
    sent.length = 0;
    expect((await call(staff, 'POST', `/commissions/${testId}/email-link`)).json().emailed).toBe(true);
    expect(sent.at(-1)?.subject).toBe('[TEST] Follow your commission: Practice piece');
    const page = await app.inject({ method: 'GET', url: testPath });
    expect(page.body).toContain('TEST - made in test mode');
  });

  it('lists its new customer only in test mode', async () => {
    const names = async (q: string) => (await call(staff, 'GET', `/customers${q}`)).json().customers.map((c: { name: string }) => c.name);
    expect(await names('?q=Sam')).toEqual([]);
    expect(await names('?q=Sam&test=1')).toEqual(['Sam Tester']);
    expect((await call(staff, 'GET', '/customers/search?q=Sam')).json().customers).toEqual([]);
  });

  it('goes, with its customer, when test data is cleared, and the test sales leave the log', async () => {
    const res = await push('tx.test.clear', { at: Date.now() + 1 });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect((await call(staff, 'GET', `/commissions/${testId}`)).statusCode).toBe(404);
    expect((await call(staff, 'GET', `/commissions/${realId}`)).json().paid).toBe(30);
    expect((await call(staff, 'GET', '/customers?q=Sam&test=1')).json().customers).toEqual([]);
    const left = app.zollify.db.prepare("SELECT count(*) AS n FROM ops WHERE accountId = ? AND type IN ('tx.test.create', 'tx.test.revert')").get(ownerAccountId) as { n: number };
    expect(left.n).toBe(0);
  });
});

describe('the customer page', () => {
  let path = '';
  let id = '';

  it('shows status, updates, due date, payment and pickup, and nothing private', async () => {
    expect((await call(owner, 'PUT', '/settings', { shopName: '', pickupName: 'Ink & Charcoal, Bern', pickupAddress: 'Marktgasse 5, 3011 Bern', pickupNote: 'Tue-Sat 10-18', currency: 'EUR' })).statusCode).toBe(200);
    const made = (await call(staff, 'POST', '/commissions', { ...NEW, title: 'Tiger <b>print</b>', price: 100, dueDate: '2099-03-05' })).json();
    id = made.id;
    path = made.publicPath;
    await call(staff, 'POST', `/commissions/${id}/updates`, { status: 'in_progress', message: 'Started <script>alert(1)</script> today' });
    await pay('tx-tiger', id, 25);

    const res = await app.inject({ method: 'GET', url: path });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const html = res.body;
    expect(html).toContain('name="robots" content="noindex');
    expect(html).toContain('<meta http-equiv="refresh" content="300" />');
    expect(html).toContain('Times are shown in UTC.');
    expect(html).toContain('In progress');
    expect(html).toContain('5 Mar 2099');
    expect(html).toContain('€25.00');
    expect(html).toContain('€75.00');
    expect(html).toContain('Marktgasse 5, 3011 Bern');
    expect(html).toContain('Ink &amp; Charcoal');
    // Everything typed is escaped, and there is no script on the page.
    // The one script is the page's own file; nothing typed ever becomes one.
    expect(html.match(/<script[^>]*>/g)).toEqual(['<script src="/p/commissions/commission.js">']);
    expect(html).toContain('Started &lt;script&gt;alert(1)&lt;/script&gt; today');
    expect(html).not.toContain('<b>print');
    expect(html).toContain('Tiger &lt;b&gt;print&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // No contact details, no internal notes, no description, no ids.
    for (const secret of ['Mira', 'Keller', 'mira@example.test', '555 01 02', 'asked for rush', 'charcoal, from my own photo', id]) expect(html).not.toContain(secret);
  });

  it('answers the same for a wrong token and a malformed one, and a retired link stops working', async () => {
    const wrong = await app.inject({ method: 'GET', url: `/p/commissions/${'A'.repeat(32)}` });
    const short = await app.inject({ method: 'GET', url: '/p/commissions/abc' });
    expect(wrong.statusCode).toBe(404);
    expect(short.statusCode).toBe(404);
    expect(wrong.body).toBe(short.body);
    expect(wrong.headers['x-robots-tag']).toContain('noindex');

    const fresh = (await call(owner, 'POST', `/commissions/${id}/link`)).json();
    expect(fresh.publicPath).not.toBe(path);
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: fresh.publicPath })).statusCode).toBe(200);
    path = fresh.publicPath;
  });

  it('shows a cancelled commission as cancelled, and drops the due date once it is closed', async () => {
    await call(staff, 'POST', `/commissions/${id}/updates`, { status: 'cancelled', message: 'Customer changed their mind.' });
    const html = (await app.inject({ method: 'GET', url: path })).body;
    expect(html).toContain('This commission was cancelled.');
    expect(html).not.toContain('http-equiv');
    expect(html).not.toContain('5 Mar 2099');
  });

  it('takes the zone from the settings, and refuses an unknown one', async () => {
    const settings = { shopName: '', pickupName: '', pickupAddress: '', pickupNote: '', currency: 'EUR' };
    expect((await call(owner, 'PUT', '/settings', { ...settings, timeZone: 'Mars/Olympus' })).statusCode).toBe(400);
    expect((await call(owner, 'PUT', '/settings', { ...settings, timeZone: 'Europe/Zurich' })).json()).toMatchObject({ timeZone: 'Europe/Zurich' });
    const made = (await call(staff, 'POST', '/commissions', { ...NEW, title: 'Zone test' })).json();
    const html = (await app.inject({ method: 'GET', url: made.publicPath })).body;
    expect(html).toContain('Times are shown in Europe/Zurich.');
    expect(html).toContain('<meta http-equiv="refresh" content="300" />');
    await call(owner, 'PUT', '/settings', { ...settings, timeZone: 'UTC' });
  });

  it('is gone when the module is switched off, and back when it is on again', async () => {
    setEnabled(app.zollify.db, ownerAccountId, 'commissions', false);
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    expect((await call(owner, 'GET', '/commissions')).statusCode).toBe(402);
    setEnabled(app.zollify.db, ownerAccountId, 'commissions', true);
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(200);
  });

  it('erasing a commission removes the page and the customer data', async () => {
    const res = await call(owner, 'DELETE', `/commissions/${id}`);
    expect(res.statusCode).toBe(200);
    expect((await call(owner, 'GET', `/commissions/${id}`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
  });

  it('is rate limited', async () => {
    const codes = new Set<number>();
    for (let i = 0; i < 70; i++) codes.add((await app.inject({ method: 'GET', url: `/p/commissions/${'B'.repeat(32)}` })).statusCode);
    expect(codes.has(429)).toBe(true);
  });
});

describe('times on the customer page', () => {
  const base: PublicCommission = {
    shop: 'Ink',
    title: 'Fox',
    status: 'in_progress',
    statusLabel: 'In progress',
    dueDate: '',
    timeZone: 'UTC',
    currency: 'EUR',
    price: 0,
    paid: 0,
    balance: 0,
    updates: [],
    pickup: null,
    brief: null,
    pictures: [],
    canAddBrief: true,
    hasEmail: true,
    mailEnabled: true,
    push: true,
  };
  // 23:30 UTC on 5 Jan 2099: already the next day in Zurich, still the same afternoon in Los Angeles.
  const lateEvening = Date.UTC(2099, 0, 5, 23, 30);

  it('shows a moment on the clock of the owner\'s zone, across midnight', () => {
    expect(fmtStamp(lateEvening, 'UTC')).toBe('5 Jan 2099, 23:30');
    expect(fmtStamp(lateEvening, 'Europe/Zurich')).toBe('6 Jan 2099, 00:30');
    expect(fmtStamp(lateEvening, 'America/Los_Angeles')).toBe('5 Jan 2099, 15:30');
    // Summer time moves the offset: 22:30 UTC in July is already 00:30 in Zurich.
    expect(fmtStamp(Date.UTC(2099, 6, 5, 22, 30), 'Europe/Zurich')).toBe('6 Jul 2099, 00:30');
    expect(fmtStamp(Date.UTC(2099, 0, 5, 0, 5), 'UTC')).toBe('5 Jan 2099, 00:05');
  });

  it('falls back to UTC for a zone it does not know', () => {
    expect(fmtStamp(lateEvening, 'Mars/Olympus')).toBe('5 Jan 2099, 23:30');
  });

  it('renders update times in that zone and names it, escaped', () => {
    const update = { at: lateEvening, status: 'in_progress' as const, statusLabel: 'In progress', changed: true, message: '' };
    const html = renderCommission({ ...base, timeZone: 'Europe/Zurich', updates: [update] });
    expect(html).toContain('6 Jan 2099, 00:30');
    expect(html).not.toContain('5 Jan 2099');
    expect(html).toContain('Times are shown in Europe/Zurich.');
    expect(renderCommission({ ...base, timeZone: '<b>' })).toContain('Times are shown in &lt;b&gt;.');
  });

  it('refreshes by itself only while the commission is open, and never runs inline script', () => {
    const token = 'A'.repeat(32);
    for (const status of ['requested', 'accepted', 'in_progress', 'ready'] as const) {
      const html = renderCommission({ ...base, status }, token);
      // Without script, a plain refresh; with it, the script waits while the customer types.
      expect(html).toContain('<noscript><meta http-equiv="refresh" content="300" /></noscript>');
      expect(html).toContain('data-watch="1"');
      expect(html.match(/<script[^>]*>/g)).toEqual(['<script src="/p/commissions/commission.js">']);
    }
    for (const status of ['collected', 'cancelled'] as const) {
      const html = renderCommission({ ...base, status, canAddBrief: false }, token);
      expect(html).not.toContain('http-equiv');
      expect(html).not.toContain('id="push"');
    }
    // Rendered without its token (a preview) it has no forms and no script at all.
    expect(renderCommission(base)).not.toContain('<script');
  });

  it('shows the brief escaped, a form while open, read-only once closed', () => {
    const token = 'B'.repeat(32);
    const withBrief = { ...base, brief: { text: 'A fox <b>please</b>', budget: '150', wantedBy: '2099-01-31' }, pictures: [{ id: 'p1', name: 'ref<1>.png', mime: 'image/png', size: 10, createdAt: 1 }] };
    const open = renderCommission(withBrief, token);
    expect(open).toContain('id="brief"');
    expect(open).toContain('A fox &lt;b&gt;please&lt;/b&gt;</textarea>');
    expect(open).toContain('Budget: 150 · Wanted by 31 Jan 2099');
    expect(open).toContain(`/p/commissions/${token}/pictures/p1`);
    expect(open).toContain('alt="ref&lt;1&gt;.png"');
    expect(open).toContain('data-remove="p1"');
    expect(open).toContain('id="push"');
    expect(open).toContain(`/p/commissions/${token}/manifest.webmanifest`);
    const closed = renderCommission({ ...withBrief, status: 'collected', canAddBrief: false }, token);
    expect(closed).not.toContain('id="brief"');
    expect(closed).toContain('What you asked for');
    expect(closed).not.toContain('data-remove');
  });
});
