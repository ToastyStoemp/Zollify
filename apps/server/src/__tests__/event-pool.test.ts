import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled } from '@zollify/server-core';
import { publicEventsServerModule } from '../modules/public-events';

/**
 * The pool is the one place event data crosses accounts, so the tests are
 * about what may and may not cross: only the picked facts, merged on a match,
 * withdrawable, bounded, and rate limited.
 */

const PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;
let ana: string;
let ben: string;
let seq = 0;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const pool = (t: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, payload?: unknown) =>
  app.inject({ method, url: `/api/m/public-events/pool${path}`, headers: auth(t), payload: payload as object });

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
}

const convention = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: 'Harbour Con',
  dateStart: '2099-05-01',
  dateEnd: '2099-05-03',
  venue: { street: '1 Dock Rd', postcode: '8000', city: 'Zürich', country: 'Switzerland' },
  notes: 'SECRET stand number 12',
  vat: { rate: 8.1 },
  ...over,
});

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

  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(ana), payload: { newAccount: true } });
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'ben@example.test', password: PASSWORD, inviteCode: invite.json().code, accountName: 'Ben Pins' },
  });
  ben = reg.json().accessToken;
  setEnabled(app.zollify.db, reg.json().user.accountId, 'public-events', true);

  await pushEvent(ana, convention('a1'));
  await pushEvent(ben, convention('b1', { name: '  harbour  CON ', venue: { city: 'zurich', country: 'Switzerland' } }));
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
  delete process.env.OWNER_EMAIL;
  delete process.env.OWNER_PASSWORD;
});

describe('shared event pool', () => {
  it('publishes only the picked public facts', async () => {
    const res = await pool(ana, 'PUT', '/share', {
      eventId: 'a1',
      edition: '2099',
      venueName: 'Harbour Hall',
      url: 'https://harbourcon.example/tickets',
      description: 'Prints and pins.',
      // Anything else a client tries to send is ignored, never stored.
      notes: 'leak',
      name: 'Hijacked name',
    });
    expect(res.statusCode).toBe(200);
    const listing = res.json().listing;
    expect(listing).toMatchObject({ name: 'Harbour Con', city: 'Zürich', dateStart: '2099-05-01', going: 1, mine: true, names: [] });
    expect(JSON.stringify(listing)).not.toMatch(/SECRET|leak|Hijacked|8\.1|a1/);
    // The opposite account never sees the contributor's own event id or account.
    const seen = (await pool(ben, 'GET', '/listings')).json().listings[0];
    expect(Object.keys(seen).sort()).toEqual(
      ['added', 'city', 'country', 'dateEnd', 'dateStart', 'description', 'edition', 'going', 'id', 'mine', 'name', 'names', 'postcode', 'street', 'updatedAt', 'url', 'venueName'],
    );
  });

  it('merges a matching share into one listing and counts, without names unless opted in', async () => {
    const res = await pool(ben, 'PUT', '/share', { eventId: 'b1', displayName: 'Ben Pins' });
    expect(res.statusCode).toBe(200);
    expect(res.json().listing.going).toBe(2);
    expect(res.json().listing.names).toEqual(['Ben Pins']);

    const all = (await pool(ana, 'GET', '/listings?includeAdded=1')).json().listings;
    expect(all).toHaveLength(1);
    expect(all[0].going).toBe(2);
    expect(all[0].names).toEqual(['Ben Pins']);
  });

  it('hides listings the caller already shares from their own search, and offers them to others only', async () => {
    expect((await pool(ana, 'GET', '/listings')).json().listings).toHaveLength(0);
    await pool(ana, 'DELETE', '/share/a1');
    await pool(ben, 'DELETE', '/share/b1');
    expect((await pool(ana, 'GET', '/listings?includeAdded=1')).json().listings).toHaveLength(0);
  });

  it('refuses unsafe links, markup and bad shapes', async () => {
    for (const payload of [
      { eventId: 'a1', url: 'http://plain.example' },
      { eventId: 'a1', url: 'javascript:alert(1)' },
      { eventId: 'a1', description: '<img src=x onerror=alert(1)>' },
      { eventId: 'a1', edition: 'x'.repeat(61) },
      { eventId: 'a1', displayName: '<b>me</b>' },
    ]) {
      expect((await pool(ana, 'PUT', '/share', payload)).statusCode).toBe(400);
    }
    expect((await pool(ana, 'PUT', '/share', { eventId: 'nope' })).statusCode).toBe(404);
  });

  it('refuses events without usable dates or a city, and over-long runs', async () => {
    await pushEvent(ana, convention('nodates', { dateStart: undefined, dateEnd: undefined }));
    await pushEvent(ana, convention('nocity', { venue: {} }));
    await pushEvent(ana, convention('backwards', { dateStart: '2099-05-03', dateEnd: '2099-05-01' }));
    await pushEvent(ana, convention('year', { dateStart: '2099-01-01', dateEnd: '2099-12-31' }));
    for (const id of ['nodates', 'nocity', 'backwards', 'year']) {
      expect((await pool(ana, 'PUT', '/share', { eventId: id })).statusCode, id).toBe(400);
    }
  });

  it('lets the contributor edit, and withdrawing the last contributor removes the listing', async () => {
    await pool(ana, 'PUT', '/share', { eventId: 'a1', description: 'First' });
    const edited = await pool(ana, 'PUT', '/share', { eventId: 'a1', description: 'Second' });
    expect(edited.json().listing).toMatchObject({ description: 'Second', going: 1 });
    expect((await pool(ana, 'GET', '/mine')).json().shared).toHaveLength(1);

    // Renaming the event moves the contribution to a new listing and drops the old one.
    await pushEvent(ana, convention('a1', { name: 'Renamed Con' }));
    const moved = await pool(ana, 'PUT', '/share', { eventId: 'a1' });
    expect(moved.json().listing.name).toBe('Renamed Con');
    const all = (await pool(ben, 'GET', '/listings')).json().listings;
    expect(all.map((l: { name: string }) => l.name)).toEqual(['Renamed Con']);

    expect((await pool(ana, 'DELETE', '/share/a1')).statusCode).toBe(200);
    expect((await pool(ben, 'GET', '/listings')).json().listings).toHaveLength(0);
    expect((await pool(ana, 'DELETE', '/share/a1')).statusCode).toBe(404);
  });

  it('only the contributor can withdraw: another account cannot touch the listing', async () => {
    await pool(ana, 'PUT', '/share', { eventId: 'a1' });
    expect((await pool(ben, 'DELETE', '/share/a1')).statusCode).toBe(404);
    expect((await pool(ben, 'GET', '/listings')).json().listings).toHaveLength(1);
  });

  it('searches by text, city, country and date range, upcoming first', async () => {
    await pushEvent(ana, convention('soon', { name: 'Alpine Fair', dateStart: '2098-01-10', dateEnd: '2098-01-11', venue: { city: 'Bern', country: 'Switzerland' } }));
    await pushEvent(ana, convention('old', { name: 'Old Fair', dateStart: '2001-03-01', dateEnd: '2001-03-02', venue: { city: 'Bern', country: 'Switzerland' } }));
    await pushEvent(ana, convention('de', { name: 'Messe', dateStart: '2098-06-01', dateEnd: '2098-06-02', venue: { city: 'Köln', country: 'Germany' } }));
    for (const id of ['soon', 'old', 'de']) expect((await pool(ana, 'PUT', '/share', { eventId: id })).statusCode).toBe(200);

    const names = async (qs: string) => (await pool(ben, 'GET', `/listings${qs}`)).json().listings.map((l: { name: string }) => l.name);
    expect(await names('')).toEqual(['Alpine Fair', 'Messe', 'Renamed Con']);
    expect(await names('?past=1')).toEqual(['Alpine Fair', 'Messe', 'Renamed Con', 'Old Fair']);
    expect(await names('?q=fair')).toEqual(['Alpine Fair']);
    expect(await names('?city=bern')).toEqual(['Alpine Fair']);
    expect(await names('?country=germany')).toEqual(['Messe']);
    expect(await names('?from=2098-05-01&to=2098-12-31')).toEqual(['Messe']);
    // LIKE wildcards in the query are literal.
    expect(await names('?q=%25')).toEqual([]);
    expect((await pool(ben, 'GET', '/listings?from=nonsense')).statusCode).toBe(400);
  });

  it('remembers a quick-add so the listing is not offered twice', async () => {
    const listing = (await pool(ben, 'GET', '/listings?q=alpine')).json().listings[0];
    expect((await pool(ben, 'POST', `/listings/${listing.id}/adopt`, { eventId: 'new-1' })).statusCode).toBe(200);
    expect((await pool(ben, 'GET', '/listings?q=alpine')).json().listings).toHaveLength(0);
    const again = (await pool(ben, 'GET', '/listings?q=alpine&includeAdded=1')).json().listings[0];
    expect(again.added).toBe(true);
    expect((await pool(ana, 'GET', '/listings?q=alpine&includeAdded=1')).json().listings[0].added).toBe(false);
    expect((await pool(ben, 'POST', '/listings/missing/adopt', { eventId: 'x' })).statusCode).toBe(404);
  });

  it('stores reports, one per account, and hides a listing once enough accounts flag it', async () => {
    const listing = (await pool(ben, 'GET', '/listings?q=messe')).json().listings[0];
    expect((await pool(ben, 'POST', `/listings/${listing.id}/report`, { reason: 'bogus' })).statusCode).toBe(400);
    const report = { reason: 'spam', note: 'not real' };
    expect((await pool(ben, 'POST', `/listings/${listing.id}/report`, report)).statusCode).toBe(200);
    expect((await pool(ben, 'POST', `/listings/${listing.id}/report`, report)).statusCode).toBe(200);
    const flags = app.zollify.db.prepare('SELECT COUNT(*) AS n FROM event_pool_flags WHERE listingId = ?').get(listing.id) as { n: number };
    expect(flags.n).toBe(1);
    expect((await pool(ben, 'GET', '/listings?q=messe')).json().listings).toHaveLength(1);

    for (const who of ['c', 'd']) {
      app.zollify.db.prepare('INSERT INTO event_pool_flags (listingId, accountId, reason, note, createdAt) VALUES (?, ?, ?, ?, ?)').run(listing.id, who, 'spam', '', 1);
    }
    expect((await pool(ben, 'GET', '/listings?q=messe')).json().listings).toHaveLength(0);
  });

  it('rate limits publishing per account', async () => {
    let limited = 0;
    for (let i = 0; i < 25; i += 1) {
      const res = await pool(ben, 'PUT', '/share', { eventId: 'b1', description: `edit ${i}` });
      if (res.statusCode === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    // Another account is not affected.
    expect((await pool(ana, 'PUT', '/share', { eventId: 'a1', description: 'still fine' })).statusCode).toBe(200);
  });

  it('is behind the module gate and needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/m/public-events/pool/listings' });
    expect(res.statusCode).toBe(401);
  });
});
