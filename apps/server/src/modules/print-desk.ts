import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ModuleContext, ServerModule } from '@zollify/server-core';

/**
 * Print Desk - the server half. Print Desk is the desktop app at the printer (apps/print-desk);
 * this module lets the account see and steer it from any device:
 *
 * - **Shared settings** (one document per account): targets, hidden items, print order, paper
 *   materials, global print settings. A change is a patch of top-level fields merged into the
 *   document, so two devices changing different settings never overwrite each other. Linked
 *   files are not here: their paths only mean something on the computer they are on.
 * - **Status** (one row per desk): what a desk reports every few seconds - its printer, the
 *   counts queued, the run in progress. A desk that stops reporting shows as offline.
 * - **Requests**: what someone asks a desk to do from another device - set its print counts, or
 *   print. A desk claims a request (one desk, once), does it and says how it went. Printing on
 *   request is the desk's to allow: a desk that has not switched it on refuses.
 *
 * Nothing pushes to a desk: it polls, and so does the web module while it is open.
 */

export const PRINT_DESK_MODULE_ID = 'print-desk';
/** A desk that has not reported for this long shows as offline. */
export const ONLINE_MS = 45_000;
/** A request nobody took within this long expires: the desk was off, and printing later would surprise. */
export const REQUEST_TTL_MS = 10 * 60_000;

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS print_desk_config (
      accountId TEXT PRIMARY KEY,
      doc       TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS print_desk_status (
      accountId TEXT NOT NULL,
      deviceId  TEXT NOT NULL,
      doc       TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, deviceId)
    );
    CREATE TABLE IF NOT EXISTS print_desk_requests (
      accountId TEXT NOT NULL,
      id        TEXT NOT NULL,
      deviceId  TEXT,
      kind      TEXT NOT NULL,
      payload   TEXT NOT NULL,
      status    TEXT NOT NULL,
      result    TEXT NOT NULL DEFAULT '',
      takenBy   TEXT,
      createdBy TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_print_desk_requests_open ON print_desk_requests(accountId, status, createdAt);
  `);
}

const Count = z.number().int().min(0).max(999);
const Key = z.string().min(1).max(120);
/** The settings that are shared. Each is optional: a patch names only what changed. */
export const ConfigPatch = z
  .object({
    target: Count,
    sizeTargets: z.record(z.string().max(20), Count),
    itemTargets: z.record(Key, Count),
    hidden: z.array(Key).max(5000),
    order: z.array(Key).max(5000),
    paperMaterials: z.record(z.string().max(20), z.string().max(120)),
    global: z.record(z.string(), z.unknown()).nullable(),
    addToStock: z.boolean(),
    units: z.enum(['cm', 'mm', 'in']),
  })
  .partial()
  .strict();
export type PrintDeskConfig = z.infer<typeof ConfigPatch>;

/** What a desk reports: free-form for the web module to show, bounded in size. */
const Status = z
  .object({
    name: z.string().max(80),
    version: z.string().max(40).optional(),
    email: z.string().max(200).optional(),
    allowRemote: z.boolean(),
    printer: z.string().max(200).optional(),
    counts: z.record(Key, Count).default({}),
    run: z
      .array(z.object({ key: Key, copies: Count, printed: Count, left: Count, status: z.string().max(300), done: z.boolean(), failed: z.boolean().optional(), cancelled: z.boolean().optional() }))
      .max(500)
      .default([]),
    paper: z.record(z.string().max(20), z.object({ needed: z.number().min(0), onHand: z.number().nullable() })).default({}),
    busy: z.string().max(200).optional(),
    error: z.string().max(500).optional(),
    /** What the printer asks for before it goes on (its driver's prompt: "Starting manual feed printing."). */
    waiting: z.string().max(500).optional(),
    /** The copy that waits ("Kyoto A3, copy 2 of 5"). */
    waitingFor: z.string().max(160).optional(),
  })
  .strict();
type StatusDoc = z.infer<typeof Status>;

const RequestBody = z.discriminatedUnion('kind', [
  /** Set the desk's print counts; items not named go to 0. */
  z.object({ kind: z.literal('counts'), deviceId: z.string().max(120).nullable().optional(), counts: z.record(Key, Count) }),
  /** Print what is queued (one paper size when given), as the desk's own Print button does. */
  z.object({ kind: z.literal('print'), deviceId: z.string().max(120).nullable().optional(), onlySize: z.string().max(20).optional() }),
]);
const Outcome = z.object({ status: z.enum(['done', 'failed', 'refused']), result: z.string().max(500).default('') });
const Claim = z.object({ deviceId: z.string().min(1).max(120) });

const RANK: Record<string, number> = { member: 0, admin: 1, owner: 2 };
const isAdmin = (role: string): boolean => (RANK[role] ?? 0) >= RANK.admin!;

export function readConfig(db: Database.Database, accountId: string): { config: PrintDeskConfig; updatedAt: number } {
  const row = db.prepare('SELECT doc, updatedAt FROM print_desk_config WHERE accountId = ?').get(accountId) as { doc: string; updatedAt: number } | undefined;
  return row ? { config: JSON.parse(row.doc) as PrintDeskConfig, updatedAt: row.updatedAt } : { config: {}, updatedAt: 0 };
}

interface RequestRow {
  id: string;
  deviceId: string | null;
  kind: string;
  payload: string;
  status: string;
  result: string;
  takenBy: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}
const requestView = (r: RequestRow) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> });

function routes(ctx: ModuleContext): FastifyPluginAsync {
  return async (app) => {
    const { db } = ctx;
    const forbidden = { error: 'forbidden', message: 'Only owners and admins can change Print Desk or send it requests.' };
    /** Requests left untaken too long, closed as expired rather than printed late. */
    const expire = (accountId: string): void => {
      const now = Date.now();
      db.prepare("UPDATE print_desk_requests SET status = 'expired', result = 'No desk took it in time.', updatedAt = ? WHERE accountId = ? AND status = 'pending' AND createdAt < ?").run(now, accountId, now - REQUEST_TTL_MS);
    };

    app.get('/config', async (req) => readConfig(db, ctx.identity(req).accountId));

    /** Merges the named settings into the account's document, the rest as it was. */
    app.put('/config', async (req, reply) => {
      const who = ctx.identity(req);
      if (!isAdmin(who.role)) return reply.code(403).send(forbidden);
      const patch = ConfigPatch.safeParse(req.body);
      if (!patch.success) return reply.code(400).send({ error: 'invalid_request', message: 'Check the Print Desk settings.' });
      const merge = db.transaction(() => {
        const { config } = readConfig(db, who.accountId);
        const next = { ...config, ...patch.data };
        const now = Date.now();
        db.prepare('INSERT INTO print_desk_config (accountId, doc, updatedAt) VALUES (?, ?, ?) ON CONFLICT(accountId) DO UPDATE SET doc = excluded.doc, updatedAt = excluded.updatedAt').run(who.accountId, JSON.stringify(next), now);
        return { config: next, updatedAt: now };
      });
      return merge();
    });

    app.put<{ Params: { deviceId: string } }>('/status/:deviceId', async (req, reply) => {
      const who = ctx.identity(req);
      const body = Status.safeParse(req.body);
      if (!body.success || req.params.deviceId.length > 120) return reply.code(400).send({ error: 'invalid_request', message: 'Check the status report.' });
      const before = db.prepare('SELECT doc FROM print_desk_status WHERE accountId = ? AND deviceId = ?').get(who.accountId, req.params.deviceId) as { doc: string } | undefined;
      const was = before ? (JSON.parse(before.doc) as StatusDoc) : null;
      const now = body.data;
      // The printer started waiting for someone, or a next copy does: tell the devices that asked.
      if (now.waiting && (now.waiting !== was?.waiting || now.waitingFor !== was?.waitingFor)) {
        ctx.notify(who.accountId, {
          title: `Printer waiting${now.waitingFor ? `: ${now.waitingFor}` : ''}`,
          body: `${now.name}: ${now.waiting}`,
          link: '/m/print-desk',
          kind: 'print-desk',
          level: 'low',
        });
      }
      db.prepare('INSERT INTO print_desk_status (accountId, deviceId, doc, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(accountId, deviceId) DO UPDATE SET doc = excluded.doc, updatedAt = excluded.updatedAt').run(who.accountId, req.params.deviceId, JSON.stringify(body.data), Date.now());
      return { ok: true };
    });

    /** Every desk that ever reported, newest first, with whether it is online now. */
    app.get('/status', async (req) => {
      const rows = db.prepare('SELECT deviceId, doc, updatedAt FROM print_desk_status WHERE accountId = ? ORDER BY updatedAt DESC').all(ctx.identity(req).accountId) as { deviceId: string; doc: string; updatedAt: number }[];
      const now = Date.now();
      return { now, desks: rows.map((r) => ({ deviceId: r.deviceId, updatedAt: r.updatedAt, online: now - r.updatedAt < ONLINE_MS, ...(JSON.parse(r.doc) as object) })) };
    });

    app.delete<{ Params: { deviceId: string } }>('/status/:deviceId', async (req, reply) => {
      const who = ctx.identity(req);
      if (!isAdmin(who.role)) return reply.code(403).send(forbidden);
      db.prepare('DELETE FROM print_desk_status WHERE accountId = ? AND deviceId = ?').run(who.accountId, req.params.deviceId);
      return { ok: true };
    });

    /** Asks a desk (or whichever desk takes it first) to set its counts or print. */
    app.post('/requests', async (req, reply) => {
      const who = ctx.identity(req);
      if (!isAdmin(who.role)) return reply.code(403).send(forbidden);
      const body = RequestBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Say what the desk should do.' });
      const { kind, deviceId, ...payload } = body.data;
      const now = Date.now();
      const id = randomUUID();
      db.prepare('INSERT INTO print_desk_requests (accountId, id, deviceId, kind, payload, status, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        who.accountId, id, deviceId ?? null, kind, JSON.stringify(payload), 'pending', who.userId, now, now,
      );
      return reply.code(201).send({ request: requestView(db.prepare('SELECT * FROM print_desk_requests WHERE accountId = ? AND id = ?').get(who.accountId, id) as RequestRow) });
    });

    /** The latest requests, for the web module; with `deviceId`, the ones still waiting for that desk. */
    app.get<{ Querystring: { deviceId?: string } }>('/requests', async (req) => {
      const who = ctx.identity(req);
      expire(who.accountId);
      const rows = req.query.deviceId
        ? (db.prepare("SELECT * FROM print_desk_requests WHERE accountId = ? AND status = 'pending' AND (deviceId IS NULL OR deviceId = ?) ORDER BY createdAt").all(who.accountId, req.query.deviceId) as RequestRow[])
        : (db.prepare('SELECT * FROM print_desk_requests WHERE accountId = ? ORDER BY createdAt DESC LIMIT 20').all(who.accountId) as RequestRow[]);
      return { requests: rows.map(requestView) };
    });

    /** A desk takes a request: only one desk, once. 409 when another took it or it is no longer open. */
    app.post<{ Params: { id: string } }>('/requests/:id/claim', async (req, reply) => {
      const who = ctx.identity(req);
      const body = Claim.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      expire(who.accountId);
      const res = db
        .prepare("UPDATE print_desk_requests SET status = 'taken', takenBy = ?, updatedAt = ? WHERE accountId = ? AND id = ? AND status = 'pending' AND (deviceId IS NULL OR deviceId = ?)")
        .run(body.data.deviceId, Date.now(), who.accountId, req.params.id, body.data.deviceId);
      if (!res.changes) return reply.code(409).send({ error: 'not_open', message: 'Another desk took it, or it is no longer open.' });
      return { ok: true };
    });

    /** The desk that took a request says how it went. */
    app.post<{ Params: { id: string } }>('/requests/:id/outcome', async (req, reply) => {
      const who = ctx.identity(req);
      const body = Outcome.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const res = db
        .prepare("UPDATE print_desk_requests SET status = ?, result = ?, updatedAt = ? WHERE accountId = ? AND id = ? AND status = 'taken'")
        .run(body.data.status, body.data.result, Date.now(), who.accountId, req.params.id);
      if (!res.changes) return reply.code(409).send({ error: 'not_taken', message: 'That request is not being worked on.' });
      return { ok: true };
    });
  };
}

export const printDeskServerModule: ServerModule = {
  id: PRINT_DESK_MODULE_ID,
  // Anyone may see the desks; changing settings and sending requests is checked per route (admins).
  minRole: 'member',
  migrate,
  routes,
  onAccountDeleted(db, accountId) {
    for (const table of ['print_desk_config', 'print_desk_status', 'print_desk_requests']) db.prepare(`DELETE FROM ${table} WHERE accountId = ?`).run(accountId);
  },
};
