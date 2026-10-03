import { gzipSync } from 'node:zlib';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import { PushRequestSchema, type PullResponse, type PushResponse, type ServerOp } from '@zollify/shared';
import type { JwtClaims } from '../auth';
import { bumpMetric, touchDevice } from '../db';
import type { Rooms } from '../ws';

export function registerSyncRoutes(app: FastifyInstance, db: Database.Database, rooms: Rooms): void {
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
  function opWritable(allowed: Set<string>, op: { type: string; payload: unknown }): boolean {
    if (op.type === 'tx.revert') return true; // only reverts a tx already on their device
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
    const ops = allowed ? rawOps.filter((op) => opWritable(allowed, op)) : rawOps;
    const dropped = rawOps.length - ops.length;
    if (dropped > 0) req.log.warn({ userId: claims.sub, dropped }, 'dropped ops outside helper event scope');

    let accepted = 0;
    let txCount = 0;
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
