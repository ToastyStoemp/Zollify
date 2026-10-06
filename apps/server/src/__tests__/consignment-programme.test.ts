import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled, type MailMessage } from '@zollify/server-core';
import { addMonths, type ArtistConsignment, type PublicProgramme, type Signup } from '@zollify/shared';

process.env.SIGNUP_CAPTCHA_BITS = '10';
const { consignmentArtistServerModule, consignmentServerModule } = await import('../modules/consignment');

/**
 * Sign-ups come from strangers on the open web, so the tests walk the public
 * page the way a visitor would - proof-of-work and all - and pin who gets a
 * seat, who waits, who is told, and that nothing works without the store's
 * current link.
 */

const PASSWORD = 'correct horse battery staple';
const sent: MailMessage[] = [];
let app: FastifyInstance;
let dataDir: string;
let store: string;
let storeAccountId: string;
let artist: string;
let publicPath: string;
const day = addMonths(new Date().toISOString().slice(0, 10), 1);

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (t: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/${url.startsWith('/links') ? 'consignment-artist' : 'consignment'}${url}`, headers: auth(t), ...(payload ? { payload } : {}) });

function solve(nonce: string, difficulty: number): string {
  for (let i = 0; ; i++) {
    const h = createHash('sha256').update(`${nonce}:${i}`).digest();
    let bits = 0;
    for (const b of h) {
      if (b === 0) { bits += 8; continue; }
      bits += Math.clz32(b) - 24;
      break;
    }
    if (bits >= difficulty) return String(i);
  }
}

async function signUp(workshopId: string, body: Record<string, unknown>, path = publicPath) {
  const ch = (await app.inject({ method: 'GET', url: '/p/consignment/challenge' })).json();
  return app.inject({
    method: 'POST',
    url: `${path}/workshops/${workshopId}/signup`,
    headers: { host: 'shop.example.test', 'x-forwarded-proto': 'https' },
    payload: { ...body, captchaToken: ch.token, captchaSolution: solve(ch.nonce, ch.difficulty) },
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-programme-'));
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
    trustProxy: true,
    logLevel: 'silent',
    mailer: { enabled: true, send: async (m) => (sent.push(m), true) },
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shop@example.test', password: PASSWORD } });
  store = login.json().accessToken;
  storeAccountId = login.json().user.accountId;
  await app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(store), payload: { name: 'Kunsthaus' } });

  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(store), payload: { newAccount: true } });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'ana@example.test', password: PASSWORD, inviteCode: invite.json().code } });
  artist = reg.json().accessToken;
  setEnabled(app.zollify.db, reg.json().user.accountId, 'consignment', true);
  setEnabled(app.zollify.db, reg.json().user.accountId, 'consignment-artist', true);

  await app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: auth(store),
    payload: {
      deviceId: 'd',
      ops: [
        { opId: 'op-0000000000000001', deviceId: 'd', ts: 1, type: 'event.upsert', payload: { id: 'zh', name: 'Zurich shop', kind: 'store', venue: { street: 'Langstrasse 1', city: 'Zurich' }, currency: 'CHF', status: 'active', updatedAt: 1 } },
        { opId: 'op-0000000000000002', deviceId: 'd', ts: 2, type: 'event.upsert', payload: { id: 'fair', name: 'Secret fair', venue: {}, currency: 'CHF', status: 'active', updatedAt: 1 } },
      ],
    },
  });
  await call(store, 'PUT', '/consignors/ana', { name: 'Ana', commissionPct: 40, storeIds: ['zh'] });
  const { code } = (await call(store, 'POST', '/consignors/ana/link-code')).json();
  await call(artist, 'POST', '/links', { code });
  publicPath = (await call(store, 'GET', '/programme')).json().publicPath;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('artist of the month', () => {
  it('features an artist, tells them, and shows it on their side and the public page', async () => {
    sent.length = 0;
    const res = await call(store, 'PUT', '/features/f1', { consignorId: 'ana', storeIds: ['zh'], startDate: day, endDate: addMonths(day, 1), discountPct: 15 });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivery).toMatchObject({ notified: true, emailedTo: 'ana@example.test' });
    expect(sent[0]?.text).toContain('15% off');
    // Saving again with nothing new does not message them twice.
    expect((await call(store, 'PUT', '/features/f1', { consignorId: 'ana', storeIds: ['zh'], startDate: day, endDate: addMonths(day, 1), discountPct: 15, description: 'Prints' })).json().delivery).toBeNull();

    const [link] = (await call(artist, 'GET', '/links')).json().links as ArtistConsignment[];
    expect(link?.features.map((f) => f.id)).toEqual(['f1']);

    const page = (await app.inject({ method: 'GET', url: `${publicPath}/data` })).json() as PublicProgramme;
    expect(page.features[0]).toMatchObject({ artist: 'Ana', title: 'Artist of the month', discountPct: 15, stores: ['Zurich shop'], description: 'Prints' });
    expect(page.name).toBe('Kunsthaus');
  });

  it('refuses a feature that ends before it starts', async () => {
    expect((await call(store, 'PUT', '/features/f2', { consignorId: 'ana', storeIds: ['zh'], startDate: day, endDate: '2000-01-01' })).statusCode).toBe(400);
  });
});

describe('workshops', () => {
  let cancelA = '';

  it('publishes a workshop with its host told', async () => {
    sent.length = 0;
    const res = await call(store, 'PUT', '/workshops/w1', { storeId: 'zh', title: 'Linocut basics', date: day, time: '18:00', durationMin: 90, capacity: 4, price: 45, currency: 'CHF', hostConsignorId: 'ana' });
    expect(res.statusCode).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(['ana@example.test']);
    expect((await call(store, 'PUT', '/workshops/w9', { storeId: 'nowhere', title: 'x', date: day, time: '18:00', capacity: 4, currency: 'CHF' })).statusCode).toBe(400);

    const page = (await app.inject({ method: 'GET', url: `${publicPath}/data` })).json() as PublicProgramme;
    expect(page.workshops[0]).toMatchObject({ title: 'Linocut basics', store: 'Zurich shop', host: 'Ana', seatsLeft: 4, availability: 'open', price: 45 });
    expect(JSON.stringify(page)).not.toMatch(/Secret fair|commission/);
  });

  it('books, then waitlists, and refuses bots, doubles and missing proof', async () => {
    sent.length = 0;
    const a = await signUp('w1', { name: 'Alex', email: 'alex@example.test', seats: 3 });
    expect(a.json()).toMatchObject({ status: 'booked', seats: 3, emailed: true });
    cancelA = a.json().cancelPath.split('#')[1];
    expect(sent[0]).toMatchObject({ to: 'alex@example.test', subject: "You're booked: Linocut basics", replyTo: 'shop@example.test' });
    expect(sent[0]?.text).toContain(`https://shop.example.test/p/consignment/cancel#${cancelA}`);
    expect(sent[0]?.ics).toContain('SUMMARY:Linocut basics');

    const b = await signUp('w1', { name: 'Bo', email: 'bo@example.test', seats: 2 });
    expect(b.json().status).toBe('waitlist');
    expect((await signUp('w1', { name: 'Bo', email: 'BO@example.test', seats: 1 })).statusCode).toBe(409);

    // The honeypot answers like a success and stores nothing.
    expect((await signUp('w1', { name: 'Bot', email: 'bot@example.test', website: 'http://spam' })).statusCode).toBe(200);
    const noProof = await app.inject({ method: 'POST', url: `${publicPath}/workshops/w1/signup`, payload: { name: 'X', email: 'x@example.test' } });
    expect(noProof.statusCode).toBe(403);

    const list = (await call(store, 'GET', '/workshops/w1/signups')).json().signups as Signup[];
    expect(list.map((s) => [s.name, s.status, s.seats])).toEqual([['Alex', 'booked', 3], ['Bo', 'waitlist', 2]]);
    const bell = (await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(store) })).json();
    expect(bell.notifications[0].title).toBe('Bo joined the waitlist for Linocut basics');
  });

  it('cancelling by link frees the seats and moves the waitlist up', async () => {
    const look = await app.inject({ method: 'POST', url: '/p/consignment/cancel', payload: { token: cancelA } });
    expect(look.json()).toMatchObject({ title: 'Linocut basics', status: 'booked', seats: 3 });
    sent.length = 0;
    const done = await app.inject({ method: 'POST', url: '/p/consignment/cancel', payload: { token: cancelA, confirm: true } });
    expect(done.json().status).toBe('cancelled');
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ['alex@example.test', "You've cancelled: Linocut basics"],
      ['bo@example.test', "A place opened up - you're booked: Linocut basics"],
    ]);
    expect((await app.inject({ method: 'POST', url: '/p/consignment/cancel', payload: { token: 'A'.repeat(22) } })).statusCode).toBe(404);
  });

  it('lets the store book someone, mark them paid, and not shrink below what is booked', async () => {
    const add = await call(store, 'POST', '/workshops/w1/signups', { name: 'Walk-in', seats: 2 });
    expect(add.json()).toMatchObject({ signup: { status: 'booked', source: 'store' }, emailed: false });
    const paid = await call(store, 'PUT', `/signups/${add.json().signup.id}`, { paid: true });
    expect(paid.json().signup.paid).toBe(true);
    expect((await call(store, 'PUT', '/workshops/w1', { storeId: 'zh', title: 'Linocut basics', date: day, time: '18:00', capacity: 3, currency: 'CHF' })).statusCode).toBe(409);
    expect((await call(store, 'GET', '/programme')).json().workshops[0]).toMatchObject({ booked: 4, waiting: 0 });
  });

  it('cancelling the workshop tells everyone; it cannot then be deleted', async () => {
    sent.length = 0;
    const res = await call(store, 'POST', '/workshops/w1/cancel');
    expect(res.json().told).toBe(1); // Bo; the walk-in left no address
    expect(sent[0]?.subject).toBe('Cancelled: Linocut basics');
    expect((await call(store, 'DELETE', '/workshops/w1')).statusCode).toBe(409);
    expect(((await app.inject({ method: 'GET', url: `${publicPath}/data` })).json() as PublicProgramme).workshops).toEqual([]);
  });

  it('a new link retires the old one, and switching the module off closes the page', async () => {
    const old = publicPath;
    publicPath = (await call(store, 'POST', '/programme/link')).json().publicPath;
    expect((await app.inject({ method: 'GET', url: `${old}/data` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `${publicPath}/data` })).statusCode).toBe(200);
    setEnabled(app.zollify.db, storeAccountId, 'consignment', false);
    expect((await app.inject({ method: 'GET', url: `${publicPath}/data` })).statusCode).toBe(404);
    setEnabled(app.zollify.db, storeAccountId, 'consignment', true);
  setEnabled(app.zollify.db, storeAccountId, 'consignment-artist', true);
  });

  it('serves the page and its script without data in them', async () => {
    const page = await app.inject({ method: 'GET', url: publicPath });
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('/p/consignment/programme.js');
    const script = await app.inject({ method: 'GET', url: '/p/consignment/programme.js' });
    expect(script.body).toContain('function solve(');
  });
});

describe('paying for a workshop at the till', () => {
  let signupId = '';
  const sale = (opId: string, type: string, payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(store), payload: { deviceId: 'till', ops: [{ opId, deviceId: 'till', ts: 1, type, payload }] } });

  it('lists who still owes, for the store the till is at', async () => {
    await call(store, 'PUT', '/workshops/w2', { storeId: 'zh', title: 'Bookbinding', date: day, time: '10:00', capacity: 6, price: 50, currency: 'CHF', hostConsignorId: 'ana', hostSharePct: 70 });
    signupId = (await call(store, 'POST', '/workshops/w2/signups', { name: 'Kim', seats: 2 })).json().signup.id;
    const res = (await call(store, 'GET', '/till/workshops?storeId=zh')).json();
    const w2 = res.workshops.find((w: { id: string }) => w.id === 'w2');
    expect(w2.unpaid.map((s: Signup) => s.name)).toEqual(['Kim']);
    expect((await call(store, 'GET', '/till/workshops?storeId=fair')).json().workshops).toEqual([]);
  });

  it('a sale referring to the sign-up pays it, and gives the host their share', async () => {
    await sale('op-till-sale-00000001', 'tx.create', {
      id: 'tw1',
      eventId: 'zh',
      deviceId: 'till',
      timestamp: Date.now(),
      method: 'cash',
      payments: [],
      items: [{ pid: 'module:signup:x', vid: null, title: 'Bookbinding · Kim', qty: 2, unitPrice: 50, lineTotal: 100, consignorId: 'ana', commissionPct: 30, ref: { moduleId: 'consignment', kind: 'workshop-signup', id: signupId } }],
      discounts: [],
      total: 100,
      currency: 'CHF',
    });
    const w2 = (await call(store, 'GET', '/till/workshops?storeId=zh')).json().workshops.find((w: { id: string }) => w.id === 'w2');
    expect(w2.unpaid).toEqual([]);
    const list = (await call(store, 'GET', '/workshops/w2/signups')).json().signups as Signup[];
    expect(list[0]).toMatchObject({ name: 'Kim', paid: false, paidAtTill: true });

    const ana = (await call(store, 'GET', '/statement')).json().statements.find((s: { consignorId: string }) => s.consignorId === 'ana');
    expect(ana.totals[0]).toMatchObject({ gross: 100, commission: 30, artistShare: 70 });
  });

  it('a refund at the till un-pays it again', async () => {
    await sale('op-till-revert-0000001', 'tx.revert', { id: 'tw1', revertedAt: Date.now() });
    const list = (await call(store, 'GET', '/workshops/w2/signups')).json().signups as Signup[];
    expect(list[0]?.paidAtTill).toBe(false);
  });
});
