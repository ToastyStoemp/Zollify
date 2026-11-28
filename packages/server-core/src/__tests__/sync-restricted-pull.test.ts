import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PullResponse } from '@zollify/shared';
import { buildGateway } from '../app';

/**
 * A helper only receives the catalogue and their own events' data. Whole pages
 * of the log can be other events' sales, so a pull has to say how far it
 * looked: an empty page is not the end of the log.
 */

const OWNER_EMAIL = 'owner@example.test';
const PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;
let owner: string;
let helper: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
let n = 0;
const op = (type: string, payload: unknown) => ({ opId: `op-restricted-${String(++n).padStart(8, '0')}`, deviceId: 'owner-laptop', ts: n, type, payload });
const sale = (eventId: string) => op('tx.create', { id: `tx-${n}`, eventId });

async function push(ops: unknown[]): Promise<void> {
  const res = await app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(owner), payload: { deviceId: 'owner-laptop', ops } });
  expect(res.statusCode).toBe(200);
}

async function pull(token: string, query: string): Promise<PullResponse> {
  const res = await app.inject({ method: 'GET', url: `/api/sync/pull?${query}`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json();
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-restricted-pull-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [],
    defaultModules: [],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER_EMAIL, password: PASSWORD, deviceName: 'Test' } })).json().accessToken;
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'member', allowedEventIds: ['mine'] } });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'helper@example.test', password: PASSWORD, inviteCode: invite.json().code } });
  expect(reg.statusCode).toBe(200);
  helper = reg.json().accessToken;

  // Seqs 1-6 are another event's sales, 7 is a product, 8 another event's sale again.
  await push([...Array.from({ length: 6 }, () => sale('theirs')), op('product.upsert', { id: 'p1', title: 'Print', updatedAt: 1 }), sale('theirs')]);
});

afterAll(async () => {
  try {
    app.zollify?.db?.close();
  } catch {
    /* already closed */
  }
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.OWNER_EMAIL;
  delete process.env.OWNER_PASSWORD;
  delete process.env.REQUIRE_CAPTCHA;
});

describe('pull for a restricted user', () => {
  it('says how far it looked when a whole page is not theirs to read', async () => {
    const page = await pull(helper, 'since=0&limit=3&device=helper-phone');
    expect(page.ops).toEqual([]);
    expect(page.scannedTo).toBe(3);
    expect(page.latestSeq).toBe(8);
    // Not the end of the log: an older client must not be told it has caught up.
    expect(page.caughtUp).toBeUndefined();
  });

  it('reaches the product behind pages of unreadable ops when followed page by page', async () => {
    const got: string[] = [];
    let since = 0;
    for (let round = 0; round < 10 && since < 8; round++) {
      const page = await pull(helper, `since=${since}&limit=3&device=helper-phone`);
      got.push(...page.ops.map((o) => o.type));
      expect(page.scannedTo).toBeGreaterThan(since);
      since = page.scannedTo!;
    }
    expect(got).toEqual(['product.upsert']);
    expect(since).toBe(8);
  });

  it('reports the tail once the scan runs off the end of the log', async () => {
    const page = await pull(helper, 'since=6&limit=3&device=helper-phone');
    expect(page.ops.map((o) => o.type)).toEqual(['product.upsert']);
    expect(page.scannedTo).toBe(8);
    expect(page.caughtUp).toBe(true);
  });

  it('tells an unrestricted user the same thing', async () => {
    const full = await pull(owner, 'since=0&limit=3');
    expect(full.ops).toHaveLength(3);
    expect(full.scannedTo).toBe(3);
    const rest = await pull(owner, 'since=3');
    expect(rest.scannedTo).toBe(rest.latestSeq);
  });
});
