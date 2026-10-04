import { randomInt, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { ModuleContext, SecretBox } from '@zollify/server-core';
import { FiskalyApi, FiskalyError, type FiskalyAuth } from './api';

/**
 * fiskaly cloud TSE, signed on the server.
 *
 * The account's fiskaly API key stays here, encrypted - devices never see
 * it. Every device that picks "fiskaly" signs through these routes under its
 * own till serial number, which is registered with the account's TSS the
 * first time it signs. Zollify creates and initialises the TSS itself, and
 * keeps its admin PUK and PIN encrypted alongside the key.
 *
 *   GET  /fiskaly          status (any signed-in device)
 *   PUT  /fiskaly          { apiKey, apiSecret } - owners/admins; checked with fiskaly before it is saved
 *   POST /fiskaly/setup    create and initialise the TSS - owners/admins; picks up where it stopped
 *   POST /fiskaly/start    { clientId } → { number, time }
 *   POST /fiskaly/finish   { clientId, number, processType, processData } → the signature
 */

interface Secrets {
  apiKey: string;
  apiSecret: string;
  adminPuk?: string;
  adminPin?: string;
}

interface Row {
  accountId: string;
  blob: string;
  env: string;
  tssId: string | null;
  tssState: string | null;
  tssSerial: string | null;
}

export function migrateFiskaly(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fiskaly_config (
      accountId TEXT PRIMARY KEY,
      blob      TEXT NOT NULL,
      env       TEXT NOT NULL,
      tssId     TEXT,
      tssState  TEXT,
      tssSerial TEXT,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fiskaly_clients (
      accountId TEXT NOT NULL,
      tssId     TEXT NOT NULL,
      serial    TEXT NOT NULL,
      clientId  TEXT NOT NULL,
      PRIMARY KEY (accountId, tssId, serial)
    );
    CREATE TABLE IF NOT EXISTS fiskaly_tx (
      accountId TEXT NOT NULL,
      tssId     TEXT NOT NULL,
      number    INTEGER NOT NULL,
      txId      TEXT NOT NULL,
      clientId  TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, tssId, number)
    );
  `);
}

/** A till serial number as fiskaly (and the DSFinV-K) accept it. */
const SERIAL = /^[^/_]{1,70}$/;

export function registerFiskaly(app: FastifyInstance, ctx: ModuleContext, box: SecretBox, api: FiskalyApi): void {
  const db = ctx.db;
  const tokens = new Map<string, FiskalyAuth>();
  // fiskaly has one admin session per TSS - one request's logout ends another's -
  // so admin work (setup, registering tills) runs one at a time per account.
  const adminQueue = new Map<string, Promise<unknown>>();
  function asAdmin<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const next = (adminQueue.get(accountId) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => undefined);
    adminQueue.set(accountId, settled);
    void settled.then(() => adminQueue.get(accountId) === settled && adminQueue.delete(accountId));
    return next;
  }

  const row = (accountId: string): Row | undefined => db.prepare('SELECT * FROM fiskaly_config WHERE accountId = ?').get(accountId) as Row | undefined;
  const secrets = (r: Row): Secrets => box.decrypt(r.blob) as Secrets;
  const save = (accountId: string, s: Secrets, patch: Partial<Omit<Row, 'accountId' | 'blob'>> = {}): void => {
    const current = row(accountId);
    db.prepare(
      `INSERT INTO fiskaly_config (accountId, blob, env, tssId, tssState, tssSerial, updatedAt) VALUES (@accountId, @blob, @env, @tssId, @tssState, @tssSerial, @updatedAt)
       ON CONFLICT(accountId) DO UPDATE SET blob = excluded.blob, env = excluded.env, tssId = excluded.tssId, tssState = excluded.tssState, tssSerial = excluded.tssSerial, updatedAt = excluded.updatedAt`,
    ).run({
      accountId,
      blob: box.encrypt(s),
      env: patch.env ?? current?.env ?? 'TEST',
      tssId: patch.tssId !== undefined ? patch.tssId : (current?.tssId ?? null),
      tssState: patch.tssState !== undefined ? patch.tssState : (current?.tssState ?? null),
      tssSerial: patch.tssSerial !== undefined ? patch.tssSerial : (current?.tssSerial ?? null),
      updatedAt: Date.now(),
    });
  };

  async function token(accountId: string, s: Secrets): Promise<FiskalyAuth> {
    const cached = tokens.get(accountId);
    if (cached && cached.expiresAt - 30_000 > Date.now()) return cached;
    const fresh = await api.auth(s.apiKey, s.apiSecret);
    tokens.set(accountId, fresh);
    return fresh;
  }

  const isAdmin = (role: string): boolean => role === 'owner' || role === 'admin';
  const fail = (reply: { code(n: number): { send(b: unknown): unknown } }, err: unknown) =>
    reply.code(err instanceof FiskalyError && err.status >= 400 && err.status < 500 ? 422 : 502).send({ error: 'fiskaly', message: err instanceof Error ? err.message : String(err) });

  function ready(accountId: string): { r: Row; s: Secrets; tssId: string } {
    const r = row(accountId);
    if (!r?.tssId || r.tssState !== 'INITIALIZED') throw new FiskalyError('The fiskaly TSE is not set up for this account - Settings → TSE (fiskaly).', 409);
    return { r, s: secrets(r), tssId: r.tssId };
  }

  /**
   * The fiskaly client id for a till, registering the till with the TSS the
   * first time. A till fiskaly already knows (its answer lost to a timeout or
   * a restart) is picked up again: fiskaly refuses a serial number twice.
   */
  async function clientFor(accountId: string, auth: FiskalyAuth, s: Secrets, tssId: string, serial: string): Promise<string> {
    const known = () => db.prepare('SELECT clientId FROM fiskaly_clients WHERE accountId = ? AND tssId = ? AND serial = ?').get(accountId, tssId, serial) as { clientId: string } | undefined;
    const cached = known();
    if (cached) return cached.clientId;
    return asAdmin(accountId, async () => {
      const again = known();
      if (again) return again.clientId;
      let clientId = await api.findClient(auth.token, tssId, serial);
      if (!clientId) {
        clientId = randomUUID();
        await api.adminLogin(auth.token, tssId, s.adminPin!);
        try {
          await api.createClient(auth.token, tssId, clientId, serial);
        } finally {
          await api.adminLogout(auth.token, tssId).catch(() => undefined);
        }
      }
      db.prepare('INSERT OR IGNORE INTO fiskaly_clients (accountId, tssId, serial, clientId) VALUES (?, ?, ?, ?)').run(accountId, tssId, serial, clientId);
      return clientId;
    });
  }

  app.get('/fiskaly', async (req) => {
    const r = row(ctx.identity(req).accountId);
    if (!r) return { configured: false };
    return { configured: true, env: r.env, tss: r.tssId ? { id: r.tssId, state: r.tssState, serial: r.tssSerial } : null };
  });

  app.put<{ Body: { apiKey?: unknown; apiSecret?: unknown } }>('/fiskaly', async (req, reply) => {
    const who = ctx.identity(req);
    if (!isAdmin(who.role)) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can set up the TSE.' });
    const apiKey = String(req.body?.apiKey ?? '').trim();
    const apiSecret = String(req.body?.apiSecret ?? '').trim();
    if (!apiKey || !apiSecret || apiKey.length > 200 || apiSecret.length > 200) return reply.code(400).send({ error: 'invalid', message: 'Enter the API key and secret from the fiskaly dashboard.' });
    let auth: FiskalyAuth;
    try {
      auth = await api.auth(apiKey, apiSecret);
    } catch (err) {
      return fail(reply, err);
    }
    const current = row(who.accountId);
    const kept = current ? secrets(current) : undefined;
    // A key from the other environment (TEST vs LIVE) cannot reach this TSS: start over.
    const sameEnv = current?.env === auth.env;
    save(who.accountId, { apiKey, apiSecret, ...(sameEnv ? { adminPuk: kept?.adminPuk, adminPin: kept?.adminPin } : {}) }, {
      env: auth.env,
      ...(sameEnv ? {} : { tssId: null, tssState: null, tssSerial: null }),
    });
    tokens.set(who.accountId, auth);
    return { configured: true, env: auth.env };
  });

  app.post('/fiskaly/setup', async (req, reply) => {
    const who = ctx.identity(req);
    if (!isAdmin(who.role)) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can set up the TSE.' });
    if (!row(who.accountId)) return reply.code(400).send({ error: 'invalid', message: 'Save the fiskaly API key first.' });
    try {
      return await asAdmin(who.accountId, () => setup(who.accountId));
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Creates and initialises the account's TSS. Each step is saved before the next, so a failed setup picks up where it stopped. */
  async function setup(accountId: string) {
    const r = row(accountId)!;
    const s = secrets(r);
    const auth = await token(accountId, s);
    let tssId = r.tssId;
    let state = r.tssState;
    if (!tssId) {
      tssId = randomUUID();
      const created = await api.createTss(auth.token, tssId);
      s.adminPuk = created.adminPuk;
      state = created.state || 'CREATED';
      save(accountId, s, { tssId, tssState: state });
    }
    if (state === 'CREATED') {
      await api.setTssState(auth.token, tssId, 'UNINITIALIZED');
      state = 'UNINITIALIZED';
      save(accountId, s, { tssState: state });
    }
    if (state === 'UNINITIALIZED') {
      if (!s.adminPin) {
        const pin = String(randomInt(10 ** 9, 10 ** 10));
        await api.setAdminPin(auth.token, tssId, s.adminPuk!, pin);
        s.adminPin = pin;
        save(accountId, s);
      }
      await api.adminLogin(auth.token, tssId, s.adminPin);
      try {
        await api.setTssState(auth.token, tssId, 'INITIALIZED');
      } finally {
        await api.adminLogout(auth.token, tssId).catch(() => undefined);
      }
      state = 'INITIALIZED';
    }
    const tss = await api.getTss(auth.token, tssId);
    save(accountId, s, { tssState: String(tss.state ?? state), tssSerial: String(tss.serial_number ?? '') || null });
    const after = row(accountId)!;
    return { configured: true, env: after.env, tss: { id: after.tssId, state: after.tssState, serial: after.tssSerial } };
  }

  app.post<{ Body: { clientId?: unknown } }>('/fiskaly/start', async (req, reply) => {
    const { accountId } = ctx.identity(req);
    const serial = String(req.body?.clientId ?? '');
    if (!SERIAL.test(serial)) return reply.code(400).send({ error: 'invalid', message: 'The till serial number may not contain "/" or "_".' });
    try {
      const { s, tssId } = ready(accountId);
      const auth = await token(accountId, s);
      const clientId = await clientFor(accountId, auth, s, tssId, serial);
      const txId = randomUUID();
      const started = await api.startTx(auth.token, tssId, txId, clientId);
      db.prepare('INSERT OR REPLACE INTO fiskaly_tx (accountId, tssId, number, txId, clientId, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(accountId, tssId, started.number, txId, clientId, Date.now());
      return started;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Body: { clientId?: unknown; number?: unknown; processType?: unknown; processData?: unknown } }>('/fiskaly/finish', async (req, reply) => {
    const { accountId } = ctx.identity(req);
    const number = Number(req.body?.number);
    const processType = String(req.body?.processType ?? '');
    const processData = String(req.body?.processData ?? '');
    if (!Number.isInteger(number) || !processType || processData.length > 2000) return reply.code(400).send({ error: 'invalid', message: 'Incomplete TSE transaction.' });
    try {
      const { r, s, tssId } = ready(accountId);
      const tx = db.prepare('SELECT txId, clientId FROM fiskaly_tx WHERE accountId = ? AND tssId = ? AND number = ?').get(accountId, tssId, number) as { txId: string; clientId: string } | undefined;
      if (!tx) return reply.code(404).send({ error: 'not_found', message: 'No such TSE transaction was started.' });
      const auth = await token(accountId, s);
      const signed = await api.finishTx(auth.token, tssId, tx.txId, tx.clientId, processType, processData, auth.env || r.env);
      return signed;
    } catch (err) {
      return fail(reply, err);
    }
  });
}
