import { gzipSync } from 'node:zlib';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { PushRequestSchema, STAFF_OP_TYPES, type PullResponse, type PushResponse, type ServerOp, type WireOp } from '@zollify/shared';
import type { JwtClaims } from '../auth';
import { bumpMetric, touchDevice } from '../db';
import type { Rooms } from '../ws';

/** A change the server itself makes to an account's data, on a module's behalf. */
export interface ServerOpInput {
  type: WireOp['type'];
  payload: unknown;
}

/**
 * Appends ops to an account's log as if a device had pushed them, then rings
 * the account's devices so they pull. Used where the server acts for someone
 * else - an artist restocking their shelf in a store's account, say. Each op
 * gets a fresh id and the device id `server:<origin>`, so it is always clear
 * in the log what the server wrote.
 */
export function appendOps(db: Database.Database, rooms: Rooms, accountId: string, origin: string, ops: ServerOpInput[]): number {
  if (!ops.length) return 0;
  const deviceId = `server:${origin}`;
  const latest = db.transaction(() => {
    let seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM ops WHERE accountId = ?').get(accountId) as { m: number }).m;
    const insert = db.prepare('INSERT INTO ops (accountId, seq, opId, deviceId, ts, type, payload, receivedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const op of ops) {
      seq++;
      insert.run(accountId, seq, `srv-${randomUUID()}`, deviceId, Date.now(), op.type, JSON.stringify(op.payload ?? null), Date.now());
    }
    return seq;
  })();
  rooms.nudge(accountId, latest);
  return ops.length;
}

/**
 * What a plain member - store staff - may change: sales, refunds and claims.
 * The catalogue, prices, discounts, events and settings are the owner's and
 * admins'. Their screens already hide those; this is the guarantee.
 */
const STAFF_TYPES = new Set(STAFF_OP_TYPES);

export function registerSyncRoutes(
  app: FastifyInstance,
  db: Database.Database,
  rooms: Rooms,
  onOps: (accountId: string, ops: WireOp[]) => void = () => {},
): void {
  const insertOp = db.prepare(
    `INSERT OR IGNORE INTO ops (accountId, seq, opId, deviceId, ts, type, payload, receivedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM ops WHERE accountId = ?');

  // Per-user event restriction (server-enforced isolation for a "helper" member).
  const getAllowedEvents = db.prepare('SELECT allowedEventIds FROM users WHERE id = ?');
  const getEpoch = db.prepare('SELECT syncEpoch FROM accounts WHERE id = ?');
  const txEventOf = db.prepare(
    `SELECT json_extract(payload, '$.eventId') AS eid FROM ops
     WHERE accountId = ? AND type = 'tx.create' AND json_extract(payload, '$.id') = ? LIMIT 1`,
  );
  // Parse the JSON array of allowed event ids; null/empty ⇒ unrestricted (full access).
  function restrictionFor(userId: string): Set<string> | null {
    const raw = (getAllowedEvents.get(userId) as { allowedEventIds: string | null } | undefined)?.allowedEventIds;
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr) && arr.length) return new Set(arr.map(String));
    } catch { /* treat as unrestricted */ }
    return null;
  }
  // Catalog + account config that every seller needs regardless of event.
  const GLOBAL_TYPES = new Set(['product.upsert', 'product.delete', 'product.merge', 'discount.upsert', 'discount.delete', 'image.meta', 'setting.upsert']);
  const eventIdOf = (op: { type: string; payload: unknown }): string | undefined => {
    const p = op.payload as Record<string, unknown> | null;
    if (!p) return undefined;
    if (op.type === 'event.upsert') return p.id as string;
    return p.eventId as string | undefined; // event.close, tx.create, stock.set
  };
  // Which ops a restricted user is allowed to RECEIVE.
  function opReadable(accountId: string, allowed: Set<string>, op: { type: string; payload: unknown }): boolean {
    if (GLOBAL_TYPES.has(op.type)) return true;
    if (op.type === 'tx.revert') {
      const txId = (op.payload as { txId?: string } | null)?.txId;
      const row = txId ? (txEventOf.get(accountId, txId) as { eid?: string } | undefined) : undefined;
      return !!row?.eid && allowed.has(row.eid);
    }
    const eid = eventIdOf(op);
    return !!eid && allowed.has(eid);
  }
  // Which ops a restricted user is allowed to WRITE: only sales/stock for their
  // events (never catalog, discounts, other events, or account settings).
  function opWritable(accountId: string, allowed: Set<string>, op: { type: string; payload: unknown }, batch: { type: string; payload: unknown }[]): boolean {
    if (op.type === 'tx.revert') {
      // Only a sale of one of their events: one already on the server, or one in this same push.
      const txId = (op.payload as { txId?: string } | null)?.txId;
      if (!txId) return false;
      const inBatch = batch.find((o) => o.type === 'tx.create' && (o.payload as { id?: string } | null)?.id === txId);
      const eid = inBatch ? eventIdOf(inBatch) : (txEventOf.get(accountId, txId) as { eid?: string } | undefined)?.eid;
      return !!eid && allowed.has(eid);
    }
    if (op.type === 'tx.create' || op.type === 'stock.set') {
      const eid = eventIdOf(op);
      return !!eid && allowed.has(eid);
    }
    return false;
  }

  app.post('/api/sync/push', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const parsed = PushRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid push' });
    const { deviceId, deviceName, flavor, ops: rawOps } = parsed.data;

    // Restricted "helper" members may only write sales/stock for their events.
    // Disallowed ops are DROPPED (not stored), never rejected with 403 - a 403
    // would wedge the client's outbox into a permanent retry loop (offline).
    const allowed = restrictionFor(claims.sub);
    const scoped = allowed ? rawOps.filter((op) => opWritable(claims.accountId, allowed, op, rawOps)) : rawOps;
    const staff = claims.role === 'member';
    const ops = (staff ? scoped.filter((op) => STAFF_TYPES.has(op.type)) : scoped).map((op) => stampSeller(db, op, claims, staff, deviceId));
    const dropped = rawOps.length - ops.length;
    if (dropped > 0) req.log.warn({ userId: claims.sub, dropped }, 'dropped ops outside what this user may change');

    let accepted = 0;
    let txCount = 0;
    /** Ops the server did not have yet: what onOps hears, so a retried push is never announced twice. */
    const fresh: typeof ops = [];
    const result = db.transaction((): PushResponse => {
      let seq = (maxSeq.get(claims.accountId) as { m: number }).m;
      for (const op of ops) {
        const r = insertOp.run(
          claims.accountId,
          seq + 1,
          op.opId,
          op.deviceId,
          op.ts,
          op.type,
          JSON.stringify(op.payload ?? null),
          Date.now(),
        );
        if (r.changes > 0) {
          seq++;
          accepted++;
          fresh.push(op);
          if (op.type === 'tx.create') txCount++;
        }
      }
      touchDevice(db, deviceId, claims.accountId, claims.sub, deviceName ?? null, flavor ?? null, Date.now());
      return { accepted, duplicates: rawOps.length - accepted, latestSeq: seq };
    })();

    bumpMetric(db, claims.accountId, 'syncPushes');
    if (accepted > 0) {
      bumpMetric(db, claims.accountId, 'opsReceived', accepted);
      if (txCount > 0) bumpMetric(db, claims.accountId, 'txCount', txCount);
      rooms.nudge(claims.accountId, result.latestSeq, deviceId);
      try {
        onOps(claims.accountId, fresh);
      } catch (err) {
        req.log.error({ err }, 'a module failed to handle pushed ops');
      }
    }
    return result;
  });

  app.get('/api/sync/pull', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const query = req.query as { since?: string; limit?: string; device?: string };
    const since = Number(query.since ?? 0) || 0;
    const limit = Math.min(Number(query.limit ?? 500) || 500, 1000);
    // The caller's own ops: it made them and already has them. Sending them
    // back doubled the traffic of every sale (push it, then pull it again).
    const skipDevice = typeof query.device === 'string' && query.device ? query.device : null;

    const rows = (
      skipDevice
        ? db
            .prepare('SELECT seq, opId, deviceId, ts, type, payload FROM ops WHERE accountId = ? AND seq > ? AND deviceId != ? ORDER BY seq LIMIT ?')
            .all(claims.accountId, since, skipDevice, limit)
        : db
            .prepare('SELECT seq, opId, deviceId, ts, type, payload FROM ops WHERE accountId = ? AND seq > ? ORDER BY seq LIMIT ?')
            .all(claims.accountId, since, limit)
    ) as {
      seq: number;
      opId: string;
      deviceId: string;
      ts: number;
      type: string;
      payload: string;
    }[];

    let ops: ServerOp[] = rows.map((r) => ({
      serverSeq: r.seq,
      opId: r.opId,
      deviceId: r.deviceId,
      ts: r.ts,
      type: r.type as ServerOp['type'],
      payload: JSON.parse(r.payload),
    }));
    // Server-enforced isolation: a restricted user only receives the catalog +
    // their one event's data. Safe with the client cursor, which advances toward
    // latestSeq and treats a filtered-empty page as "caught up".
    const allowed = restrictionFor(claims.sub);
    if (allowed) ops = ops.filter((op) => opReadable(claims.accountId, allowed, op));

    const latestSeq = (maxSeq.get(claims.accountId) as { m: number }).m;
    const epoch = (getEpoch.get(claims.accountId) as { syncEpoch?: number } | undefined)?.syncEpoch ?? 0;
    const response: PullResponse = { ops, latestSeq, epoch, ...(skipDevice && rows.length < limit ? { caughtUp: true } : {}) };
    return sendJson(req.headers['accept-encoding'], reply, response);
  });
}

const emailOf = (db: Database.Database, userId: string): string | null =>
  (db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined)?.email ?? null;

/**
 * Who made a sale is the signed-in user who pushed it - never what the
 * device claimed. Staff are stamped always; an admin's own sales too, except
 * an import of old sales that already name someone.
 *
 * On a shared till the push can come from someone else than the seller (the
 * person who rang it up locked the till before it synced). A sale naming a
 * colleague who was added to this very device, with their password, keeps
 * that name.
 */
function stampSeller(db: Database.Database, op: WireOp, claims: JwtClaims, staff: boolean, deviceId: string): WireOp {
  if (op.type !== 'tx.create' || !op.payload || typeof op.payload !== 'object') return op;
  const payload = op.payload as { soldBy?: { userId?: string } };
  const named = payload.soldBy?.userId;
  // A sale recorded at a shared till, in the name of someone unlocked there: only believed
  // when the push really comes from that till - the device id in the body is the client's word.
  if (named && named !== claims.sub && pushedFromDevice(db, claims, deviceId) && boundToDevice(db, claims.accountId, deviceId, named)) {
    return { ...op, payload: { ...payload, soldBy: { userId: named, email: emailOf(db, named) } } };
  }
  if (!staff && named) return op;
  return { ...op, payload: { ...payload, soldBy: { userId: claims.sub, email: emailOf(db, claims.sub) } } };
}

/** The pusher is signed in on this device: a till token for it, or a live session that signed in there. */
function pushedFromDevice(db: Database.Database, claims: JwtClaims, deviceId: string): boolean {
  if (claims.till !== undefined) return claims.till === deviceId;
  return !!db.prepare('SELECT 1 FROM refresh_tokens WHERE userId = ? AND deviceId = ? AND expiresAt > ?').get(claims.sub, deviceId, Date.now());
}

function boundToDevice(db: Database.Database, accountId: string, deviceId: string, userId: string): boolean {
  return !!db.prepare('SELECT 1 FROM device_users WHERE accountId = ? AND deviceId = ? AND userId = ?').get(accountId, deviceId, userId);
}

/**
 * Gzipped when the client takes it and it is worth it. Op payloads are
 * repetitive JSON and shrink several times over - the difference between a
 * first sync on venue Wi-Fi taking seconds or minutes.
 */
function sendJson(acceptEncoding: string | string[] | undefined, reply: FastifyReply, body: unknown) {
  const json = JSON.stringify(body);
  const accepts = String(acceptEncoding ?? '').split(',').some((e) => e.trim().split(';')[0] === 'gzip');
  if (!accepts || json.length < 1024) return reply.type('application/json; charset=utf-8').send(json);
  return reply
    .header('content-encoding', 'gzip')
    .header('vary', 'accept-encoding')
    .type('application/json; charset=utf-8')
    .send(gzipSync(json));
}
