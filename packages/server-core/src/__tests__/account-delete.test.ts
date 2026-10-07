import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../app';
import type { ServerModule } from '../modules/mount';

/**
 * Deleting an account must take a module's rows with it: core cannot know
 * the tables, so each module drops its own inside the same transaction.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'correct horse battery staple';

// A module with one table per account, the way every real one has several.
const noter: ServerModule = {
  id: 'noter',
  migrate: (db) => db.exec('CREATE TABLE IF NOT EXISTS noter_notes (accountId TEXT NOT NULL, note TEXT NOT NULL)'),
  routes: () => async () => {},
  onAccountDeleted: (db, accountId) => db.prepare('DELETE FROM noter_notes WHERE accountId = ?').run(accountId),
};

let app: FastifyInstance;
let dataDir: string;
let token: string;
let accountId: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-delete-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [noter],
    defaultModules: [],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'Test' } });
  token = res.json().accessToken;
  accountId = res.json().user.accountId;
});

afterAll(async () => {
  await app.close();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* temp dir: Windows may still hold the WAL */
  }
  delete process.env.OWNER_EMAIL;
  delete process.env.OWNER_PASSWORD;
  delete process.env.REQUIRE_CAPTCHA;
});

const count = () => (app.zollify.db.prepare('SELECT COUNT(*) AS n FROM noter_notes WHERE accountId = ?').get(accountId) as { n: number }).n;

describe('account deletion', () => {
  it('drops the rows every module keeps for the account', async () => {
    app.zollify.db.prepare('INSERT INTO noter_notes (accountId, note) VALUES (?, ?)').run(accountId, 'hello');
    app.zollify.db.prepare('INSERT INTO noter_notes (accountId, note) VALUES (?, ?)').run('someone-else', 'theirs');
    expect(count()).toBe(1);

    const res = await app.inject({ method: 'POST', url: '/api/account/delete', headers: { authorization: `Bearer ${token}` }, payload: { password: OWNER_PASSWORD } });
    expect(res.statusCode).toBe(200);

    expect(count()).toBe(0);
    expect(app.zollify.db.prepare('SELECT COUNT(*) AS n FROM noter_notes').get()).toEqual({ n: 1 });
    expect(app.zollify.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)).toBeUndefined();
  });
});
