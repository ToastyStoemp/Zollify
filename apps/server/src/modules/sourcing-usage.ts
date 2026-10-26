import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUnitCost, recipeCost, type CostedMaterial, type Product, type RecipeUse } from '@zollify/shared';
import { reduceProducts, type ModuleContext, type ModuleServices, type PublicModuleContext } from '@zollify/server-core';

/**
 * Materials on hand - paper, ink, packaging used up by printing at home.
 *
 * What is on hand is everything received (a material's purchases, or the
 * deliveries logged against one that came in parts) less
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
    CREATE TABLE IF NOT EXISTS sourcing_settings (
      accountId TEXT PRIMARY KEY,
      doc       TEXT NOT NULL
    );
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

export const USAGE_TABLES = ['sourcing_material_use', 'sourcing_keys', 'sourcing_settings'];

interface MaterialDoc {
  id: string;
  name: string;
  type?: string;
  unit?: string;
  lowAt?: number;
  purchases?: { id?: string; qty?: number; cost?: number; date?: string; deliveries?: { qty?: number; date?: string }[] }[];
}
interface DossierDoc {
  id: string;
  title: string;
  pid: string | null;
  vid: string | null;
  recipe?: RecipeUse[];
}

/** The material as the costing reads it (see material-cost.ts in shared). */
const costed = (m: MaterialDoc): CostedMaterial => ({
  id: m.id,
  purchases: (m.purchases ?? []).map((p, i) => ({
    id: p.id ?? String(i),
    qty: Number(p.qty) || 0,
    cost: Number(p.cost) || 0,
    date: p.date,
    ...(p.deliveries ? { deliveries: p.deliveries.map((d) => ({ qty: Number(d.qty) || 0, date: d.date ?? '' })) } : {}),
  })),
});
function dossiersOf(db: Database.Database, accountId: string): DossierDoc[] {
  return (db.prepare("SELECT doc FROM sourcing_docs WHERE accountId = ? AND coll = 'dossiers'").all(accountId) as { doc: string }[]).map((r) => JSON.parse(r.doc) as DossierDoc);
}

function materialsOf(db: Database.Database, accountId: string): MaterialDoc[] {
  return (db.prepare("SELECT doc FROM sourcing_docs WHERE accountId = ? AND coll = 'materials'").all(accountId) as { doc: string }[]).map((r) => JSON.parse(r.doc) as MaterialDoc);
}

/** What has arrived: an order logging its deliveries counts those, any other all it ordered. */
const received = (p: NonNullable<MaterialDoc['purchases']>[number]): number =>
  p.deliveries ? p.deliveries.reduce((s, d) => s + (Number(d.qty) || 0), 0) : Number(p.qty) || 0;
const bought = (m: MaterialDoc): number => (m.purchases ?? []).reduce((s, p) => s + received(p), 0);
const onOrder = (m: MaterialDoc): number => round((m.purchases ?? []).reduce((s, p) => s + Math.max(0, (Number(p.qty) || 0) - received(p)), 0));
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

// ── Product costs that follow the batches ───────────────────────────────────

export interface CostSettings {
  /** Write each linked product's cost from its recipe whenever a batch runs out or prices change. */
  followCosts: boolean;
}
export function costSettings(db: Database.Database, accountId: string): CostSettings {
  const row = db.prepare('SELECT doc FROM sourcing_settings WHERE accountId = ?').get(accountId) as { doc: string } | undefined;
  const doc = row ? (JSON.parse(row.doc) as Partial<CostSettings>) : {};
  return { followCosts: doc.followCosts !== false };
}

/**
 * Keeps product costs where the recipes put them: every dossier linked to a
 * catalogue product, with a recipe whose materials all have a price, gets
 * its print cost at today's batch prices written onto the product (or its
 * variant) when that differs - as the server, through the op-log, so every
 * device has it. Returns how many products changed.
 */
export function followProductCosts(svc: Pick<ModuleServices, 'db' | 'writeOps'>, accountId: string): number {
  if (!costSettings(svc.db, accountId).followCosts) return 0;
  const dossiers = dossiersOf(svc.db, accountId).filter((d) => d.pid && d.recipe?.some((r) => r.materialId && Number(r.qty) > 0));
  if (!dossiers.length) return 0;
  const materials = materialsOf(svc.db, accountId).map(costed);
  const byId = new Map(materials.map((m) => [m.id, m]));
  const used = new Map(
    (svc.db.prepare('SELECT materialId, SUM(qty) AS used FROM sourcing_material_use WHERE accountId = ? GROUP BY materialId').all(accountId) as { materialId: string; used: number }[]).map((r) => [r.materialId, r.used]),
  );
  const ops = (svc.db.prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN ('product.upsert', 'product.delete') ORDER BY seq").all(accountId) as { opId: string; type: string; payload: string }[]).map(
    (o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) as unknown }),
  );
  const products = new Map(reduceProducts(ops).filter((p) => !p.deletedAt).map((p) => [p.id, p]));
  const changed = new Map<string, Product>();
  for (const d of dossiers) {
    const recipe = (d.recipe ?? []).filter((r) => r.materialId && Number(r.qty) > 0);
    // A material with nothing bought has no price yet: leave the product's cost alone rather than write a part.
    if (!recipe.every((r) => (byId.get(r.materialId)?.purchases.length ?? 0) > 0)) continue;
    const product = changed.get(d.pid!) ?? products.get(d.pid!);
    if (!product) continue;
    const cost = recipeCost(recipe, materials, (id) => used.get(id) ?? 0).total;
    if (d.vid) {
      const variant = product.variants.find((v) => v.id === d.vid);
      if (!variant || (typeof variant.cost === 'number' && Math.abs(variant.cost - cost) < 0.005)) continue;
      changed.set(product.id, { ...product, variants: product.variants.map((v) => (v.id === d.vid ? { ...v, cost } : v)), updatedAt: Date.now() });
    } else {
      if (typeof product.cost === 'number' && Math.abs(product.cost - cost) < 0.005) continue;
      changed.set(product.id, { ...product, cost, updatedAt: Date.now() });
    }
  }
  if (changed.size) svc.writeOps(accountId, [...changed.values()].map((p) => ({ type: 'product.upsert' as const, payload: p })));
  return changed.size;
}

/**
 * Logs a use. A client-chosen id makes a retried send from the printing app
 * count once. Tells the account when the material drops to its low mark, and
 * when the use finishes a batch, brings the products' costs up to the next.
 */
function logUse(
  svc: Pick<ModuleServices, 'db' | 'notify' | 'writeOps'>,
  accountId: string,
  m: MaterialDoc,
  use: { id?: string; qty: number; source: UseSource; note?: string; keyId?: string },
): { duplicate: boolean; onHand: number } {
  const before = onHandOf(svc.db, accountId, m);
  const priceBefore = currentUnitCost(costed(m), usedOf(svc.db, accountId, m.id));
  const res = svc.db
    .prepare('INSERT OR IGNORE INTO sourcing_material_use (accountId, id, materialId, qty, at, source, note, keyId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(accountId, use.id ?? crypto.randomUUID(), m.id, use.qty, Date.now(), use.source, (use.note ?? '').slice(0, 200), use.keyId ?? null);
  const onHand = onHandOf(svc.db, accountId, m);
  if (res.changes && currentUnitCost(costed(m), usedOf(svc.db, accountId, m.id)) !== priceBefore) followProductCosts(svc, accountId);
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
    followProductCosts(ctx, who.accountId);
    return { ok: true };
  });

  app.get('/cost-settings', async (req) => costSettings(ctx.db, ctx.identity(req).accountId));
  app.put('/cost-settings', async (req, reply) => {
    const who = ctx.identity(req);
    const body = z.object({ followCosts: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    ctx.db
      .prepare('INSERT INTO sourcing_settings (accountId, doc) VALUES (?, ?) ON CONFLICT(accountId) DO UPDATE SET doc = excluded.doc')
      .run(who.accountId, JSON.stringify(body.data));
    const updated = body.data.followCosts ? followProductCosts(ctx, who.accountId) : 0;
    return { ...costSettings(ctx.db, who.accountId), updated };
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

const JobId = z.string().trim().min(8).max(80).optional();
/** One material used: so many sheets, ml, sleeves. */
const MaterialBody = z.object({
  /** The material's id, or its name (any case). */
  material: z.string().trim().min(1).max(120),
  qty: z.number().positive().max(100_000),
  note: z.string().trim().max(200).optional(),
  /** The print job's own id: sending it again counts once. */
  id: JobId,
});
/** Copies of a product printed: every material of its dossier's recipe, times the copies. */
const RecipeBody = z.object({
  /** The dossier's id, or its title (any case) - "Harbour at dusk A3". */
  print: z.string().trim().min(1).max(160),
  copies: z.number().int().positive().max(10_000),
  note: z.string().trim().max(200).optional(),
  id: JobId,
});

/**
 * The printing app's side, at /p/sourcing/…: a printer key in the
 * Authorization header (`Bearer zpk_…`), and only these two calls. A use
 * is one material and its quantity, or copies of a print, which takes every
 * material of that dossier's recipe at once (paper and ink).
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
  const view = (accountId: string, m: MaterialDoc) => ({
    id: m.id,
    name: m.name,
    type: m.type ?? 'other',
    unit: m.unit ?? 'unit',
    onHand: onHandOf(ctx.db, accountId, m),
    onOrder: onOrder(m),
    ...(typeof m.lowAt === 'number' ? { lowAt: m.lowAt } : {}),
  });

  app.get('/materials', limit, async (req, reply) => {
    const key = keyOf(req);
    if (!key) return reply.code(401).send(refused);
    return { materials: materialsOf(ctx.db, key.accountId).map((m) => view(key.accountId, m)) };
  });

  app.post('/usage', limit, async (req, reply) => {
    const key = keyOf(req);
    if (!key) return reply.code(401).send(refused);
    const all = materialsOf(ctx.db, key.accountId);
    const job = RecipeBody.safeParse(req.body);
    if (job.success) {
      const wantedTitle = job.data.print.toLowerCase();
      const dossiers = dossiersOf(ctx.db, key.accountId);
      const d = dossiers.find((x) => x.id === job.data.print) ?? dossiers.find((x) => x.title.trim().toLowerCase() === wantedTitle);
      if (!d) return reply.code(404).send({ error: 'unknown_print', message: `No dossier "${job.data.print}". Make one under Sourcing → Dossiers with a recipe, or send its id.` });
      const lines = (d.recipe ?? []).filter((r) => r.materialId && Number(r.qty) > 0);
      if (!lines.length) return reply.code(409).send({ error: 'no_recipe', message: `"${d.title}" has no recipe yet - give its dossier the materials one print uses.` });
      const note = [`${job.data.copies} × ${d.title}`, job.data.note].filter(Boolean).join(' · ');
      const out = [];
      let duplicate = true;
      for (const line of lines) {
        const m = all.find((x) => x.id === line.materialId);
        if (!m) continue;
        const res = logUse(ctx, key.accountId, m, { id: job.data.id && `print-${job.data.id}-${m.id}`, qty: Number(line.qty) * job.data.copies, source: 'printer', note, keyId: key.id });
        duplicate &&= res.duplicate;
        out.push({ ...view(key.accountId, m), onHand: res.onHand });
      }
      return reply.code(duplicate ? 200 : 201).send({ materials: out, duplicate });
    }
    const body = MaterialBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Send the material (id or name) and a quantity above zero, or a print (dossier id or title) and its copies.' });
    const wanted = body.data.material.toLowerCase();
    const m = all.find((x) => x.id === body.data.material) ?? all.find((x) => x.name.trim().toLowerCase() === wanted);
    if (!m) return reply.code(404).send({ error: 'unknown_material', message: `No material "${body.data.material}". Add it under Sourcing → Materials, or send its id.` });
    const { duplicate, onHand } = logUse(ctx, key.accountId, m, { id: body.data.id && `print-${body.data.id}`, qty: body.data.qty, source: 'printer', note: body.data.note, keyId: key.id });
    return reply.code(duplicate ? 200 : 201).send({ material: { ...view(key.accountId, m), onHand }, duplicate });
  });
}
