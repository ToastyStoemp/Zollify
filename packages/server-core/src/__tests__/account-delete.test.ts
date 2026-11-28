import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGateway } from '../app';
import { accountFootprint, dataFiles, misfiledServerTables, needlesOf, seedEveryAccountTable, undeclaredTables } from '../account-audit';
import { accountRows, collectAccountData, erased, type AccountTable } from '../account-data';
import type { ServerModule } from '../modules/mount';

/**
 * Deleting an account must take everything kept for it: core's own rows, a
 * module's rows (core cannot know the tables, so each module declares them),
 * and the files on disk - in every state an account can be in, a removed
 * device included.
 */

const OWNER_EMAIL = 'owner@example.test';
const PASSWORD = 'correct horse battery staple';
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64');

// A module with tables per account, the way every real one has several: one that goes with
// the account, and one it has a written reason to keep.
const noter: ServerModule = {
  id: 'noter',
  migrate: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS noter_notes (accountId TEXT NOT NULL, note TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS noter_ledger (accountId TEXT NOT NULL, entry TEXT NOT NULL);
    `),
  routes: () => async () => {},
  accountData: [
    erased('noter_notes', 'Notes', 'merchant'),
    { table: 'noter_ledger', holds: 'A ledger the law wants kept', personal: 'none', onDelete: { retain: { reason: 'Required by a law', period: '7 years' } }, onWipe: 'erase' },
  ],
};

/** A module whose own clean-up fails halfway through a deletion. */
const failing: ServerModule = {
  id: 'failing',
  routes: () => async () => {},
  onAccountDeleted: () => {
    throw new Error('module clean-up failed');
  },
};

interface Booth {
  app: FastifyInstance;
  dataDir: string;
  accountId: string;
  userId: string;
  headers: { authorization: string };
}

const open: { app: FastifyInstance; dataDir: string }[] = [];

/** A fresh server with its owner signed in on one device: deleting is final, so every test gets its own. */
async function booth(modules: ServerModule[] = [noter]): Promise<Booth> {
  const dataDir = mkdtempSync(join(tmpdir(), 'zollify-delete-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  const app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: modules,
    defaultModules: [],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  open.push({ app, dataDir });
  const res = await login(app, 'main-till');
  return { app, dataDir, accountId: res.user.accountId, userId: res.user.id, headers: { authorization: `Bearer ${res.accessToken}` } };
}

async function login(app: FastifyInstance, deviceId: string): Promise<{ accessToken: string; user: { id: string; accountId: string } }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER_EMAIL, password: PASSWORD, deviceId, deviceName: deviceId } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const deleteAccount = (b: Booth) => b.app.inject({ method: 'POST', url: '/api/account/delete', headers: b.headers, payload: { password: PASSWORD } });
const wipe = (b: Booth) => b.app.inject({ method: 'POST', url: '/api/account/wipe', headers: b.headers, payload: { archived: true } });
const accountGone = (b: Booth): boolean => !b.app.zollify.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(b.accountId);

/** Leaves a file in each place the server keeps files for an account. */
async function leaveFiles(b: Booth): Promise<void> {
  const log = await b.app.inject({ method: 'POST', url: '/api/logs', headers: b.headers, payload: { deviceId: 'main-till', log: 'card declined' } });
  expect(log.statusCode).toBe(200);
  const file = await b.app.inject({ method: 'PUT', url: '/api/events/ev-1/files/plan', headers: b.headers, payload: { name: 'plan.pdf', mime: 'application/pdf', data: PDF } });
  expect(file.statusCode).toBe(200);
  // Full-size product images from before they travelled as ops: nothing writes these any more, but servers still hold them.
  mkdirSync(join(b.dataDir, 'images', b.accountId), { recursive: true });
  writeFileSync(join(b.dataDir, 'images', b.accountId, 'product.jpg'), 'jpeg');
}

afterEach(async () => {
  for (const { app, dataDir } of open.splice(0)) {
    await app.close();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* temp dir: Windows may still hold the WAL */
    }
  }
  delete process.env.OWNER_EMAIL;
  delete process.env.OWNER_PASSWORD;
  delete process.env.REQUIRE_CAPTCHA;
});

describe('account deletion', () => {
  it('drops the rows every module keeps for the account', async () => {
    const b = await booth();
    const db = b.app.zollify.db;
    db.prepare('INSERT INTO noter_notes (accountId, note) VALUES (?, ?)').run(b.accountId, 'hello');
    db.prepare('INSERT INTO noter_notes (accountId, note) VALUES (?, ?)').run('someone-else', 'theirs');

    expect((await deleteAccount(b)).statusCode).toBe(200);

    expect(db.prepare('SELECT accountId FROM noter_notes').all()).toEqual([{ accountId: 'someone-else' }]);
    expect(accountGone(b)).toBe(true);
  });

  it('keeps what a module declared it must retain, and only that', async () => {
    const b = await booth();
    const db = b.app.zollify.db;
    seedEveryAccountTable(db, { accountId: b.accountId, userId: b.userId, email: OWNER_EMAIL });
    const who = needlesOf(db, b.accountId);

    expect((await deleteAccount(b)).statusCode).toBe(200);

    expect(accountFootprint(db, who)).toEqual({ noter_ledger: 1 });
  });

  it('changes nothing when any part of it fails: rows, files and the queue stay as they were', async () => {
    const b = await booth([noter, failing]);
    const db = b.app.zollify.db;
    await leaveFiles(b);
    seedEveryAccountTable(db, { accountId: b.accountId, userId: b.userId, email: OWNER_EMAIL });
    const who = needlesOf(db, b.accountId);
    const before = { rows: accountFootprint(db, who), files: dataFiles(b.dataDir) };

    expect((await deleteAccount(b)).statusCode).toBe(500);

    expect({ rows: accountFootprint(db, who), files: dataFiles(b.dataDir) }).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM file_removals').get()).toEqual({ n: 0 });
  });

  it('goes through after a device was removed from the account', async () => {
    const b = await booth();
    await login(b.app, 'spare-till');
    expect((await b.app.inject({ method: 'DELETE', url: '/api/devices/spare-till', headers: b.headers })).statusCode).toBe(200);

    expect((await deleteAccount(b)).statusCode).toBe(200);

    expect(accountGone(b)).toBe(true);
    expect(b.app.zollify.db.prepare('SELECT COUNT(*) AS n FROM device_revocations').get()).toEqual({ n: 0 });
  });

  it('removes every file kept for the account: event files, images and uploaded logs', async () => {
    const b = await booth();
    await leaveFiles(b);
    expect(dataFiles(b.dataDir)).toHaveLength(3);

    expect((await deleteAccount(b)).statusCode).toBe(200);

    expect(dataFiles(b.dataDir)).toEqual([]);
    expect(existsSync(join(b.dataDir, 'images', b.accountId))).toBe(false);
    expect(existsSync(join(b.dataDir, 'event-files', b.accountId))).toBe(false);
  });
});

describe('deleting only your own login', () => {
  it('takes the PIN lockout counter kept for that user', async () => {
    const b = await booth();
    const db = b.app.zollify.db;
    db.prepare("INSERT INTO users (id, accountId, email, passwordHash, role, createdAt) VALUES ('second-admin', ?, 'second@example.test', 'x', 'admin', 1)").run(b.accountId);
    db.prepare('INSERT INTO pin_misses (userId, failures, lockedUntil) VALUES (?, 2, 0)').run(b.userId);

    const res = await b.app.inject({ method: 'POST', url: '/api/users/me/delete', headers: b.headers, payload: { password: PASSWORD } });

    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pin_misses').get()).toEqual({ n: 0 });
  });
});

describe('files of an erasure that committed just before the server stopped', () => {
  /** Stops the server and starts it again on the same data directory. */
  async function restart(b: Booth): Promise<void> {
    open.splice(0);
    await b.app.close();
    const again = await buildGateway({ dataDir: b.dataDir, moduleStoreDir: join(b.dataDir, 'modules'), jwtSecret: 'test-secret-value-long-enough-for-signing', serverModules: [noter], defaultModules: [], allowedOrigins: [], requireHttps: false, trustProxy: false, logLevel: 'silent' });
    await again.ready();
    open.push({ app: again, dataDir: b.dataDir });
    b.app = again;
  }

  it('are removed at the next start', async () => {
    const b = await booth();
    await leaveFiles(b);
    // What the erasing transaction leaves when the process dies before it reaches the disk.
    b.app.zollify.db.prepare('INSERT INTO file_removals (path, queuedAt) VALUES (?, 1)').run(`event-files/${b.accountId}`);

    await restart(b);

    expect(existsSync(join(b.dataDir, 'event-files', b.accountId))).toBe(false);
    expect(existsSync(join(b.dataDir, 'images', b.accountId))).toBe(true);
    expect(b.app.zollify.db.prepare('SELECT COUNT(*) AS n FROM file_removals').get()).toEqual({ n: 0 });
  });

  it('never reach outside the data directory, whatever the queue says', async () => {
    const b = await booth();
    const outside = join(b.dataDir, '..', `zollify-outside-${b.accountId}.txt`);
    writeFileSync(outside, 'not ours');
    b.app.zollify.db.prepare('INSERT INTO file_removals (path, queuedAt) VALUES (?, 1), (?, 1)').run(`../zollify-outside-${b.accountId}.txt`, '.');

    await restart(b);

    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(b.dataDir, 'zollify.db'))).toBe(true);
    rmSync(outside);
  });
});

describe('the declarations deletion runs from', () => {
  const table = (over: Partial<AccountTable>): AccountTable => ({ table: 'things', holds: 'Things', personal: 'none', onDelete: 'erase', onWipe: 'erase', ...over });

  it('cover every table of the database, each exactly once', async () => {
    const b = await booth();
    expect(undeclaredTables(b.app.zollify.db, b.app.zollify.accountData)).toEqual({ undeclared: [], missing: [] });
    expect(misfiledServerTables(b.app.zollify.db, b.app.zollify.accountData)).toEqual([]);
  });

  it('notice a table a module created without declaring it', async () => {
    const sneaky: ServerModule = { id: 'sneaky', migrate: (db) => db.exec('CREATE TABLE IF NOT EXISTS sneaky_rows (accountId TEXT NOT NULL)'), routes: () => async () => {} };
    const b = await booth([sneaky]);
    expect(undeclaredTables(b.app.zollify.db, b.app.zollify.accountData).undeclared).toEqual(['sneaky_rows']);
  });

  it('refuse a table retained without a written reason and period', () => {
    expect(() => collectAccountData([{ id: 'm', accountData: [table({ onDelete: { retain: { reason: 'Tax law', period: ' ' } } })] }])).toThrow(/things is retained without a written reason and period/);
    expect(() => collectAccountData([{ id: 'm', accountData: [table({ onWipe: { retain: { reason: '', period: '7 years' } } })] }])).toThrow(/retained without/);
    expect(() => collectAccountData([{ id: 'm', accountData: [table({ onDelete: { retain: { reason: 'Tax law', period: '7 years' } } })] }])).not.toThrow();
  });

  it('refuse a table declared twice, or one that hides what it holds', () => {
    expect(() => collectAccountData([{ id: 'm', accountData: [table({}), table({})] }])).toThrow(/things is declared twice/);
    expect(() => collectAccountData([{ id: 'm', accountData: [table({ table: 'ops' })] }])).toThrow(/ops is declared twice/);
    expect(() => collectAccountData([{ id: 'm', accountData: [table({ personal: '' })] }])).toThrow(/must say what it holds/);
  });
});

describe('wiping the account data', () => {
  it('erases the booth data and keeps the account, its people and their devices', async () => {
    const b = await booth();
    const db = b.app.zollify.db;
    seedEveryAccountTable(db, { accountId: b.accountId, userId: b.userId, email: OWNER_EMAIL });
    const tables = b.app.zollify.accountData.tables;
    const rows = () => Object.fromEntries(tables.map((t) => [t.table, accountRows(db, t, b.accountId)]));
    const before = rows();
    expect(Object.values(before).every((n) => n > 0)).toBe(true);

    expect((await wipe(b)).statusCode).toBe(200);

    const erasedByWipe = tables.filter((t) => t.onWipe === 'erase').map((t) => t.table);
    expect(erasedByWipe.sort()).toEqual(['event_files', 'images', 'metrics', 'noter_ledger', 'noter_notes', 'ops']);
    const expected = Object.fromEntries(tables.map((t) => [t.table, t.onWipe === 'erase' ? 0 : before[t.table]]));
    expect(rows()).toEqual(expected);
  });

  it('removes the image and event files it erased the rows of, and keeps the uploaded logs', async () => {
    const b = await booth();
    await leaveFiles(b);

    expect((await wipe(b)).statusCode).toBe(200);

    expect(existsSync(join(b.dataDir, 'images', b.accountId))).toBe(false);
    expect(existsSync(join(b.dataDir, 'event-files', b.accountId))).toBe(false);
    // The logs table is not reset by a wipe, so its files stay too.
    expect(dataFiles(b.dataDir)).toEqual([expect.stringMatching(/^logs\/.+\.log$/)]);
  });
});
