import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled } from '@zollify/server-core';
import { migrateEventPool } from '../modules/event-pool';
import { publicEventsServerModule } from '../modules/public-events';

/**
 * The pool is the one place event data crosses accounts, so the tests are
 * about what may and may not cross: nothing until the account agrees, then
 * only public event facts, kept in step with the account's events, withdrawn
 * when it stops - and never anything about who shares, adopts or goes.
 */

const PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;
let ana: string;
let ben: string;
let cleo: string;
let seq = 0;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const pool = (t: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, payload?: unknown) =>
  app.inject({ method, url: `/api/m/public-events/pool${path}`, headers: auth(t), payload: payload as object });
const setSharing = (t: string, share: boolean) => pool(t, 'PUT', '/settings', { share });
const names = async (t: string, qs = '') => (await pool(t, 'GET', `/listings${qs}`)).json().listings.map((l: { name: string }) => l.name);
const contribs = () => (app.zollify.db.prepare('SELECT COUNT(*) AS n FROM event_pool_contribs').get() as { n: number }).n;

async function pushEvent(token: string, ev: Record<string, unknown>) {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: auth(token),
    payload: {
      deviceId: `dev-${token.slice(-6)}`,
      ops: [
        {
          opId: `op-${String(seq).padStart(16, '0')}`,
          deviceId: `dev-${token.slice(-6)}`,
          ts: seq,
          type: 'event.upsert',
          payload: { currency: 'CHF', status: 'planned', updatedAt: seq, ...ev },
        },
      ],
    },
  });
  expect(res.statusCode).toBe(200);
  // Modules follow pushed ops on the next turn, so a push settles before the test looks.
  await new Promise((r) => setImmediate(r));
}

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const convention = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: 'Harbour Con',
  dateStart: '2099-05-01',
  dateEnd: '2099-05-03',
  venue: { street: '1 Dock Rd', postcode: '8000', city: 'Zürich', country: 'Switzerland' },
  notes: 'SECRET stand number 12',
  vat: { rate: 8.1 },
  booth: { hall: 'HALL-9', number: 'BOOTH-77', link: 'https://harbourcon.example/tickets', note: 'Prints and pins.' },
  attachments: [{ id: 'att1', name: 'ticket.pdf' }],
  ...over,
});

async function register(email: string, accountName: string): Promise<string> {
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(ana), payload: { newAccount: true } });
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: PASSWORD, inviteCode: invite.json().code, accountName },
  });
  setEnabled(app.zollify.db, reg.json().user.accountId, 'public-events', true);
  return reg.json().accessToken;
}

// Listing ids are random, so a short pattern can match inside one by chance.
// Leak checks look at everything but the ids.
const withoutIds = (body: string): string => JSON.stringify(JSON.parse(body), (k, v) => (k === 'id' ? undefined : v));

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-pool-'));
  process.env.OWNER_EMAIL = 'ana@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [publicEventsServerModule],
    defaultModules: ['public-events'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ana@example.test', password: PASSWORD } });
  ana = login.json().accessToken;
  ben = await register('ben@example.test', 'Ben Pins');
  cleo = await register('cleo@example.test', 'Cleo Prints');

  // Ana and Ben both have the same convention, entered their own way.
  await pushEvent(ana, convention('a1'));
  await pushEvent(ben, convention('b1', { name: '  harbour  CON ', venue: { city: 'zurich', country: 'Switzerland' }, booth: undefined }));
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
  delete process.env.OWNER_EMAIL;
  delete process.env.OWNER_PASSWORD;
});

describe('shared event pool', () => {
  it('shares nothing until the account agrees, and the default is off', async () => {
    expect((await pool(ana, 'GET', '/settings')).json()).toEqual({ share: false });
    expect(contribs()).toBe(0);
    expect(await names(cleo, '?includeAdded=1')).toEqual([]);
    // New events pushed while off stay private too.
    await pushEvent(ana, convention('a-new', { name: 'Later Con' }));
    expect(contribs()).toBe(0);
    expect(await names(cleo)).toEqual([]);
  });

  it('shares only the public facts, only for events with a name, dates and a place', async () => {
    await pushEvent(ana, convention('store1', { name: 'Old Town Shop', kind: 'store', dateStart: undefined, dateEnd: undefined }));
    await pushEvent(ana, convention('nodates', { name: 'No Dates Con', dateStart: undefined, dateEnd: undefined }));
    await pushEvent(ana, convention('noplace', { name: 'Nowhere Con', venue: {} }));
    await pushEvent(ana, convention('backwards', { name: 'Backwards Con', dateStart: '2099-05-03', dateEnd: '2099-05-01' }));
    await pushEvent(ana, convention('year', { name: 'Year Con', dateStart: '2099-01-01', dateEnd: '2099-12-31' }));
    await pushEvent(ana, convention('countryonly', { name: 'Country Con', dateStart: '2099-07-01', dateEnd: '2099-07-02', venue: { country: 'Germany' } }));

    expect((await setSharing(ana, true)).json()).toEqual({ share: true });
    expect(await names(cleo)).toEqual(['Harbour Con', 'Later Con', 'Country Con']);

    const res = await pool(cleo, 'GET', '/listings?q=harbour');
    const [seen] = res.json().listings;
    expect(seen).toEqual({
      id: expect.any(String),
      name: 'Harbour Con',
      edition: '',
      venueName: '',
      street: '1 Dock Rd',
      postcode: '8000',
      city: 'Zürich',
      country: 'Switzerland',
      dateStart: '2099-05-01',
      dateEnd: '2099-05-03',
      url: 'https://harbourcon.example/tickets',
      description: 'Prints and pins.',
      added: false,
    });
    // Costs, notes, booth hall and number, attachments, ids: none of it is in any response.
    expect(withoutIds(res.body)).not.toMatch(/SECRET|8\.1|HALL-9|BOOTH-77|ticket\.pdf|att1|ana@|Ben|accountId/);
  });

  it('shows no contributor count, name, id or timestamp anywhere', async () => {
    const bodies = [
      (await pool(cleo, 'GET', '/listings?includeAdded=1&past=1')).body,
      (await pool(ana, 'GET', '/listings?includeAdded=1&past=1')).body,
      (await pool(ana, 'GET', '/settings')).body,
    ].map(withoutIds).join('\n');
    expect(bodies).not.toMatch(/going|\bnames\b|displayName|\bcount\b|\bmine\b|updatedAt|contrib|accountId/i);
  });

  it('turns two accounts sharing the same event into one identical listing', async () => {
    const before = (await pool(cleo, 'GET', '/listings?q=harbour')).body;
    // Ana's own view of her listing, once Ben joins, must match what everyone saw before.
    await setSharing(ben, true);
    expect(contribs()).toBeGreaterThanOrEqual(2);
    const after = (await pool(cleo, 'GET', '/listings?q=harbour')).body;
    expect(after).toBe(before);
    expect(JSON.parse(after).listings).toHaveLength(1);
    // Ben's different record (no street, no link) does not change what the listing shows.
    const anasView = (await pool(ana, 'GET', '/listings?q=harbour&includeAdded=1')).json();
    const bensView = (await pool(ben, 'GET', '/listings?q=harbour&includeAdded=1')).json();
    expect(anasView).toEqual(bensView);
    expect(anasView.listings).toHaveLength(1);
    expect(anasView.listings[0].street).toBe('1 Dock Rd');
    // Withdrawing one of two leaves the listing, unchanged, with no sign anyone left.
    await setSharing(ben, false);
    expect((await pool(cleo, 'GET', '/listings?q=harbour')).body).toBe(before);
    expect(await names(ana, '?includeAdded=1&q=harbour')).toEqual(['Harbour Con']);
  });

  it('keeps search order and paging independent of how many accounts share', async () => {
    await pushEvent(ana, convention('soon', { name: 'Alpine Fair', dateStart: '2098-01-10', dateEnd: '2098-01-11', venue: { city: 'Bern', country: 'Switzerland' } }));
    await pushEvent(ana, convention('de', { name: 'Messe', dateStart: '2098-06-01', dateEnd: '2098-06-02', venue: { city: 'Köln', country: 'Germany' } }));
    await pushEvent(ana, convention('recent', { name: 'Recent Fair', dateStart: iso(-12), dateEnd: iso(-10), venue: { city: 'Bern', country: 'Switzerland' } }));
    await pushEvent(ana, convention('ancient', { name: 'Ancient Fair', dateStart: '2001-03-01', dateEnd: '2001-03-02', venue: { city: 'Bern', country: 'Switzerland' } }));
    const order = await names(cleo);
    // Ben shares everything Ana does, plus Messe twice over; the order must not move.
    await pushEvent(ben, convention('b-messe', { name: 'Messe', dateStart: '2098-06-01', dateEnd: '2098-06-02', venue: { city: 'Köln', country: 'Germany' } }));
    await pushEvent(ben, convention('b-alpine', { name: 'Alpine Fair', dateStart: '2098-01-10', dateEnd: '2098-01-11', venue: { city: 'Bern', country: 'Switzerland' } }));
    await setSharing(ben, true);
    expect(await names(cleo)).toEqual(order);
    expect(order).toEqual(['Alpine Fair', 'Messe', 'Harbour Con', 'Later Con', 'Country Con']);

    // Past, recent only: events that ended long ago are not shared at all.
    expect(await names(cleo, '?past=1')).toEqual([...order, 'Recent Fair']);
    expect(await names(cleo, '?q=fair')).toEqual(['Alpine Fair']);
    expect(await names(cleo, '?city=bern')).toEqual(['Alpine Fair']);
    expect(await names(cleo, '?country=germany')).toEqual(['Messe', 'Country Con']);
    expect(await names(cleo, '?from=2098-05-01&to=2098-12-31')).toEqual(['Messe']);
    expect(await names(cleo, '?q=%25')).toEqual([]);
    expect((await pool(cleo, 'GET', '/listings?from=nonsense')).statusCode).toBe(400);

    const page1 = (await pool(cleo, 'GET', '/listings?limit=2')).json();
    const page2 = (await pool(cleo, 'GET', '/listings?limit=2&offset=2')).json();
    const page3 = (await pool(cleo, 'GET', '/listings?limit=2&offset=4')).json();
    expect([page1.more, page2.more, page3.more]).toEqual([true, true, false]);
    expect([...page1.listings, ...page2.listings, ...page3.listings].map((l: { name: string }) => l.name)).toEqual(order);
    await setSharing(ben, false);
  });

  it('lets one event opt out, even while the account shares', async () => {
    await pushEvent(ana, convention('private', { name: 'Invite Only Con', noPool: true }));
    expect(await names(cleo, '?q=invite')).toEqual([]);
    await pushEvent(ana, convention('private', { name: 'Invite Only Con' }));
    expect(await names(cleo, '?q=invite')).toEqual(['Invite Only Con']);
    // Opting out again withdraws it.
    await pushEvent(ana, convention('private', { name: 'Invite Only Con', noPool: true }));
    expect(await names(cleo, '?q=invite')).toEqual([]);
  });

  it('follows an event that changes, and withdraws it when it is deleted', async () => {
    await pushEvent(ana, convention('moving', { name: 'Moving Con', dateStart: '2097-03-01', dateEnd: '2097-03-02' }));
    expect(await names(cleo, '?q=moving')).toEqual(['Moving Con']);

    await pushEvent(ana, convention('moving', { name: 'Moving Con', dateStart: '2097-03-05', dateEnd: '2097-03-06', booth: { link: 'https://moving.example/new' } }));
    const [moved] = (await pool(cleo, 'GET', '/listings?q=moving')).json().listings;
    expect(moved).toMatchObject({ dateStart: '2097-03-05', url: 'https://moving.example/new', description: '' });
    expect((await pool(cleo, 'GET', '/listings?q=moving')).json().listings).toHaveLength(1);

    await pushEvent(ana, convention('moving', { name: 'Moving Con Renamed', dateStart: '2097-03-05', dateEnd: '2097-03-06' }));
    expect(await names(cleo, '?q=moving')).toEqual(['Moving Con Renamed']);

    await pushEvent(ana, convention('moving', { name: 'Moving Con Renamed', dateStart: '2097-03-05', dateEnd: '2097-03-06', deletedAt: Date.now() }));
    expect(await names(cleo, '?q=moving')).toEqual([]);
    expect(app.zollify.db.prepare("SELECT COUNT(*) AS n FROM event_pool_listings WHERE name LIKE 'Moving%'").get()).toEqual({ n: 0 });
  });

  it('is idempotent: reopening the screen changes nothing', async () => {
    const snapshot = () => JSON.stringify(app.zollify.db.prepare('SELECT * FROM event_pool_contribs ORDER BY rowid').all());
    const before = snapshot();
    await pool(ana, 'GET', '/settings');
    await setSharing(ana, true);
    expect(snapshot()).toBe(before);
  });

  it('withdraws everything at once when sharing is turned off, and stays off', async () => {
    expect(contribs()).toBeGreaterThan(0);
    expect((await setSharing(ana, false)).json()).toEqual({ share: false });
    expect(contribs()).toBe(0);
    expect(await names(cleo, '?past=1')).toEqual([]);
    await pushEvent(ana, convention('after-off', { name: 'After Off Con' }));
    expect(contribs()).toBe(0);
    expect((await pool(ana, 'GET', '/settings')).json()).toEqual({ share: false });
  });

  it('keeps Find events and quick-add open to an account that does not share', async () => {
    await setSharing(ana, true);
    const listing = (await pool(cleo, 'GET', '/listings?q=alpine')).json().listings[0];
    expect(listing.name).toBe('Alpine Fair');
    expect((await pool(cleo, 'GET', '/settings')).json()).toEqual({ share: false });
    expect((await pool(cleo, 'POST', `/listings/${listing.id}/adopt`, { eventId: 'new-1' })).statusCode).toBe(200);
    expect(await names(cleo, '?q=alpine')).toEqual([]);
    expect((await pool(cleo, 'GET', '/listings?q=alpine&includeAdded=1')).json().listings[0].added).toBe(true);
    expect(contribs()).toBeGreaterThan(0);
    expect((await pool(cleo, 'POST', '/listings/missing/adopt', { eventId: 'x' })).statusCode).toBe(404);
  });

  it('never lets one account see that another quick-added', async () => {
    const view = async (t: string) => (await pool(t, 'GET', '/listings?past=1&includeAdded=1')).body;
    const benBefore = await view(ben);
    const listing = (await pool(ben, 'GET', '/listings?q=messe')).json().listings[0];
    const anaBefore = await view(ana);
    expect((await pool(ben, 'POST', `/listings/${listing.id}/adopt`, { eventId: 'new-2' })).statusCode).toBe(200);
    // Ana and Cleo see exactly what they saw; only Ben's own copy says "added".
    expect(await view(ana)).toBe(anaBefore);
    const cleoView = JSON.parse(await view(cleo));
    expect(cleoView.listings.find((l: { id: string }) => l.id === listing.id).added).toBe(false);
    expect(JSON.parse(await view(ben)).listings.find((l: { id: string }) => l.id === listing.id).added).toBe(true);
    expect(JSON.parse(benBefore).listings.find((l: { id: string }) => l.id === listing.id).added).toBe(false);
  });

  it('stores reports, one per account, and hides a listing once enough accounts flag it', async () => {
    const listing = (await pool(cleo, 'GET', '/listings?q=messe')).json().listings[0];
    expect((await pool(cleo, 'POST', `/listings/${listing.id}/report`, { reason: 'bogus' })).statusCode).toBe(400);
    const report = { reason: 'spam', note: 'not real' };
    expect((await pool(cleo, 'POST', `/listings/${listing.id}/report`, report)).statusCode).toBe(200);
    expect((await pool(cleo, 'POST', `/listings/${listing.id}/report`, report)).statusCode).toBe(200);
    const flags = app.zollify.db.prepare('SELECT COUNT(*) AS n FROM event_pool_flags WHERE listingId = ?').get(listing.id) as { n: number };
    expect(flags.n).toBe(1);
    expect(await names(cleo, '?q=messe')).toHaveLength(1);

    for (const who of ['c', 'd']) {
      app.zollify.db.prepare('INSERT INTO event_pool_flags (listingId, accountId, reason, note, createdAt) VALUES (?, ?, ?, ?, ?)').run(listing.id, who, 'spam', '', 1);
    }
    expect(await names(cleo, '?q=messe')).toHaveLength(0);
  });

  it('rate limits consent changes per account and refuses a bad body', async () => {
    expect((await pool(ben, 'PUT', '/settings', { share: 'yes' })).statusCode).toBe(400);
    let limited = 0;
    for (let i = 0; i < 25; i += 1) {
      if ((await setSharing(ben, i % 2 === 0)).statusCode === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    // Another account is not affected.
    expect((await setSharing(cleo, false)).statusCode).toBe(200);
  });

  it('has no per-event share routes or display names any more', async () => {
    expect((await pool(ana, 'PUT', '/share', { eventId: 'a1' })).statusCode).toBe(404);
    expect((await pool(ana, 'GET', '/mine')).statusCode).toBe(404);
  });

  it('is behind the module gate and needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/m/public-events/pool/listings' });
    expect(res.statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/m/public-events/pool/settings', payload: { share: true } })).statusCode).toBe(401);
  });
});

describe('event pool migration', () => {
  it('drops stored display names and withdraws contributions made without account-level consent', () => {
    const db = new Database(':memory:');
    migrateEventPool(db);
    db.exec(`
      DROP TABLE event_pool_contribs;
      CREATE TABLE event_pool_contribs (accountId TEXT NOT NULL, eventId TEXT NOT NULL, listingId TEXT NOT NULL,
        displayName TEXT NOT NULL DEFAULT '', facts TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY (accountId, eventId));
      INSERT INTO event_pool_listings (id, dedupeKey, name, dateStart, dateEnd, updatedAt) VALUES ('l1', 'k', 'Old', '2099-01-01', '2099-01-02', 1);
      INSERT INTO event_pool_contribs VALUES ('acc', 'e1', 'l1', 'Ben Pins', '{}', 1);
      INSERT INTO event_pool_settings VALUES ('other', 1, 1);
    `);
    migrateEventPool(db);
    const cols = (db.prepare('PRAGMA table_info(event_pool_contribs)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('displayName');
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_pool_contribs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_pool_listings').get()).toEqual({ n: 0 });
    db.close();
  });

  it('keeps contributions of an account that has agreed', () => {
    const db = new Database(':memory:');
    migrateEventPool(db);
    db.exec(`
      INSERT INTO event_pool_settings VALUES ('acc', 1, 1);
      INSERT INTO event_pool_listings (id, dedupeKey, name, dateStart, dateEnd, updatedAt) VALUES ('l1', 'k', 'Kept', '2099-01-01', '2099-01-02', 1);
      INSERT INTO event_pool_contribs (accountId, eventId, listingId, facts, updatedAt) VALUES ('acc', 'e1', 'l1', '{}', 1);
    `);
    migrateEventPool(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_pool_contribs').get()).toEqual({ n: 1 });
    db.close();
  });
});
