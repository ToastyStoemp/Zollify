import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled, type MailMessage } from '@zollify/server-core';
import { addMonths, type ArtistConsignment, type AppNotification } from '@zollify/shared';
import { consignmentServerModule } from '../modules/consignment';

/**
 * The planner tells people things, so besides the bookkeeping the tests pin
 * who hears what: the artist's linked account and inbox when a setup is
 * booked, the store when the artist answers, and nobody else.
 */

const PASSWORD = 'correct horse battery staple';
const sent: MailMessage[] = [];

let app: FastifyInstance;
let dataDir: string;
let store: string;
let artist: string;
let helper: string; // a member of the store account
let storeAccountId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (t: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/consignment${url}`, headers: auth(t), ...(payload ? { payload } : {}) });
const bell = async (t: string) =>
  (await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(t) })).json() as { notifications: AppNotification[]; unread: number };
const today = new Date().toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 7)}-01`;

async function register(email: string, payload: Record<string, unknown>): Promise<{ token: string; accountId: string }> {
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(store), payload });
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: PASSWORD, inviteCode: invite.json().code, accountName: 'Ana Prints' } });
  return { token: res.json().accessToken, accountId: res.json().user.accountId };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-planner-'));
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

  const a = await register('ana@example.test', { newAccount: true });
  artist = a.token;
  setEnabled(app.zollify.db, a.accountId, 'consignment', true);
  helper = (await register('helper@example.test', { role: 'member' })).token;

  await app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: auth(store),
    payload: {
      deviceId: 'd',
      ops: [
        {
          opId: 'op-0000000000000001',
          deviceId: 'd',
          ts: 1,
          type: 'event.upsert',
          payload: { id: 'zh', name: 'Zurich shop', kind: 'store', venue: { street: 'Langstrasse 1', postcode: '8004', city: 'Zurich' }, currency: 'CHF', status: 'active', updatedAt: 1 },
        },
      ],
    },
  });
  await call(store, 'PUT', '/consignors/ana', { name: 'Ana', email: 'ana.studio@example.test', commissionPct: 40, storeIds: ['zh'] });
  const { code } = (await call(store, 'POST', '/consignors/ana/link-code')).json();
  await call(artist, 'POST', '/links', { code });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('consignment planner', () => {
  it('rents a shelf for months and takes started months off the balance', async () => {
    for (const [id, name, fee] of [['small', 'Small shelf', 40], ['large', 'Large shelf', 70]] as const) {
      expect((await call(store, 'PUT', `/spaces/${id}`, { storeId: 'zh', name, monthlyFee: fee, currency: 'CHF', count: 4 })).statusCode).toBe(200);
    }
    // A space at another store is refused.
    const wrong = await call(store, 'POST', '/rentals', { consignorId: 'ana', storeId: 'elsewhere', spaceId: 'small', startDate: monthStart, months: 3, monthlyFee: 40, currency: 'CHF' });
    expect(wrong.statusCode).toBe(400);

    const start = addMonths(monthStart, -1); // last month and this month have started
    const res = await call(store, 'POST', '/rentals', { consignorId: 'ana', storeId: 'zh', spaceId: 'small', startDate: start, months: 6, monthlyFee: 40, currency: 'CHF' });
    expect(res.statusCode).toBe(201);
    expect(res.json().delivery).toEqual({ notified: true, emailedTo: null });

    const ana = (await call(store, 'GET', '/statement')).json().statements.find((s: { consignorId: string }) => s.consignorId === 'ana');
    expect(ana.totals).toEqual([{ currency: 'CHF', units: 0, gross: 0, commission: 0, artistShare: 0, paid: 0, rent: 80, balance: -80 }]);
  });

  it('upgrades to a larger shelf from the next month, keeping both on record', async () => {
    const [small] = (await call(store, 'GET', '/planner')).json().rentals;
    const from = addMonths(monthStart, 1);
    expect((await call(store, 'POST', `/rentals/${small.id}/upgrade`, { spaceId: 'large', from: small.startDate, months: 3, monthlyFee: 70 })).statusCode).toBe(400);
    const up = await call(store, 'POST', `/rentals/${small.id}/upgrade`, { spaceId: 'large', from, months: 3, monthlyFee: 70 });
    expect(up.statusCode).toBe(201);
    expect(up.json().rental).toMatchObject({ spaceId: 'large', startDate: from, upgradedFromId: small.id, currency: 'CHF' });

    const rentals = (await call(store, 'GET', '/planner')).json().rentals as { id: string; endedOn: string | null }[];
    expect(rentals.find((r) => r.id === small.id)?.endedOn).toBe(from);
    // Nothing of the larger shelf has started yet: rent is unchanged.
    const ana = (await call(store, 'GET', '/statement')).json().statements.find((s: { consignorId: string }) => s.consignorId === 'ana');
    expect(ana.totals[0].rent).toBe(80);
  });

  it('books a setup: the artist is notified and emailed an invite', async () => {
    sent.length = 0;
    const res = await call(store, 'POST', '/setups', { consignorId: 'ana', storeId: 'zh', date: '2026-11-03', time: '09:30', durationMin: 45, note: 'Bring the new prints' });
    expect(res.statusCode).toBe(201);
    expect(res.json().delivery).toEqual({ notified: true, emailedTo: 'ana.studio@example.test' });

    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail).toMatchObject({ to: 'ana.studio@example.test', replyTo: 'shop@example.test' });
    expect(mail.subject).toBe('Setup scheduled: Zurich shop, 2026-11-03 09:30');
    expect(mail.text).toContain('Langstrasse 1, 8004 Zurich');
    expect(mail.ics).toContain('DTSTART:20261103T093000');
    expect(mail.ics).toContain('DTEND:20261103T101500');
    expect(mail.ics).toContain('LOCATION:Langstrasse 1\\, 8004 Zurich');

    const { notifications, unread } = await bell(artist);
    expect(unread).toBe(3); // booked, upgraded, setup
    expect(notifications[0]).toMatchObject({ title: 'Setup scheduled at Zurich shop', link: '/m/consignment?tab=mine', moduleId: 'consignment' });
    // The store's own bell is quiet - it did this itself.
    expect((await bell(store)).unread).toBe(0);
  });

  it('lets the artist answer, and tells the store - but not its helpers', async () => {
    const links = (await call(artist, 'GET', '/links')).json().links as ArtistConsignment[];
    const setup = links[0]!.setups[0]!;
    expect(links[0]!.rentals.map((r) => r.spaceName).sort()).toEqual(['Large shelf', 'Small shelf']);

    sent.length = 0;
    const url = `/links/${storeAccountId}/ana/setups/${setup.id}/respond`;
    expect((await call(helper, 'POST', url, { status: 'confirmed' })).statusCode).toBe(403);
    const res = await call(artist, 'POST', url, { status: 'declined', note: 'Can we do the afternoon?' });
    expect(res.statusCode).toBe(200);
    expect(res.json().setup).toMatchObject({ status: 'declined', artistNote: 'Can we do the afternoon?' });

    expect((await bell(store)).notifications[0]).toMatchObject({ title: "Ana can't make the setup on 2026-11-03 09:30", body: 'Can we do the afternoon?' });
    expect((await bell(helper)).unread).toBe(0);
    expect(sent[0]).toMatchObject({ to: 'shop@example.test', replyTo: 'ana@example.test' });
  });

  it('moving a setup asks again; cancelling sends no invite', async () => {
    const [setup] = (await call(store, 'GET', '/planner')).json().setups;
    sent.length = 0;
    const moved = await call(store, 'PUT', `/setups/${setup.id}`, { consignorId: 'ana', storeId: 'zh', date: '2026-11-03', time: '14:00', durationMin: 45 });
    expect(moved.json().setup).toMatchObject({ status: 'scheduled', artistNote: '' });
    expect(sent[0]?.subject).toMatch(/^Setup moved/);
    expect(sent[0]?.ics).toMatch(/SEQUENCE:\d+/);

    const cancelled = await call(store, 'POST', `/setups/${setup.id}/cancel`);
    expect(cancelled.json().setup.status).toBe('cancelled');
    expect(sent[1]?.subject).toMatch(/^Setup cancelled/);
    expect(sent[1]?.ics).toBeUndefined();
    const respond = await call(artist, 'POST', `/links/${storeAccountId}/ana/setups/${setup.id}/respond`, { status: 'confirmed' });
    expect(respond.statusCode).toBe(409);
  });

  it('marks notifications read', async () => {
    await app.inject({ method: 'POST', url: '/api/notifications/read', headers: auth(artist), payload: {} });
    expect((await bell(artist)).unread).toBe(0);
  });

  it('keeps a rented space from being deleted', async () => {
    expect((await call(store, 'DELETE', '/spaces/small')).statusCode).toBe(409);
  });
});
