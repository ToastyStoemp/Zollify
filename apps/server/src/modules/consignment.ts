import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  ConsignorInputSchema,
  PayoutInputSchema,
  cardFeesOf,
  feesDue,
  consignmentLines,
  consignmentStatements,
  isStore,
  rentDue,
  type ArtistConsignment,
  type ConsignedItem,
  type ConsignmentPayout,
  type ConsignmentVenue,
  type Consignor,
  type ConsignorInput,
  type InventoryItem,
  type SalesEvent,
  type Transaction,
} from '@zollify/shared';
import {
  isEnabled,
  parseProfile,
  reduceEvents,
  reduceMerges,
  reduceProducts,
  reduceTransactions,
  type ModuleContext,
  type ServerModule,
} from '@zollify/server-core';
import { migratePlanner, plannerForArtist, registerPlanner, rentalsOf } from './consignment-planner';
import { migrateProgramme, programmeForArtist, registerProgramme, registerProgrammePublic } from './consignment-programme';
import { followArtistChanges, migrateSharing, registerSharing, syncShared } from './consignment-sharing';
import { booksForArtist, booksSettings, feesOf, migrateBooks, registerBooks } from './consignment-books';
import { migrateStock, registerStock, stockForArtist } from './consignment-stock';
import { announceConsignedSales, consignmentSummary, followStoreDiscounts, registerArtistDiscounts } from './consignment-discounts';

/**
 * Consignment - the server half.
 *
 * A store owner keeps a list of artists whose work they sell, each in one of
 * their stores or several. Products carry the artist's id and every sale line
 * snapshots it, so statements are replayed from the op-log like every other
 * read: nothing is pushed for a statement to be current.
 *
 * An artist can link their own Zollify account - the one they run their
 * convention booth from - by entering a code the owner hands them. Linked,
 * they see their items, sales and payouts at that owner's stores, and the
 * owner can import items from their catalogue instead of retyping them. The
 * link is the only path from one account's data to another's, and what
 * crosses it is picked field by field below - never a spread of a record.
 */

export const MODULE_ID = 'consignment';

/** All a staff account may call: the till's view of workshops and artists' items. */
const TILL_ROUTES = new Set(['GET /till/workshops', 'POST /workshops/:id/signups', 'POST /scan']);
const LINK_TTL = 14 * 24 * 3600 * 1000;

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consignors (
      accountId       TEXT NOT NULL,
      id              TEXT NOT NULL,
      doc             TEXT NOT NULL,
      linkedAccountId TEXT,
      linkCodeHash    TEXT UNIQUE,
      linkExpiresAt   INTEGER,
      createdAt       INTEGER NOT NULL,
      updatedAt       INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_consignors_linked ON consignors(linkedAccountId);
    CREATE TABLE IF NOT EXISTS consignment_payouts (
      accountId   TEXT NOT NULL,
      id          TEXT NOT NULL,
      consignorId TEXT NOT NULL,
      doc         TEXT NOT NULL,
      createdAt   INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_consignment_payouts_consignor ON consignment_payouts(accountId, consignorId);
  `);
}

// ── Data access ─────────────────────────────────────────────────────────────

export interface ConsignorRow {
  accountId: string;
  id: string;
  doc: string;
  linkedAccountId: string | null;
  linkCodeHash: string | null;
  linkExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Rent is charged by the server's calendar day. */
const today = (): string => new Date().toISOString().slice(0, 10);
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** Codes are typed by hand, so dashes, spaces and case are forgiven. */
const normaliseCode = (code: string): string => code.replace(/[^0-9a-z]/gi, '').toUpperCase();

export function accountName(db: Database.Database, accountId: string | null): string | null {
  if (!accountId) return null;
  const row = db.prepare('SELECT name FROM accounts WHERE id = ?').get(accountId) as { name: string } | undefined;
  return row?.name ?? null;
}

export function parseDoc(raw: string): ConsignorInput {
  const parsed = ConsignorInputSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : ConsignorInputSchema.parse({ name: 'Unnamed artist', commissionPct: 0 });
}

export function toConsignor(db: Database.Database, row: ConsignorRow): Consignor {
  const doc = parseDoc(row.doc);
  // An artist account that was deleted reads as unlinked rather than as a name-less link.
  const linkedAccountName = accountName(db, row.linkedAccountId);
  return {
    id: row.id,
    ...doc,
    linked: linkedAccountName !== null,
    linkedAccountName,
    linkPending: !!row.linkCodeHash && (row.linkExpiresAt ?? 0) > Date.now(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function consignorRows(db: Database.Database, accountId: string): ConsignorRow[] {
  return db.prepare('SELECT * FROM consignors WHERE accountId = ? ORDER BY createdAt').all(accountId) as ConsignorRow[];
}

export function consignorRow(db: Database.Database, accountId: string, id: string): ConsignorRow | undefined {
  return db.prepare('SELECT * FROM consignors WHERE accountId = ? AND id = ?').get(accountId, id) as ConsignorRow | undefined;
}

export function payoutsFor(db: Database.Database, accountId: string, consignorId?: string): ConsignmentPayout[] {
  const rows = (
    consignorId
      ? db.prepare('SELECT id, doc, createdAt FROM consignment_payouts WHERE accountId = ? AND consignorId = ?').all(accountId, consignorId)
      : db.prepare('SELECT id, doc, createdAt FROM consignment_payouts WHERE accountId = ?').all(accountId)
  ) as { id: string; doc: string; createdAt: number }[];
  return rows
    .map((r) => ({ ...PayoutInputSchema.parse(JSON.parse(r.doc)), id: r.id, createdAt: r.createdAt }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

/** One account's op-log, replayed into what a statement needs. */
export function replay(db: Database.Database, accountId: string) {
  const types = ['tx.create', 'tx.revert', 'product.merge', 'product.upsert', 'product.delete', 'event.upsert', 'event.close', 'inventory.set'];
  const ops = (
    db
      .prepare(`SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY seq`)
      .all(accountId, ...types) as { opId: string; type: string; payload: string }[]
  ).map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) as unknown }));

  const inventory = new Map<string, InventoryItem>();
  for (const op of ops) {
    if (op.type !== 'inventory.set') continue;
    const row = op.payload as InventoryItem;
    const key = `${row.productId}:${row.variantId ?? ''}`;
    const existing = inventory.get(key);
    if (!existing || row.updatedAt >= existing.updatedAt) inventory.set(key, row);
  }
  return {
    events: reduceEvents(ops),
    products: reduceProducts(ops).filter((p) => !p.deletedAt),
    transactions: reduceTransactions(ops, reduceMerges(ops)) as Transaction[],
    inventory,
  };
}

/** The fields of a venue another account may see - its name and town, nothing about its till. */
function venueOf(event: SalesEvent | undefined, id: string): ConsignmentVenue {
  if (!event || event.deletedAt) return { id, name: id ? 'Removed event' : 'No event', kind: 'event' };
  return {
    id,
    name: event.name,
    kind: isStore(event) ? 'store' : 'event',
    ...(event.venue?.city ? { city: event.venue.city } : {}),
    ...(event.venue?.country ? { country: event.venue.country } : {}),
  };
}

// ── Request bodies ──────────────────────────────────────────────────────────

const IdParam = z.string().min(1).max(80);
const AcceptBody = z.object({ code: z.string().min(4).max(40) });

/** Brute-forcing link codes is what this blunts; nobody types more than a few a minute. */
const CODE_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export const consignmentServerModule: ServerModule = {
  id: MODULE_ID,
  // Staff load it for the till only - see TILL_ROUTES; everything else is admin.
  minRole: 'member',
  migrate: (db) => {
    migrate(db);
    migratePlanner(db);
    migrateProgramme(db);
    migrateSharing(db);
    migrateStock(db);
    migrateBooks(db);
  },

  /** An artist's devices changed products: stores sharing them follow. */
  onOps: (svc, accountId, ops) => {
    followArtistChanges(svc, accountId, ops);
    followStoreDiscounts(svc, accountId, ops);
    announceConsignedSales(svc, accountId, ops);
  },

  /** Daily and weekly webhook summaries: artists' work in a store, and an artist's sales in stores. */
  webhookReport: (svc, accountId, period) => consignmentSummary(svc, accountId, period),

  /** The store's public events-and-workshops page, and cancelling a place on it. */
  publicRoutes: (ctx) => async (app) => registerProgrammePublic(app, ctx),

  routes: (ctx: ModuleContext) => async (app) => {
    const { db } = ctx;
    // Commissions, payouts and artists' details are not staff business. Staff
    // get exactly what the till needs: workshop places to charge, booking a
    // walk-in, and resolving a scanned artist's label.
    app.addHook('preHandler', async (req, reply) => {
      if (ctx.identity(req).role !== 'member') return undefined;
      const route = `${req.method} ${req.routeOptions.url?.replace(/^\/api\/m\/consignment/, '') ?? ''}`;
      if (TILL_ROUTES.has(route)) return undefined;
      return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can do that.' });
    });
    registerPlanner(app, ctx);
    registerProgramme(app, ctx);
    registerSharing(app, ctx);
    registerStock(app, ctx);
    registerBooks(app, ctx);
    registerArtistDiscounts(app, ctx);

    // ── The store owner's side ────────────────────────────────────────────

    app.get('/consignors', async (req) => {
      const who = ctx.identity(req);
      return { consignors: consignorRows(db, who.accountId).map((r) => toConsignor(db, r)) };
    });

    app.put<{ Params: { id: string } }>('/consignors/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const id = IdParam.safeParse(req.params.id);
      const body = ConsignorInputSchema.safeParse(req.body);
      if (!id.success || !body.success) return reply.code(400).send({ error: 'invalid_request', message: 'That artist is not valid.' });
      const before = consignorRow(db, who.accountId, id.data);
      const renamed = !!before && parseDoc(before.doc).name !== body.data.name;
      const now = Date.now();
      db.prepare(
        `INSERT INTO consignors (accountId, id, doc, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(accountId, id) DO UPDATE SET doc = excluded.doc, updatedAt = excluded.updatedAt`,
      ).run(who.accountId, id.data, JSON.stringify(body.data), now, now);
      const saved = consignorRow(db, who.accountId, id.data)!;
      // Shared items carry the artist's name; a rename follows them.
      if (renamed) syncShared(ctx, who.accountId, saved);
      return { consignor: toConsignor(db, saved) };
    });

    /**
     * Removing an artist who has sold or been paid would erase the trail a
     * payout is checked against, so that is refused - archive them instead.
     */
    app.delete<{ Params: { id: string } }>('/consignors/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const row = consignorRow(db, who.accountId, req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const { transactions } = replay(db, who.accountId);
      const sold = transactions.some((tx) => tx.items.some((i) => i.consignorId === row.id));
      if (sold || payoutsFor(db, who.accountId, row.id).length) {
        return reply.code(409).send({ error: 'has_history', message: 'This artist has sales or payouts on record - archive them instead.' });
      }
      db.prepare('DELETE FROM consignors WHERE accountId = ? AND id = ?').run(who.accountId, row.id);
      return { ok: true };
    });

    /**
     * A fresh code for the artist to link their own account with. Only its
     * hash is kept, so asking again simply replaces it; it works once.
     */
    app.post<{ Params: { id: string } }>('/consignors/:id/link-code', async (req, reply) => {
      const who = ctx.identity(req);
      const row = consignorRow(db, who.accountId, req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const raw = randomBytes(5).toString('hex').toUpperCase();
      const expiresAt = Date.now() + LINK_TTL;
      db.prepare('UPDATE consignors SET linkCodeHash = ?, linkExpiresAt = ? WHERE accountId = ? AND id = ?').run(sha256(raw), expiresAt, who.accountId, row.id);
      return { code: `${raw.slice(0, 5)}-${raw.slice(5)}`, expiresAt };
    });

    app.delete<{ Params: { id: string } }>('/consignors/:id/link', async (req, reply) => {
      const who = ctx.identity(req);
      const info = db
        .prepare('UPDATE consignors SET linkedAccountId = NULL, linkCodeHash = NULL, linkExpiresAt = NULL WHERE accountId = ? AND id = ?')
        .run(who.accountId, req.params.id);
      if (!info.changes) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    });

    /**
     * The linked artist's catalogue, to import from. Selling fields only:
     * the artist's costs and stock counts stay theirs.
     */
    app.get<{ Params: { id: string } }>('/consignors/:id/catalog', async (req, reply) => {
      const who = ctx.identity(req);
      const row = consignorRow(db, who.accountId, req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      if (!row.linkedAccountId || accountName(db, row.linkedAccountId) === null) {
        return reply.code(409).send({ error: 'not_linked', message: 'This artist has not linked their Zollify account yet.' });
      }
      const { products } = replay(db, row.linkedAccountId);
      return {
        products: products
          .filter((p) => p.forSale)
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((p) => ({
            id: p.id,
            title: p.title,
            ...(p.sku ? { sku: p.sku } : {}),
            ...(p.type ? { type: p.type } : {}),
            price: p.price,
            ...(p.priceNote ? { priceNote: p.priceNote } : {}),
            ...(p.weightG != null ? { weightG: p.weightG } : {}),
            ...(p.material ? { material: p.material } : {}),
            ...(p.year != null ? { year: p.year } : {}),
            ...(p.originCountry ? { originCountry: p.originCountry } : {}),
            ...(p.tariffNo ? { tariffNo: p.tariffNo } : {}),
            ...(p.taxClass ? { taxClass: p.taxClass } : {}),
            variants: (p.variants ?? [])
              .filter((v) => !v.unlisted)
              .map((v) => ({
                id: v.id,
                name: v.name,
                ...(v.sku ? { sku: v.sku } : {}),
                ...(v.price != null ? { price: v.price } : {}),
                ...(v.weightG != null ? { weightG: v.weightG } : {}),
                ...(v.material ? { material: v.material } : {}),
              })),
          })),
      };
    });

    /** Every artist's sales, per store, against what they were paid. */
    app.get('/statement', async (req) => {
      const who = ctx.identity(req);
      const consignors = consignorRows(db, who.accountId).map((r) => toConsignor(db, r));
      const { events, transactions } = replay(db, who.accountId);
      const lines = consignmentLines(transactions, consignors, cardFeesOf(booksSettings(db, who.accountId)));
      const payouts = payoutsFor(db, who.accountId);
      const fees = feesOf(db, who.accountId);
      const byId = new Map(events.map((e) => [e.id, e]));
      const venueIds = new Set([...events.filter((e) => !e.deletedAt).map((e) => e.id), ...lines.map((l) => l.storeId)]);
      return {
        consignors,
        venues: [...venueIds].map((id) => venueOf(byId.get(id), id)),
        lines,
        payouts,
        fees,
        statements: consignmentStatements(lines, payouts, consignors.map((c) => c.id), rentDue(rentalsOf(db, who.accountId), today()), feesDue(fees)),
      };
    });

    app.post('/payouts', async (req, reply) => {
      const who = ctx.identity(req);
      const body = PayoutInputSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'A payout needs an artist, an amount, a currency and a date.' });
      if (!consignorRow(db, who.accountId, body.data.consignorId)) return reply.code(404).send({ error: 'not_found', message: 'No such artist.' });
      const payout: ConsignmentPayout = { ...body.data, id: randomUUID(), createdAt: Date.now() };
      db.prepare('INSERT INTO consignment_payouts (accountId, id, consignorId, doc, createdAt) VALUES (?, ?, ?, ?, ?)').run(
        who.accountId,
        payout.id,
        payout.consignorId,
        JSON.stringify(body.data),
        payout.createdAt,
      );
      return reply.code(201).send({ payout });
    });

    app.delete<{ Params: { id: string } }>('/payouts/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const info = db.prepare('DELETE FROM consignment_payouts WHERE accountId = ? AND id = ?').run(who.accountId, req.params.id);
      if (!info.changes) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    });

    // ── The artist's side ─────────────────────────────────────────────────
    // The caller here is the artist's own account; every read is scoped by
    // `linkedAccountId = caller`, so a code is the only way in.

    app.post('/links', CODE_RATE_LIMIT, async (req, reply) => {
      const who = ctx.identity(req);
      const body = AcceptBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Enter the code the store gave you.' });
      const row = db
        .prepare('SELECT * FROM consignors WHERE linkCodeHash = ? AND linkExpiresAt > ?')
        .get(sha256(normaliseCode(body.data.code)), Date.now()) as ConsignorRow | undefined;
      if (!row) return reply.code(404).send({ error: 'invalid_code', message: 'That code is not valid or has expired - ask the store for a new one.' });
      if (row.accountId === who.accountId) {
        return reply.code(400).send({ error: 'own_store', message: 'That code is for one of your own stores - give it to the artist.' });
      }
      const other = db
        .prepare('SELECT id FROM consignors WHERE accountId = ? AND linkedAccountId = ? AND id != ?')
        .get(row.accountId, who.accountId, row.id);
      if (other) return reply.code(409).send({ error: 'already_linked', message: 'Your account is already linked to another artist at this store.' });
      db.prepare('UPDATE consignors SET linkedAccountId = ?, linkCodeHash = NULL, linkExpiresAt = NULL WHERE accountId = ? AND id = ?').run(
        who.accountId,
        row.accountId,
        row.id,
      );
      return { storeAccountName: accountName(db, row.accountId) ?? '', consignorName: parseDoc(row.doc).name };
    });

    app.get('/links', async (req) => {
      const who = ctx.identity(req);
      const rows = db.prepare('SELECT * FROM consignors WHERE linkedAccountId = ? ORDER BY createdAt').all(who.accountId) as ConsignorRow[];
      const out: ArtistConsignment[] = [];
      for (const row of rows) {
        const storeAccountName = accountName(db, row.accountId);
        if (storeAccountName === null) continue; // the store's account is gone
        const doc = parseDoc(row.doc);
        const profile = db.prepare('SELECT profile FROM accounts WHERE id = ?').get(row.accountId) as { profile: string | null };
        const base = {
          storeAccountId: row.accountId,
          storeAccountName,
          currency: parseProfile(profile.profile).defaultCurrency,
          consignorId: row.id,
          consignorName: doc.name,
          commissionPct: doc.commissionPct,
          storeCommission: doc.storeCommission,
        };
        // The owner switched consignment off: the link stays, the sharing stops.
        if (!isEnabled(db, row.accountId, MODULE_ID)) {
          out.push({ ...base, paused: true, venues: [], items: [], lines: [], payouts: [], rentals: [], setups: [], features: [], workshops: [], shipments: [], stockChanges: [], fees: [], statement: { consignorId: row.id, byStore: [], totals: [] } });
          continue;
        }
        const programme = programmeForArtist(db, row.accountId, row.id);
        const planner = plannerForArtist(db, row.accountId, row.id);
        // Every store the artist hears about must have a name on their side.
        const mentioned = [...programme.features.flatMap((f) => f.storeIds), ...programme.workshops.map((w) => w.storeId), ...planner.rentals.map((r) => r.storeId), ...planner.setups.map((s) => s.storeId)];
        out.push({ ...base, paused: false, ...artistView(db, row.accountId, { id: row.id, ...doc }, mentioned), ...planner, ...programme, ...stockForArtist(db, row.accountId, row.id), ...booksForArtist(db, row.accountId, row.id) });
      }
      return { links: out };
    });

    app.delete<{ Params: { storeAccountId: string; consignorId: string } }>('/links/:storeAccountId/:consignorId', async (req, reply) => {
      const who = ctx.identity(req);
      const info = db
        .prepare('UPDATE consignors SET linkedAccountId = NULL WHERE accountId = ? AND id = ? AND linkedAccountId = ?')
        .run(req.params.storeAccountId, req.params.consignorId, who.accountId);
      if (!info.changes) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    });
  },
};

/** What one store account shows the artist behind one of its consignors. */
function artistView(
  db: Database.Database,
  storeAccountId: string,
  consignor: Pick<Consignor, 'id' | 'commissionPct' | 'storeCommission' | 'storeIds'>,
  alsoVenues: string[] = [],
): Pick<ArtistConsignment, 'venues' | 'items' | 'lines' | 'payouts' | 'statement'> {
  const { events, products, transactions, inventory } = replay(db, storeAccountId);
  const lines = consignmentLines(transactions, [consignor], cardFeesOf(booksSettings(db, storeAccountId)));
  const payouts = payoutsFor(db, storeAccountId, consignor.id);
  const byId = new Map(events.map((e) => [e.id, e]));

  const assigned = consignor.storeIds.filter((id) => byId.get(id) && !byId.get(id)!.deletedAt);
  const venueIds = [...new Set([...assigned, ...lines.map((l) => l.storeId), ...alsoVenues.filter((id) => byId.has(id))])];

  const items: ConsignedItem[] = [];
  for (const p of products.filter((p) => p.consignorId === consignor.id)) {
    const rows = p.variants?.length
      ? p.variants.map((v) => ({ variantId: v.id, variantLabel: v.name, sku: v.sku ?? p.sku, price: v.price ?? p.price }))
      : [{ variantId: '', variantLabel: undefined, sku: p.sku, price: p.price }];
    for (const r of rows) {
      const own = lines.filter((l) => l.productId === p.id && (l.variantId ?? '') === r.variantId);
      const count = inventory.get(`${p.id}:${r.variantId}`);
      // Same rule as the till: a count already includes what sold before it.
      const soldSince = count ? own.filter((l) => l.at > count.updatedAt).reduce((s, l) => s + l.qty, 0) : 0;
      items.push({
        productId: p.id,
        variantId: r.variantId,
        title: p.title,
        ...(r.variantLabel ? { variantLabel: r.variantLabel } : {}),
        ...(r.sku ? { sku: r.sku } : {}),
        price: r.price,
        ...(p.consignorProductId ? { sourceProductId: p.consignorProductId } : {}),
        onHand: count ? count.onHand : null,
        remaining: count ? Math.max(0, count.onHand - soldSince) : null,
        sold: own.reduce((s, l) => s + l.qty, 0),
      });
    }
  }

  return {
    venues: venueIds.map((id) => venueOf(byId.get(id), id)),
    items: items.sort((a, b) => a.title.localeCompare(b.title) || (a.variantLabel ?? '').localeCompare(b.variantLabel ?? '')),
    lines,
    payouts,
    statement: consignmentStatements(
      lines,
      payouts,
      [consignor.id],
      rentDue(rentalsOf(db, storeAccountId).filter((r) => r.consignorId === consignor.id), today()),
      feesDue(feesOf(db, storeAccountId, consignor.id)),
    )[0]!,
  };
}
