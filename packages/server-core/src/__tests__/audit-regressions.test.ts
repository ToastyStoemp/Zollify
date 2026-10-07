import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildGateway } from '../app';

const dir = mkdtempSync(join(tmpdir(), 'zollify-audit-'));
let app: Awaited<ReturnType<typeof buildGateway>>;
let owner: string;
let helper: string;
let counter = 0;
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const op = (type: string, payload: unknown) => ({ type, payload, deviceId: 'audit', ts: 1, opId: `audit-op-${String(++counter).padStart(16, '0')}` });
const push = (token: string, ops: unknown[]) => app.inject({ method: 'POST', url: '/api/sync/push', headers: headers(token), payload: { deviceId: 'audit', ops } });

beforeAll(async () => {
  app = await buildGateway({ dataDir: dir, moduleStoreDir: join(dir, 'modules'), jwtSecret: 'audit-secret-with-sufficient-length', serverModules: [], defaultModules: [], allowedOrigins: [], requireHttps: false, trustProxy: false, logLevel: 'silent' });
  const db = app.zollify.db;
  db.prepare("INSERT INTO accounts (id, name, createdAt) VALUES ('audit-account', 'Audit', 1)").run();
  for (const [id, role, events] of [['audit-owner', 'owner', null], ['audit-helper', 'member', '["allowed"]']]) {
    db.prepare('INSERT INTO users (id, accountId, email, passwordHash, role, createdAt, allowedEventIds) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'audit-account', `${id}@test.invalid`, 'unused', role, 1, events);
  }
  owner = app.jwt.sign({ sub: 'audit-owner', accountId: 'audit-account', role: 'owner' });
  helper = app.jwt.sign({ sub: 'audit-helper', accountId: 'audit-account', role: 'member' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  app?.zollify.db.close();
  rmSync(dir, { recursive: true, force: true });
});

it('does not authorize a foreign-event refund using a duplicate sale in the batch', async () => {
  await push(owner, [op('tx.create', { id: 'foreign-sale', eventId: 'private' })]);
  await push(helper, [op('tx.create', { id: 'foreign-sale', eventId: 'allowed' }), op('tx.revert', { txId: 'foreign-sale', revertedAt: 2 })]);
  const rows = app.zollify.db.prepare("SELECT * FROM ops WHERE type = 'tx.revert'").all();
  expect(rows).toHaveLength(0);
});

it('supports legitimate refunds in either payload format and rejects foreign ones', async () => {
  for (const key of ['id', 'txId']) {
    const id = `allowed-${key}`;
    const result = await push(helper, [op('tx.create', { id, eventId: 'allowed' }), op('tx.revert', { [key]: id, revertedAt: 3 })]);
    expect(result.json().accepted).toBe(2);
    const forbidden = await push(helper, [op('tx.revert', { [key]: 'foreign-sale', revertedAt: 4 })]);
    expect(forbidden.json().accepted).toBe(0);
  }
});

it('rejects invalid pagination before it reaches SQLite', async () => {
  for (const query of ['limit=-1', 'limit=1.5', 'limit=Infinity', 'limit=0', 'since=-1', 'since=Infinity']) {
    const response = await app.inject({ url: `/api/sync/pull?${query}`, headers: headers(owner) });
    expect(response.statusCode, query).toBe(400);
  }
});

it('caps anonymous bodies even with a forged Authorization header', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...headers('fake'), 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'x'.repeat(300_000) }) });
  expect(response.statusCode).toBe(413);
});

it('caps streamed anonymous bodies without Content-Length', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: Readable.from([JSON.stringify({ email: 'x'.repeat(300_000) })]) });
  expect(response.statusCode).toBe(413);
});

it('still accepts large authenticated sync payloads', async () => {
  const response = await push(owner, [op('setting.upsert', { key: 'large', value: 'x'.repeat(300_000), updatedAt: 1 })]);
  expect(response.statusCode).toBe(200);
  expect(response.json().accepted).toBe(1);
});

it('does not grant large bodies to a removed user or revoked API token', async () => {
  const token = 'zt_auditcredential';
  app.zollify.db.prepare('INSERT INTO api_tokens (id, accountId, name, tokenHash, scopes, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('audit-api', 'audit-account', 'Audit', createHash('sha256').update(token).digest('hex'), 'data:write', 'audit-owner', 1);
  // The login schema returns 400 only after the parser accepts this large body.
  const send = (credential: string) => app.inject({ method: 'POST', url: '/api/auth/login', headers: headers(credential), payload: { email: 'x'.repeat(300_000) } });
  expect((await send(token)).statusCode).toBe(400);
  app.zollify.db.prepare('UPDATE api_tokens SET revokedAt = 1 WHERE id = ?').run('audit-api');
  expect((await send(token)).statusCode).toBe(413);
  const removed = app.jwt.sign({ sub: 'removed-user', accountId: 'audit-account', role: 'owner' });
  expect((await send(removed)).statusCode).toBe(413);
});

it('trusts forwarded HTTPS only when proxy trust is enabled', async () => {
  for (const trustProxy of [false, true]) {
    const httpsDir = mkdtempSync(join(tmpdir(), 'zollify-https-audit-'));
    const gateway = await buildGateway({ dataDir: httpsDir, moduleStoreDir: join(httpsDir, 'modules'), jwtSecret: 'audit-secret-with-sufficient-length', serverModules: [], defaultModules: [], allowedOrigins: [], requireHttps: true, trustProxy, logLevel: 'silent' });
    try {
      const response = await gateway.inject({ url: '/api/setup', headers: { 'x-forwarded-proto': 'https' } });
      expect(response.statusCode).toBe(trustProxy ? 200 : 403);
      expect((await gateway.inject({ url: '/api/setup' })).statusCode).toBe(403);
    } finally {
      await gateway.close();
      gateway.zollify.db.close();
      rmSync(httpsDir, { recursive: true, force: true });
    }
  }
});

it('closes a removed user’s socket before relaying another message', async () => {
  const socket = await app.injectWS(`/api/sync/ws?token=${helper}`);
  // This helper has no refresh sessions; remove any presence reference first.
  app.zollify.db.prepare('DELETE FROM devices WHERE userId = ?').run('audit-helper');
  app.zollify.db.prepare('DELETE FROM users WHERE id = ?').run('audit-helper');
  try {
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ type: 'display.subscribe', on: true }));
    const [code] = await closed;
    expect(code).toBe(4001);
  } finally {
    socket.terminate();
  }
});

it('does not deliver broadcasts to an already-open socket after user removal', async () => {
  app.zollify.db.prepare('INSERT INTO users (id, accountId, email, passwordHash, role, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run('socket-viewer', 'audit-account', 'viewer@test.invalid', 'unused', 'member', 1);
  const viewer = app.jwt.sign({ sub: 'socket-viewer', accountId: 'audit-account', role: 'member' });
  const socket = await app.injectWS(`/api/sync/ws?token=${viewer}`);
  app.zollify.db.prepare('DELETE FROM users WHERE id = ?').run('socket-viewer');
  try {
    const closed = once(socket, 'close');
    await push(owner, [op('setting.upsert', { key: 'broadcast', value: true, updatedAt: 1 })]);
    const [code] = await closed;
    expect(code).toBe(4001);
  } finally {
    socket.terminate();
  }
});
