import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  ORDER_STATUSES,
  OrderInputSchema,
  TradeCustomerSchema,
  TradeDetailsSchema,
  expectedShipDate,
  isEditable,
  nextOrderStatuses,
  reservedByItem,
  type OrderStatus,
  type TradeCustomer,
  type TradeDetails,
  type WholesaleOrder,
} from '@zollify/shared';
import type { ModuleContext, ServerModule } from '@zollify/server-core';

/**
 * Wholesale - the server half: what each product is to the trade, the
 * trade customers, and the orders. Records only; stock and revenue are
 * core's, driven from the app side (claims while an order is open, a sale
 * at the Wholesale store when it ships), so nothing here is a second
 * inventory.
 */

const MODULE_ID = 'wholesale';
const MAX_ORDERS = 2000;

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wholesale_products (
      accountId TEXT NOT NULL,
      productId TEXT NOT NULL,
      doc       TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, productId)
    );
    CREATE TABLE IF NOT EXISTS wholesale_customers (
      accountId TEXT NOT NULL,
      id        TEXT NOT NULL,
      doc       TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE TABLE IF NOT EXISTS wholesale_orders (
      accountId TEXT NOT NULL,
      id        TEXT NOT NULL,
      number    INTEGER NOT NULL,
      status    TEXT NOT NULL,
      doc       TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_wholesale_orders_account ON wholesale_orders(accountId, createdAt);
  `);
}

// ── Storage ─────────────────────────────────────────────────────────────────

const parse = <T>(r: { doc: string }): T => JSON.parse(r.doc) as T;

function detailsOf(db: Database.Database, accountId: string): Record<string, TradeDetails> {
  const rows = db.prepare('SELECT productId, doc FROM wholesale_products WHERE accountId = ?').all(accountId) as { productId: string; doc: string }[];
  const out: Record<string, TradeDetails> = {};
  for (const r of rows) {
    const parsed = TradeDetailsSchema.safeParse(JSON.parse(r.doc));
    if (parsed.success) out[r.productId] = parsed.data;
  }
  return out;
}

const customersOf = (db: Database.Database, accountId: string): TradeCustomer[] =>
  (db.prepare('SELECT doc FROM wholesale_customers WHERE accountId = ? ORDER BY createdAt').all(accountId) as { doc: string }[]).map((r) => parse<TradeCustomer>(r)).sort((a, b) => a.company.localeCompare(b.company));

const customerOf = (db: Database.Database, accountId: string, id: string): TradeCustomer | undefined => {
  const row = db.prepare('SELECT doc FROM wholesale_customers WHERE accountId = ? AND id = ?').get(accountId, id) as { doc: string } | undefined;
  return row ? parse<TradeCustomer>(row) : undefined;
};

function saveCustomer(db: Database.Database, accountId: string, c: TradeCustomer): void {
  db.prepare('INSERT INTO wholesale_customers (accountId, id, doc, createdAt) VALUES (?, ?, ?, ?) ON CONFLICT(accountId, id) DO UPDATE SET doc = excluded.doc').run(accountId, c.id, JSON.stringify(c), c.createdAt);
}

const ordersOf = (db: Database.Database, accountId: string): WholesaleOrder[] =>
  (db.prepare('SELECT doc FROM wholesale_orders WHERE accountId = ? ORDER BY number DESC').all(accountId) as { doc: string }[]).map((r) => parse<WholesaleOrder>(r));

const orderOf = (db: Database.Database, accountId: string, id: string): WholesaleOrder | undefined => {
  const row = db.prepare('SELECT doc FROM wholesale_orders WHERE accountId = ? AND id = ?').get(accountId, id) as { doc: string } | undefined;
  return row ? parse<WholesaleOrder>(row) : undefined;
};

function saveOrder(db: Database.Database, accountId: string, o: WholesaleOrder): void {
  db.prepare(
    'INSERT INTO wholesale_orders (accountId, id, number, status, doc, createdAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(accountId, id) DO UPDATE SET status = excluded.status, doc = excluded.doc',
  ).run(accountId, o.id, o.number, o.status, JSON.stringify(o), o.createdAt);
}

const nextNumber = (db: Database.Database, accountId: string): number =>
  ((db.prepare('SELECT MAX(number) AS n FROM wholesale_orders WHERE accountId = ?').get(accountId) as { n: number | null }).n ?? 0) + 1;

// ── Routes ──────────────────────────────────────────────────────────────────

const IdParam = z.string().min(1).max(80);
const StatusBody = z.object({ status: z.enum(ORDER_STATUSES), saleId: z.string().max(80).nullable().optional() });

export const wholesaleServerModule: ServerModule = {
  id: MODULE_ID,
  // Prices to the trade, customers and orders are the account holder's business.
  minRole: 'admin',
  migrate,
  onAccountDeleted: (db, accountId) => {
    for (const t of ['wholesale_products', 'wholesale_customers', 'wholesale_orders']) db.prepare(`DELETE FROM ${t} WHERE accountId = ?`).run(accountId);
  },

  routes: (ctx: ModuleContext) => async (app) => {
    const { db } = ctx;
    const bad = (message: string) => ({ error: 'invalid_request', message });

    // ── Trade details per product ───────────────────────────────────────
    app.get('/products', async (req) => ({ details: detailsOf(db, ctx.identity(req).accountId) }));

    app.put<{ Params: { productId: string } }>('/products/:productId', async (req, reply) => {
      const who = ctx.identity(req);
      const body = TradeDetailsSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'Check the trade details.'));
      const tiers = [...body.data.tiers].sort((a, b) => a.minQty - b.minQty);
      if (new Set(tiers.map((t) => t.minQty)).size !== tiers.length) return reply.code(400).send(bad('Two tiers start at the same quantity.'));
      const details = { ...body.data, tiers };
      db.prepare('INSERT INTO wholesale_products (accountId, productId, doc, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(accountId, productId) DO UPDATE SET doc = excluded.doc, updatedAt = excluded.updatedAt').run(
        who.accountId,
        IdParam.parse(req.params.productId),
        JSON.stringify(details),
        Date.now(),
      );
      return { details };
    });

    app.delete<{ Params: { productId: string } }>('/products/:productId', async (req) => {
      db.prepare('DELETE FROM wholesale_products WHERE accountId = ? AND productId = ?').run(ctx.identity(req).accountId, IdParam.parse(req.params.productId));
      return { ok: true };
    });

    // ── Customers ───────────────────────────────────────────────────────
    app.get('/customers', async (req) => ({ customers: customersOf(db, ctx.identity(req).accountId) }));

    app.post('/customers', async (req, reply) => {
      const who = ctx.identity(req);
      const body = TradeCustomerSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'Check the customer.'));
      const now = Date.now();
      const c: TradeCustomer = { ...body.data, id: randomUUID(), createdAt: now, updatedAt: now };
      saveCustomer(db, who.accountId, c);
      return reply.code(201).send({ customer: c });
    });

    app.put<{ Params: { id: string } }>('/customers/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const body = TradeCustomerSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'Check the customer.'));
      const existing = customerOf(db, who.accountId, IdParam.parse(req.params.id));
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      const c: TradeCustomer = { ...existing, ...body.data, updatedAt: Date.now() };
      saveCustomer(db, who.accountId, c);
      return { customer: c };
    });

    /** Gone for good - only with no orders; otherwise archive. */
    app.delete<{ Params: { id: string } }>('/customers/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const id = IdParam.parse(req.params.id);
      if (ordersOf(db, who.accountId).some((o) => o.customerId === id)) return reply.code(409).send(bad('This customer has orders - archive them instead.'));
      const res = db.prepare('DELETE FROM wholesale_customers WHERE accountId = ? AND id = ?').run(who.accountId, id);
      return res.changes ? { ok: true } : reply.code(404).send({ error: 'not_found' });
    });

    // ── Orders ──────────────────────────────────────────────────────────
    app.get('/orders', async (req) => {
      const who = ctx.identity(req);
      const orders = ordersOf(db, who.accountId);
      return { orders, reserved: Object.fromEntries(reservedByItem(orders)) };
    });

    const leadOf = (accountId: string) => {
      const details = detailsOf(db, accountId);
      return (productId: string): number => details[productId]?.leadDays ?? 0;
    };

    app.post('/orders', async (req, reply) => {
      const who = ctx.identity(req);
      const body = OrderInputSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'Check the order.'));
      const customer = customerOf(db, who.accountId, body.data.customerId);
      if (!customer) return reply.code(400).send(bad('That customer no longer exists.'));
      if (ordersOf(db, who.accountId).length >= MAX_ORDERS) return reply.code(503).send(bad('Too many orders - archive some first.'));
      const now = Date.now();
      const o: WholesaleOrder = {
        ...body.data,
        id: randomUUID(),
        number: nextNumber(db, who.accountId),
        status: 'draft',
        expectedShipDate: expectedShipDate(now, leadOf(who.accountId), body.data.lines),
        createdAt: now,
        updatedAt: now,
        confirmedAt: null,
        shippedAt: null,
        saleId: null,
        createdBy: who.userId,
      };
      saveOrder(db, who.accountId, o);
      return reply.code(201).send({ order: o });
    });

    app.put<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const body = OrderInputSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'Check the order.'));
      const existing = orderOf(db, who.accountId, IdParam.parse(req.params.id));
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (!isEditable(existing.status)) return reply.code(409).send(bad(`A ${existing.status} order cannot be changed.`));
      if (!customerOf(db, who.accountId, body.data.customerId)) return reply.code(400).send(bad('That customer no longer exists.'));
      const o: WholesaleOrder = { ...existing, ...body.data, updatedAt: Date.now(), expectedShipDate: expectedShipDate(existing.confirmedAt ?? existing.createdAt, leadOf(who.accountId), body.data.lines) };
      saveOrder(db, who.accountId, o);
      return { order: o };
    });

    /** Moves an order on. Shipping may carry the id of the sale the app recorded for it. */
    app.post<{ Params: { id: string } }>('/orders/:id/status', async (req, reply) => {
      const who = ctx.identity(req);
      const body = StatusBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad('Pick a status.'));
      const existing = orderOf(db, who.accountId, IdParam.parse(req.params.id));
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      const to: OrderStatus = body.data.status;
      if (!nextOrderStatuses(existing.status).includes(to)) return reply.code(409).send(bad(`A ${existing.status} order cannot become ${to}.`));
      if (to === 'confirmed' && !existing.lines.length) return reply.code(409).send(bad('Add some lines first.'));
      const now = Date.now();
      const o: WholesaleOrder = {
        ...existing,
        status: to,
        updatedAt: now,
        ...(to === 'confirmed' ? { confirmedAt: now, expectedShipDate: expectedShipDate(now, leadOf(who.accountId), existing.lines) } : {}),
        ...(to === 'shipped' ? { shippedAt: now, saleId: body.data.saleId ?? existing.saleId } : {}),
      };
      saveOrder(db, who.accountId, o);
      return { order: o };
    });

    app.delete<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const existing = orderOf(db, who.accountId, IdParam.parse(req.params.id));
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (existing.status !== 'draft' && existing.status !== 'cancelled') return reply.code(409).send(bad('Only a draft or cancelled order can be deleted.'));
      db.prepare('DELETE FROM wholesale_orders WHERE accountId = ? AND id = ?').run(who.accountId, existing.id);
      return { ok: true };
    });
  },
};
