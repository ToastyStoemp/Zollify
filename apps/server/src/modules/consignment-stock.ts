import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EventStock, InventoryItem, Product, WireOp } from '@zollify/shared';
import { isEnabled, type ModuleContext, type ModuleServices } from '@zollify/server-core';
import { MODULE_ID, accountName, consignorRow, parseDoc, replay, type ConsignorRow } from './consignment';
import type { Side } from './consignment';
import { accountEmail } from './consignment-planner';

/**
 * Stock an artist puts in a store - in person, or by post.
 *
 * Restocking: an artist who walks in and fills their shelf records what they
 * added (or recounts) from their own account. Packages: a remote artist
 * sends a box and lists what is in it; the store confirms what actually
 * arrived, and that is what is added. Either way the server writes the new
 * count into the store's inventory, the same counted figure the till
 * already sells against - so it works with the store's devices offline,
 * and the change reaches them with their next sync.
 *
 * Counts follow the till's own rule: a count already reflects what sold
 * before it, so adding N means "what is left now, plus N".
 */

export function migrateStock(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consignment_shipments (
      accountId   TEXT NOT NULL,
      id          TEXT NOT NULL,
      consignorId TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('sent','received','cancelled')),
      doc         TEXT NOT NULL,
      createdAt   INTEGER NOT NULL,
      updatedAt   INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_consignment_shipments ON consignment_shipments(accountId, consignorId);
    CREATE TABLE IF NOT EXISTS consignment_stock_log (
      accountId   TEXT NOT NULL,
      id          TEXT NOT NULL,
      consignorId TEXT NOT NULL,
      doc         TEXT NOT NULL,
      createdAt   INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
  `);
}

// ── Model ───────────────────────────────────────────────────────────────────

export interface StockLine {
  productId: string;
  /** '' for a product without variants. */
  variantId: string;
  qty: number;
}
export interface Shipment {
  id: string;
  consignorId: string;
  storeId: string;
  status: 'sent' | 'received' | 'cancelled';
  lines: (StockLine & { title: string })[];
  /** What the store counted on arrival; set once received. */
  received: StockLine[] | null;
  note: string;
  carrier: string;
  tracking: string;
  sentAt: number;
  receivedAt: number | null;
}
/** One change to an artist's stock in a store, for both sides' records. */
export interface StockChange {
  id: string;
  consignorId: string;
  kind: 'restock' | 'recount' | 'package';
  storeId: string | null;
  lines: StockLine[];
  at: number;
}

const key = (productId: string, variantId: string): string => `${productId}:${variantId}`;

/** What is on the shelf now, by the till's rule: last count less what sold since. */
function stockState(db: Database.Database, storeAccountId: string) {
  const { transactions, products } = replay(db, storeAccountId);
  const ops = db
    .prepare("SELECT type, payload FROM ops WHERE accountId = ? AND type IN ('inventory.set', 'stock.set') ORDER BY seq")
    .all(storeAccountId) as { type: string; payload: string }[];
  const counts = new Map<string, InventoryItem>();
  const claims = new Map<string, EventStock>();
  for (const op of ops) {
    if (op.type === 'inventory.set') {
      const row = JSON.parse(op.payload) as InventoryItem;
      const k = key(row.productId, row.variantId ?? '');
      if (!counts.has(k) || row.updatedAt >= counts.get(k)!.updatedAt) counts.set(k, row);
    } else {
      const row = JSON.parse(op.payload) as EventStock;
      const k = `${row.eventId}|${key(row.productId, row.variantId ?? '')}`;
      if (!claims.has(k) || row.updatedAt >= claims.get(k)!.updatedAt) claims.set(k, row);
    }
  }
  const remaining = (productId: string, variantId: string): number => {
    const count = counts.get(key(productId, variantId));
    const since = count?.updatedAt ?? 0;
    let sold = 0;
    for (const tx of transactions) {
      if (tx.revertedAt || tx.revertedBy || tx.timestamp <= since) continue;
      for (const i of tx.items) if (i.pid === productId && (i.vid ?? '') === variantId) sold += i.qty;
    }
    return Math.max(0, (count?.onHand ?? 0) - sold);
  };
  return { products: new Map(products.filter((p) => !p.deletedAt).map((p) => [p.id, p])), remaining, claims };
}

/**
 * Writes added (or recounted) stock into the store. Only the consignor's own
 * items take part - anything else in a request is ignored. When the store
 * reserves the item for that store, the reservation grows with it.
 */
function applyStock(
  svc: ModuleServices,
  storeAccountId: string,
  consignorId: string,
  lines: StockLine[],
  mode: 'add' | 'set',
  storeId: string | null,
): StockLine[] {
  const { products, remaining, claims } = stockState(svc.db, storeAccountId);
  const now = Date.now();
  const ops: { type: WireOp['type']; payload: unknown }[] = [];
  const applied: StockLine[] = [];
  for (const line of lines) {
    const p: Product | undefined = products.get(line.productId);
    if (!p || p.consignorId !== consignorId) continue;
    if (line.variantId ? !p.variants.some((v) => v.id === line.variantId) : p.variants.length > 0) continue;
    const left = remaining(line.productId, line.variantId);
    const onHand = mode === 'add' ? left + line.qty : line.qty;
    ops.push({ type: 'inventory.set', payload: { productId: line.productId, variantId: line.variantId, onHand, updatedAt: now } satisfies InventoryItem });
    const claim = storeId ? claims.get(`${storeId}|${key(line.productId, line.variantId)}`) : undefined;
    if (claim && mode === 'add') {
      ops.push({ type: 'stock.set', payload: { ...claim, broughtQty: claim.broughtQty + line.qty, updatedAt: now } satisfies EventStock });
    }
    applied.push(line);
  }
  svc.writeOps(storeAccountId, ops);
  return applied;
}

function logChange(db: Database.Database, storeAccountId: string, change: StockChange): void {
  db.prepare('INSERT INTO consignment_stock_log (accountId, id, consignorId, doc, createdAt) VALUES (?, ?, ?, ?, ?)').run(
    storeAccountId,
    change.id,
    change.consignorId,
    JSON.stringify(change),
    change.at,
  );
}

const shipmentsOf = (db: Database.Database, storeAccountId: string, consignorId?: string): Shipment[] =>
  (
    (consignorId
      ? db.prepare('SELECT doc FROM consignment_shipments WHERE accountId = ? AND consignorId = ? ORDER BY createdAt DESC').all(storeAccountId, consignorId)
      : db.prepare('SELECT doc FROM consignment_shipments WHERE accountId = ? ORDER BY createdAt DESC').all(storeAccountId)) as { doc: string }[]
  ).map((r) => JSON.parse(r.doc) as Shipment);

function saveShipment(db: Database.Database, storeAccountId: string, s: Shipment): void {
  db.prepare(
    `INSERT INTO consignment_shipments (accountId, id, consignorId, status, doc, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(accountId, id) DO UPDATE SET status = excluded.status, doc = excluded.doc, updatedAt = excluded.updatedAt`,
  ).run(storeAccountId, s.id, s.consignorId, s.status, JSON.stringify(s), s.sentAt, Date.now());
}

/** What a linked artist sees of their stock movements at one store. */
export function stockForArtist(db: Database.Database, storeAccountId: string, consignorId: string) {
  return {
    shipments: shipmentsOf(db, storeAccountId, consignorId).slice(0, 20),
    stockChanges: (
      db.prepare('SELECT doc FROM consignment_stock_log WHERE accountId = ? AND consignorId = ? ORDER BY createdAt DESC LIMIT 20').all(storeAccountId, consignorId) as { doc: string }[]
    ).map((r) => JSON.parse(r.doc) as StockChange),
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

const Line = z.object({ productId: z.string().min(1).max(80), variantId: z.string().max(80).default(''), qty: z.number().int().min(0).max(100_000) });
const RestockBody = z.object({ lines: z.array(Line).min(1).max(500), mode: z.enum(['add', 'set']).default('add'), storeId: z.string().max(80).nullable().default(null) });
const ShipBody = z.object({
  storeId: z.string().min(1).max(80),
  lines: z.array(Line.extend({ qty: z.number().int().min(1).max(100_000) })).min(1).max(500),
  note: z.string().max(1000).default(''),
  carrier: z.string().max(80).default(''),
  tracking: z.string().max(120).default(''),
});
const ReceiveBody = z.object({ lines: z.array(Line).max(500).optional() });

const units = (lines: StockLine[]): number => lines.reduce((n, l) => n + l.qty, 0);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function registerStock(app: FastifyInstance, ctx: ModuleContext, side: Side): void {
  const { db } = ctx;

  /** The link a linked artist acts through, or null - never someone else's. */
  const linkOf = (req: Parameters<ModuleContext['identity']>[0], storeAccountId: string, consignorId: string): ConsignorRow | null => {
    const row = consignorRow(db, storeAccountId, consignorId);
    if (!row || row.linkedAccountId !== ctx.identity(req).accountId || !isEnabled(db, storeAccountId, MODULE_ID)) return null;
    return row;
  };
  const storeName = (storeAccountId: string, storeId: string | null): string => {
    const e = storeId ? replay(db, storeAccountId).events.find((x) => x.id === storeId) : undefined;
    return e?.name ?? accountName(db, storeAccountId) ?? 'the store';
  };

  // ── The artist's side ───────────────────────────────────────────────────

  if (side === 'artist') {
    /** The artist filled their shelf in person: add what they brought, or recount. */
    app.post<{ Params: { storeAccountId: string; consignorId: string } }>('/links/:storeAccountId/:consignorId/stock', async (req, reply) => {
      const row = linkOf(req, req.params.storeAccountId, req.params.consignorId);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const body = RestockBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'List the items and how many.' });
      const lines = body.data.lines.filter((l) => body.data.mode === 'set' || l.qty > 0);
      const applied = applyStock(ctx, row.accountId, row.id, lines, body.data.mode, body.data.storeId);
      if (!applied.length) return reply.code(400).send({ error: 'invalid_request', message: 'None of those are your items in this store.' });
      const change: StockChange = { id: randomUUID(), consignorId: row.id, kind: body.data.mode === 'add' ? 'restock' : 'recount', storeId: body.data.storeId, lines: applied, at: Date.now() };
      logChange(db, row.accountId, change);
      const name = parseDoc(row.doc).name;
      ctx.notify(row.accountId, { kind: 'stock',
        title: body.data.mode === 'add' ? `${name} restocked ${plural(units(applied), 'item')}` : `${name} recounted ${plural(applied.length, 'item')}`,
        body: `At ${storeName(row.accountId, body.data.storeId)}.`,
        link: '/m/consignment/items',
        minRole: 'admin',
      });
      return { change };
    });

    /** A remote artist sends a package; nothing changes until the store confirms it. */
    app.post<{ Params: { storeAccountId: string; consignorId: string } }>('/links/:storeAccountId/:consignorId/shipments', async (req, reply) => {
      const row = linkOf(req, req.params.storeAccountId, req.params.consignorId);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const body = ShipBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'A package needs a store and what is in it.' });
      const { products } = stockState(db, row.accountId);
      const lines = body.data.lines
        .map((l) => ({ ...l, product: products.get(l.productId) }))
        .filter((l) => l.product?.consignorId === row.id)
        .map(({ product, ...l }) => ({ ...l, title: l.variantId ? `${product!.title} · ${product!.variants.find((v) => v.id === l.variantId)?.name ?? ''}` : product!.title }));
      if (!lines.length) return reply.code(400).send({ error: 'invalid_request', message: 'None of those are your items in this store.' });
      const shipment: Shipment = { id: randomUUID(), consignorId: row.id, storeId: body.data.storeId, status: 'sent', lines, received: null, note: body.data.note, carrier: body.data.carrier, tracking: body.data.tracking, sentAt: Date.now(), receivedAt: null };
      saveShipment(db, row.accountId, shipment);
      const name = parseDoc(row.doc).name;
      const title = `${name} sent a package: ${plural(units(lines), 'item')}`;
      ctx.notify(row.accountId, { kind: 'stock', title, body: `For ${storeName(row.accountId, shipment.storeId)}${shipment.tracking ? ` · ${shipment.carrier} ${shipment.tracking}`.trim() : ''}. Confirm it when it arrives.`, link: '/m/consignment/items', minRole: 'admin' });
      const to = accountEmail(db, row.accountId);
      if (to && ctx.mail.enabled) {
        const replyTo = accountEmail(db, ctx.identity(req).accountId) ?? undefined;
        await ctx.mail.send({
          to,
          subject: title,
          text: [`${title}, for ${storeName(row.accountId, shipment.storeId)}.`, '', ...lines.map((l) => `  ${l.qty} × ${l.title}`), ...(shipment.tracking ? ['', `Tracking: ${shipment.carrier} ${shipment.tracking}`.trim()] : []), ...(shipment.note ? ['', shipment.note] : []), '', 'Confirm it in Zollify under Consignment → Items when it arrives - the counts go straight onto the shelf.'].join('\n'),
          ...(replyTo ? { replyTo } : {}),
        });
      }
      return reply.code(201).send({ shipment });
    });

    app.delete<{ Params: { storeAccountId: string; consignorId: string; id: string } }>('/links/:storeAccountId/:consignorId/shipments/:id', async (req, reply) => {
      const row = linkOf(req, req.params.storeAccountId, req.params.consignorId);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const s = shipmentsOf(db, row.accountId, row.id).find((x) => x.id === req.params.id);
      if (!s) return reply.code(404).send({ error: 'not_found' });
      if (s.status !== 'sent') return reply.code(409).send({ error: 'received', message: 'The store already confirmed this package.' });
      saveShipment(db, row.accountId, { ...s, status: 'cancelled' });
      return { ok: true };
    });
  }

  // ── The store's side ────────────────────────────────────────────────────

  if (side === 'store') {
    app.get('/shipments', async (req) => {
      const who = ctx.identity(req);
      return { shipments: shipmentsOf(db, who.accountId).slice(0, 100) };
    });

    /**
     * The package arrived. The store says what was actually in it (by default,
     * what the artist listed) and that is added to the shelf; the artist hears
     * what was counted, especially where it differs.
     */
    app.post<{ Params: { id: string } }>('/shipments/:id/receive', async (req, reply) => {
      const who = ctx.identity(req);
      const s = shipmentsOf(db, who.accountId).find((x) => x.id === req.params.id);
      if (!s) return reply.code(404).send({ error: 'not_found' });
      if (s.status !== 'sent') return reply.code(409).send({ error: 'not_open', message: s.status === 'received' ? 'Already received.' : 'The artist cancelled this package.' });
      const body = ReceiveBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const counted = body.data.lines ?? s.lines.map(({ productId, variantId, qty }) => ({ productId, variantId, qty }));
      const received = applyStock(ctx, who.accountId, s.consignorId, counted.filter((l) => l.qty > 0), 'add', s.storeId);
      const done: Shipment = { ...s, status: 'received', received, receivedAt: Date.now() };
      saveShipment(db, who.accountId, done);
      logChange(db, who.accountId, { id: randomUUID(), consignorId: s.consignorId, kind: 'package', storeId: s.storeId, lines: received, at: Date.now() });

      // Tell the artist, naming any difference from what they listed.
      const row = consignorRow(db, who.accountId, s.consignorId);
      const artist = row?.linkedAccountId && accountName(db, row.linkedAccountId) !== null ? row.linkedAccountId : null;
      const got = new Map(received.map((l) => [key(l.productId, l.variantId), l.qty]));
      const diffs = s.lines.filter((l) => (got.get(key(l.productId, l.variantId)) ?? 0) !== l.qty).map((l) => `${l.title}: sent ${l.qty}, counted ${got.get(key(l.productId, l.variantId)) ?? 0}`);
      const shop = accountName(db, who.accountId) ?? 'The store';
      const title = `${shop} received your package: ${plural(units(received), 'item')}`;
      if (artist) ctx.notify(artist, { kind: 'stock', title, body: diffs.length ? diffs.join(' · ') : 'Everything as you listed it - now on the shelf.', link: '/m/consignment-artist', minRole: 'admin' });
      const to = (row && parseDoc(row.doc).email) || (artist ? accountEmail(db, artist) : null);
      if (to && ctx.mail.enabled) {
        const replyTo = accountEmail(db, who.accountId) ?? undefined;
        await ctx.mail.send({ to, subject: title, text: [`${title}.`, '', ...(diffs.length ? ['What was counted differs from what you listed:', ...diffs.map((d) => `  ${d}`)] : ['Everything as you listed it - now on the shelf.'])].join('\n'), ...(replyTo ? { replyTo } : {}) });
      }
      return { shipment: done };
    });
  }
}
