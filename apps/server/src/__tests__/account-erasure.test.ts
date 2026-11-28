import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accountFootprint,
  accountRows,
  buildGateway,
  dataFiles,
  misfiledServerTables,
  needlesOf,
  seedEveryAccountTable,
  undeclaredTables,
  type AccountTable,
} from '@zollify/server-core';
import { serverModules } from '../server-modules';

/**
 * Nothing an account leaves behind by accident, and nothing kept without a
 * written reason - checked against the real database of this deploy, every
 * module included, not against a list of tables someone has to remember to
 * extend. An account is filled in every table and directory, deleted (or
 * wiped), and the schema is then asked what still mentions it.
 */

const OWNER_EMAIL = 'owner@example.test';
const BOOTH_EMAIL = 'booth@example.test';
const PASSWORD = 'correct horse battery staple';
const SECRET = 'test-secret-value-long-enough-for-signing';
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64');

interface Session {
  accountId: string;
  userId: string;
  email: string;
  headers: { authorization: string };
}

const open: { app: FastifyInstance; dataDir: string }[] = [];

/** The server as deployed: every module, and its owner account. */
async function server(): Promise<{ app: FastifyInstance; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'zollify-erasure-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  process.env.REGISTRATION_OPEN = '1';
  const app = await buildGateway({ dataDir, moduleStoreDir: join(dataDir, 'modules'), jwtSecret: SECRET, serverModules: serverModules(SECRET), defaultModules: ['pos'], allowedOrigins: [], requireHttps: false, trustProxy: false, logLevel: 'silent' });
  await app.ready();
  open.push({ app, dataDir });
  return { app, dataDir };
}

async function signIn(app: FastifyInstance, email: string, deviceId: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD, deviceId, deviceName: deviceId } });
  expect(res.statusCode).toBe(200);
  const { accessToken, user } = res.json() as { accessToken: string; user: { id: string; accountId: string } };
  return { accountId: user.accountId, userId: user.id, email, headers: { authorization: `Bearer ${accessToken}` } };
}

/** A second business on the server, with its admin signed in. */
async function openBooth(app: FastifyInstance): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: BOOTH_EMAIL, password: PASSWORD, accountName: 'Booth' } });
  expect(res.statusCode).toBe(200);
  return signIn(app, BOOTH_EMAIL, 'booth-till');
}

/** Uses the account the way a booth would - a removed device, an uploaded log, files - then fills every table the API did not reach. */
async function populate(app: FastifyInstance, dataDir: string, s: Session): Promise<void> {
  await signIn(app, s.email, `${s.email}-spare`);
  const call = async (method: 'DELETE' | 'POST' | 'PUT', url: string, payload?: object): Promise<void> => {
    expect((await app.inject({ method, url, headers: s.headers, payload })).statusCode).toBe(200);
  };
  await call('DELETE', `/api/devices/${encodeURIComponent(`${s.email}-spare`)}`);
  await call('POST', '/api/logs', { deviceId: 'till', log: 'card declined' });
  await call('PUT', '/api/events/ev-1/files/plan', { name: 'plan.pdf', mime: 'application/pdf', data: PDF });
  mkdirSync(join(dataDir, 'images', s.accountId), { recursive: true });
  writeFileSync(join(dataDir, 'images', s.accountId, 'product.jpg'), 'jpeg');
  seedEveryAccountTable(app.zollify.db, s);
}

const rowsPerTable = (app: FastifyInstance, tables: AccountTable[], accountId: string): Record<string, number> =>
  Object.fromEntries(tables.map((t) => [t.table, accountRows(app.zollify.db, t, accountId)]));

afterEach(async () => {
  for (const { app, dataDir } of open.splice(0)) {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
  for (const name of ['OWNER_EMAIL', 'OWNER_PASSWORD', 'REQUIRE_CAPTCHA', 'REGISTRATION_OPEN']) delete process.env[name];
});

describe('what the server keeps per account', () => {
  it('is declared for every table in the database: per account with an action, or server-wide with a reason', async () => {
    const { app } = await server();
    const { db, accountData } = app.zollify;
    // A table that shows up here was added without deciding what happens to it when its account is deleted.
    expect(undeclaredTables(db, accountData)).toEqual({ undeclared: [], missing: [] });
    expect(misfiledServerTables(db, accountData)).toEqual([]);
  });

  it('retains nothing on deletion today; the one table a wipe retains says why and for how long', async () => {
    const { app } = await server();
    const { tables } = app.zollify.accountData;
    expect(tables.filter((t) => t.onDelete !== 'erase').map((t) => t.table)).toEqual([]);
    // A wipe keeps the account itself (core's tables) - of the modules' data, only issued invoices.
    const ofModules = serverModules(SECRET).flatMap((m) => m.accountData ?? []);
    expect(ofModules.filter((t) => t.onWipe !== 'erase').map((t) => t.table)).toEqual(['consignment_invoices']);
  });
});

describe('deleting a fully populated account', () => {
  it('leaves no row that mentions the account, its users or their emails, and no file', async () => {
    const { app, dataDir } = await server();
    const { db, accountData } = app.zollify;
    const owner = await signIn(app, OWNER_EMAIL, 'owner-till');
    await populate(app, dataDir, owner);
    const filesOfOthers = dataFiles(dataDir);
    const booth = await openBooth(app);
    await populate(app, dataDir, booth);
    const who = needlesOf(db, booth.accountId);
    // Every declared table really holds something of the booth's before the deletion.
    expect(Object.entries(rowsPerTable(app, accountData.tables, booth.accountId)).filter(([, n]) => n === 0)).toEqual([]);
    const ownersBefore = accountFootprint(db, needlesOf(db, owner.accountId));

    const res = await app.inject({ method: 'POST', url: '/api/account/delete', headers: booth.headers, payload: { password: PASSWORD } });

    expect(res.statusCode).toBe(200);
    expect(accountFootprint(db, who)).toEqual({});
    expect(rowsPerTable(app, accountData.tables, booth.accountId)).toEqual(Object.fromEntries(accountData.tables.map((t) => [t.table, 0])));
    expect(dataFiles(dataDir)).toEqual(filesOfOthers);
    // The other account on the server lost nothing.
    expect(accountFootprint(db, needlesOf(db, owner.accountId))).toEqual(ownersBefore);
  });

  it('unlinks the account where another account pointed at it, and keeps that account’s row', async () => {
    const { app } = await server();
    const db = app.zollify.db;
    const store = await signIn(app, OWNER_EMAIL, 'store-till');
    const artist = await openBooth(app);
    db.prepare("INSERT INTO consignors (accountId, id, doc, linkedAccountId, createdAt, updatedAt) VALUES (?, 'c1', '{}', ?, 1, 1)").run(store.accountId, artist.accountId);

    const res = await app.inject({ method: 'POST', url: '/api/account/delete', headers: artist.headers, payload: { password: PASSWORD } });

    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT accountId, linkedAccountId FROM consignors').all()).toEqual([{ accountId: store.accountId, linkedAccountId: null }]);
  });

  it('takes its shared event listing out of the pool at once, not at the next restart', async () => {
    const { app } = await server();
    const db = app.zollify.db;
    const booth = await openBooth(app);
    const factsAt = (venueName: string, street: string): string =>
      JSON.stringify({ name: 'Open studio', edition: '', venueName, street, postcode: '9000', city: 'Gent', country: 'BE', dateStart: '2027-01-01', dateEnd: '2027-01-02', url: '', description: '' });
    const listing = db.prepare("INSERT INTO event_pool_listings (id, dedupeKey, name, dateStart, dateEnd, updatedAt) VALUES (?, ?, 'Open studio', '2027-01-01', '2027-01-02', 1)");
    listing.run('only-theirs', 'k1');
    listing.run('shared', 'k2');
    const contrib = db.prepare('INSERT INTO event_pool_contribs (accountId, eventId, listingId, facts, updatedAt) VALUES (?, ?, ?, ?, 1)');
    contrib.run(booth.accountId, 'ev-1', 'only-theirs', factsAt('At home', 'Kerkstraat 1'));
    contrib.run(booth.accountId, 'ev-2', 'shared', factsAt('At home', 'Kerkstraat 1'));
    contrib.run('another-account', 'ev-9', 'shared', factsAt('Town hall', 'Botermarkt 1'));

    const res = await app.inject({ method: 'POST', url: '/api/account/delete', headers: booth.headers, payload: { password: PASSWORD } });

    expect(res.statusCode).toBe(200);
    // The listing only they fed is gone; the shared one now reads as the remaining contributor wrote it.
    expect(db.prepare('SELECT id, venueName, street FROM event_pool_listings').all()).toEqual([{ id: 'shared', venueName: 'Town hall', street: 'Botermarkt 1' }]);
  });
});

describe('wiping a fully populated account', () => {
  it('erases exactly what is declared for a wipe, keeps the rest untouched, and removes the erased files', async () => {
    const { app, dataDir } = await server();
    const { db, accountData } = app.zollify;
    const owner = await signIn(app, OWNER_EMAIL, 'owner-till');
    await populate(app, dataDir, owner);
    const before = rowsPerTable(app, accountData.tables, owner.accountId);
    expect(Object.entries(before).filter(([, n]) => n === 0)).toEqual([]);

    const res = await app.inject({ method: 'POST', url: '/api/account/wipe', headers: owner.headers, payload: { archived: true } });

    expect(res.statusCode).toBe(200);
    const expected = Object.fromEntries(accountData.tables.map((t) => [t.table, t.onWipe === 'erase' ? 0 : before[t.table]]));
    expect(rowsPerTable(app, accountData.tables, owner.accountId)).toEqual(expected);
    // Only tables declared as kept still mention the account.
    const kept = new Set(accountData.tables.filter((t) => t.onWipe !== 'erase').map((t) => t.table));
    expect(Object.keys(accountFootprint(db, needlesOf(db, owner.accountId))).filter((t) => !kept.has(t))).toEqual([]);
    expect(dataFiles(dataDir)).toEqual([expect.stringMatching(/^logs\/.+\.log$/)]);
    // The account goes on: its owner can still sign in.
    await signIn(app, OWNER_EMAIL, 'owner-till');
  });
});

describe('tax: card payments seen on the phone', () => {
  it('go with the account: the cards and the merchants paid', async () => {
    const { app } = await server();
    const db = app.zollify.db;
    const owner = await signIn(app, OWNER_EMAIL, 'owner-till');
    db.prepare("INSERT INTO tax_cards (accountId, last4, role, label) VALUES (?, '4242', 'business', 'Booth card')").run(owner.accountId);
    db.prepare("INSERT INTO tax_card_payments (accountId, id, at, amountMinor, currency, merchant, last4) VALUES (?, 'p1', 1, 1250, 'EUR', 'Print Shop Gent', '4242')").run(owner.accountId);

    const res = await app.inject({ method: 'POST', url: '/api/account/delete', headers: owner.headers, payload: { password: PASSWORD } });

    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tax_cards').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tax_card_payments').get()).toEqual({ n: 0 });
  });
});
