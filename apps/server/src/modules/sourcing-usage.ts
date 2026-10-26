import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ModuleContext, ModuleServices, PublicModuleContext } from '@zollify/server-core';

/**
 * Materials on hand - paper, ink, packaging used up by printing at home.
 *
 * What is on hand is everything bought (a material's purchases) less
 * everything used, and a use is a row here: logged by hand, sent by the
 * printing app as it prints, or the difference a recount found. Kept apart
 * from products: paper is not for sale, it is spent.
 *
 * The printing app reaches this with a printer key made under Sourcing →
 * Materials. A key can do two things only - list the materials and log a
 * use - and nothing else of the account; it is stored hashed, shown once,
 * and can be revoked at any time.
 */

export type UseSource = 'manual' | 'printer' | 'count';
export interface MaterialUse {
  id: string;
  materialId: string;
  qty: number;
  at: number;
  source: UseSource;
  note: string;
}
export interface MaterialUsage {
  /** Everything used, recounts included (a recount that found more is a negative use). */
  used: number;
  /** The latest uses, newest first. */
  recent: MaterialUse[];
}
export interface PrinterKey {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

const RECENT = 10;
const KEY_PREFIX = 'zpk_';
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function migrateUsage(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sourcing_material_use (
      accountId  TEXT NOT NULL,
      id         TEXT NOT NULL,
      materialId TEXT NOT NULL,
      qty        REAL NOT NULL,
      at         INTEGER NOT NULL,
      source     TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      keyId      TEXT,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_sourcing_use_material ON sourcing_material_use(accountId, materialId, at);
    CREATE TABLE IF NOT EXISTS sourcing_keys (
      accountId  TEXT NOT NULL,
      id         TEXT NOT NULL,
      label      TEXT NOT NULL,
      hash       TEXT NOT NULL UNIQUE,
      createdAt  INTEGER NOT NULL,
      lastUsedAt INTEGER,
      PRIMARY KEY (accountId, id)
    );
  `);
}

export const USAGE_TABLES = ['sourcing_material_use', 'sourcing_keys'];

interface MaterialDoc {
  id: string;
  name: string;
  type?: string;
  unit?: string;
  lowAt?: number;
  purchases?: { qty?: number }[];
}

function materialsOf(db: Database.Database, accountId: string): MaterialDoc[] {
  return (db.prepare("SELECT doc FROM sourcing_docs WHERE accountId = ? AND coll = 'materials'").all(accountId) as { doc: string }[]).map((r) => JSON.parse(r.doc) as MaterialDoc);
}

const bought = (m: MaterialDoc): number => (m.purchases ?? []).reduce((s, p) => s + (Number(p.qty) || 0), 0);
const round = (n: number): number => Math.round(n * 1000) / 1000;

function usedOf(db: Database.Database, accountId: string, materialId: string): number {
  return (db.prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM sourcing_material_use WHERE accountId = ? AND materialId = ?').get(accountId, materialId) as { n: number }).n;
}

export const onHandOf = (db: Database.Database, accountId: string, m: MaterialDoc): number => round(bought(m) - usedOf(db, accountId, m.id));

/** Per material: what was used and the latest uses - for the snapshot. */
export function usageSnapshot(db: Database.Database, accountId: string): Record<string, MaterialUsage> {
  const out: Record<string, MaterialUsage> = {};
  const totals = db.prepare('SELECT materialId, SUM(qty) AS used FROM sourcing_material_use WHERE accountId = ? GROUP BY materialId').all(accountId) as { materialId: string; used: number }[];
  const recent = db.prepare('SELECT id, materialId, qty, at, source, note FROM sourcing_material_use WHERE accountId = ? AND materialId = ? ORDER BY at DESC LIMIT ?');
  for (const t of totals) out[t.materialId] = { used: round(t.used), recent: recent.all(accountId, t.materialId, RECENT) as MaterialUse[] };
  return out;
}

/**
 * Logs a use. A client-chosen id makes a retried send from the printing app
 * count once. Tells the account when the material drops to its low mark.
 */
function logUse(
  svc: Pick<ModuleServices, 'db' | 'notify'>,
  accountId: string,
  m: MaterialDoc,
  use: { id?: string; qty: number; source: UseSource; note?: string; keyId?: string },
): { duplicate: boolean; onHand: number } {
  const before = onHandOf(svc.db, accountId, m);
  const res = svc.db
    .prepare('INSERT OR IGNORE INTO sourcing_material_use (accountId, id, materialId, qty, at, source, note, keyId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(accountId, use.id ?? crypto.randomUUID(), m.id, use.qty, Date.now(), use.source, (use.note ?? '').slice(0, 200), use.keyId ?? null);
  const onHand = onHandOf(svc.db, accountId, m);
  if (res.changes && typeof m.lowAt === 'number' && before > m.lowAt && onHand <= m.lowAt) {
    svc.notify(accountId, {
      kind: 'other',
      level: 'normal',
      title: `${m.name} is running low`,
      body: `${onHand} ${m.unit ?? 'unit'}${onHand === 1 ? '' : 's'} left - time to order more.`,
      link: '/m/sourcing?tab=materials',
      minRole: 'admin',
    });
  }
  return { duplicate: !res.changes, onHand };
}

const UseBody = z.object({ qty: z.number().positive().max(100_000), note: z.string().trim().max(200).optional() });
const CountBody = z.object({ onHand: z.number().min(0).max(10_000_000) });
const KeyBody = z.object({ label: z.string().trim().min(1).max(60) });

/** The owner's side: log a use by hand, recount, undo a use, and manage printer keys. */
export function registerUsage(app: FastifyInstance, ctx: ModuleContext): void {
  const find = (accountId: string, id: string) => materialsOf(ctx.db, accountId).find((m) => m.id === id);

  app.post<{ Params: { id: string } }>('/materials/:id/use', async (req, reply) => {
    const who = ctx.identity(req);
    const m = find(who.accountId, req.params.id);
    if (!m) return reply.code(404).send({ error: 'not_found' });
    const body = UseBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'How many were used?' });
    const { onHand } = logUse(ctx, who.accountId, m, { qty: body.data.qty, source: 'manual', note: body.data.note });
    return { onHand, usage: usageSnapshot(ctx.db, who.accountId)[m.id] ?? { used: 0, recent: [] } };
  });

  /** A recount: the difference to what the books say becomes a use (negative when more was found). */
  app.post<{ Params: { id: string } }>('/materials/:id/count', async (req, reply) => {
    const who = ctx.identity(req);
    const m = find(who.accountId, req.params.id);
    if (!m) return reply.code(404).send({ error: 'not_found' });
    const body = CountBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'How many are there?' });
    const diff = round(onHandOf(ctx.db, who.accountId, m) - body.data.onHand);
    if (diff !== 0) logUse(ctx, who.accountId, m, { qty: diff, source: 'count', note: `Counted ${body.data.onHand}` });
    return { onHand: onHandOf(ctx.db, who.accountId, m), usage: usageSnapshot(ctx.db, who.accountId)[m.id] ?? { used: 0, recent: [] } };
  });

  app.delete<{ Params: { id: string } }>('/usage/:id', async (req) => {
    const who = ctx.identity(req);
    ctx.db.prepare('DELETE FROM sourcing_material_use WHERE accountId = ? AND id = ?').run(who.accountId, req.params.id);
    return { ok: true };
  });

  app.get('/keys', async (req) => {
    const who = ctx.identity(req);
    return { keys: ctx.db.prepare('SELECT id, label, createdAt, lastUsedAt FROM sourcing_keys WHERE accountId = ? ORDER BY createdAt').all(who.accountId) as PrinterKey[] };
  });

  /** A new printer key. Its secret is in this answer only; the server keeps a hash. */
  app.post('/keys', async (req, reply) => {
    const who = ctx.identity(req);
    const body = KeyBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Name the printer or computer the key is for.' });
    const count = (ctx.db.prepare('SELECT COUNT(*) AS n FROM sourcing_keys WHERE accountId = ?').get(who.accountId) as { n: number }).n;
    if (count >= 20) return reply.code(409).send({ error: 'too_many', message: 'Revoke a printer key you no longer use first.' });
    const secret = `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
    const key: PrinterKey = { id: crypto.randomUUID(), label: body.data.label, createdAt: Date.now(), lastUsedAt: null };
    ctx.db.prepare('INSERT INTO sourcing_keys (accountId, id, label, hash, createdAt) VALUES (?, ?, ?, ?, ?)').run(who.accountId, key.id, key.label, sha256(secret), key.createdAt);
    return reply.code(201).send({ key, secret });
  });

  app.delete<{ Params: { id: string } }>('/keys/:id', async (req) => {
    const who = ctx.identity(req);
    ctx.db.prepare('DELETE FROM sourcing_keys WHERE accountId = ? AND id = ?').run(who.accountId, req.params.id);
    return { ok: true };
  });
}

/** Drops a removed material's uses with it. */
export function forgetMaterialUse(db: Database.Database, accountId: string, materialId: string): void {
  db.prepare('DELETE FROM sourcing_material_use WHERE accountId = ? AND materialId = ?').run(accountId, materialId);
}

const PrintBody = z.object({
  /** The material's id, or its name (any case). */
  material: z.string().trim().min(1).max(120),
  qty: z.number().positive().max(100_000),
  note: z.string().trim().max(200).optional(),
  /** The print job's own id: sending it again counts once. */
  id: z.string().trim().min(8).max(80).optional(),
});

/**
 * The printing app's side, at /p/sourcing/…: a printer key in the
 * Authorization header (`Bearer zpk_…`), and only these two calls.
 */
export function registerPrinterApi(app: FastifyInstance, ctx: PublicModuleContext): void {
  const limit = { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } };
  const keyOf = (req: FastifyRequest): { accountId: string; id: string } | null => {
    const raw = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!raw.startsWith(KEY_PREFIX)) return null;
    const row = ctx.db.prepare('SELECT accountId, id FROM sourcing_keys WHERE hash = ?').get(sha256(raw)) as { accountId: string; id: string } | undefined;
    if (!row || !ctx.isEnabled(row.accountId)) return null;
    ctx.db.prepare('UPDATE sourcing_keys SET lastUsedAt = ? WHERE accountId = ? AND id = ?').run(Date.now(), row.accountId, row.id);
    return row;
  };
  const refused = { error: 'unauthorized', message: 'That printer key is not valid, was revoked, or Sourcing is switched off.' };
  const view = (accountId: string, m: MaterialDoc) => ({ id: m.id, name: m.name, type: m.type ?? 'other', unit: m.unit ?? 'unit', onHand: onHandOf(ctx.db, accountId, m), ...(typeof m.lowAt === 'number' ? { lowAt: m.lowAt } : {}) });

  app.get('/materials', limit, async (req, reply) => {
    const key = keyOf(req);
    if (!key) return reply.code(401).send(refused);
    return { materials: materialsOf(ctx.db, key.accountId).map((m) => view(key.accountId, m)) };
  });

  app.post('/usage', limit, async (req, reply) => {
    const key = keyOf(req);
    if (!key) return reply.code(401).send(refused);
    const body = PrintBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Send the material (id or name) and a quantity above zero.' });
    const wanted = body.data.material.toLowerCase();
    const all = materialsOf(ctx.db, key.accountId);
    const m = all.find((x) => x.id === body.data.material) ?? all.find((x) => x.name.trim().toLowerCase() === wanted);
    if (!m) return reply.code(404).send({ error: 'unknown_material', message: `No material "${body.data.material}". Add it under Sourcing → Materials, or send its id.` });
    const { duplicate, onHand } = logUse(ctx, key.accountId, m, { id: body.data.id && `print-${body.data.id}`, qty: body.data.qty, source: 'printer', note: body.data.note, keyId: key.id });
    return reply.code(duplicate ? 200 : 201).send({ material: { ...view(key.accountId, m), onHand }, duplicate });
  });
}
