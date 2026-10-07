import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  COMMISSION_PUBLIC_PATH,
  COMMISSION_REF_KIND,
  COMMISSION_STATUS_LABEL,
  COMMISSION_TOKEN_RE,
  CommissionInputSchema,
  CommissionSettingsSchema,
  CommissionUpdateSchema,
  commissionTotals,
  isClosedStatus,
  type Commission,
  type CommissionPayment,
  type CommissionSettings,
  type CommissionTotals,
  type PublicCommission,
  type Transaction,
} from '@zollify/shared';
import { reduceTransactions, type ModuleContext, type PublicModuleContext, type ServerModule } from '@zollify/server-core';
import { renderCommission, renderNotFound } from './commissions-page';

/**
 * Commissions - the server half.
 *
 * A commission is custom work for a customer, tracked from request to pickup.
 * Records and the customer's contact details live in this module's own tables,
 * on the server only: they are personal data, so they are never put into the
 * synced op-log that every till carries.
 *
 * What was paid is never stored. The till rings a deposit or balance as an
 * ordinary sale line whose `ref` names the commission, and the paid-so-far is
 * summed from those sale lines every time it is needed - like stock, so
 * reverting the sale puts the balance back with no compensating write.
 *
 * The customer's page lives at `/p/commissions/<token>`. The token is the only
 * thing it knows; the page is built by `publicView`, the one place that picks
 * what may leave - never a spread of the record.
 */

const MODULE_ID = 'commissions';
const MAX_UPDATES = 200;
/** Public timeline length. */
const PUBLIC_UPDATES = 30;

const newToken = (): string => randomBytes(24).toString('base64url');

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS commissions (
      accountId TEXT NOT NULL,
      id        TEXT NOT NULL,
      doc       TEXT NOT NULL,
      token     TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_commissions_account ON commissions(accountId, updatedAt);
    CREATE TABLE IF NOT EXISTS commissions_settings (
      accountId TEXT PRIMARY KEY,
      doc       TEXT NOT NULL
    );
  `);
}

// ── Storage ─────────────────────────────────────────────────────────────────

interface Row {
  doc: string;
  token: string;
}

const parse = (r: Row): Commission => JSON.parse(r.doc) as Commission;

function rowOf(db: Database.Database, accountId: string, id: string): Row | undefined {
  return db.prepare('SELECT doc, token FROM commissions WHERE accountId = ? AND id = ?').get(accountId, id) as Row | undefined;
}

function save(db: Database.Database, accountId: string, c: Commission, token?: string): void {
  db.prepare(
    `INSERT INTO commissions (accountId, id, doc, token, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(accountId, id) DO UPDATE SET doc = excluded.doc, updatedAt = excluded.updatedAt`,
  ).run(accountId, c.id, JSON.stringify(c), token ?? '', c.createdAt, c.updatedAt);
}

function readSettings(db: Database.Database, accountId: string): CommissionSettings {
  const row = db.prepare('SELECT doc FROM commissions_settings WHERE accountId = ?').get(accountId) as { doc: string } | undefined;
  const parsed = CommissionSettingsSchema.safeParse(row ? JSON.parse(row.doc) : {});
  return parsed.success ? parsed.data : CommissionSettingsSchema.parse({});
}

const accountName = (db: Database.Database, accountId: string): string =>
  (db.prepare('SELECT name FROM accounts WHERE id = ?').get(accountId) as { name: string } | undefined)?.name ?? '';

const accountEmail = (db: Database.Database, accountId: string): string | null =>
  (
    db
      .prepare("SELECT email FROM users WHERE accountId = ? AND role IN ('owner','admin') ORDER BY role = 'owner' DESC, createdAt LIMIT 1")
      .get(accountId) as { email: string } | undefined
  )?.email ?? null;

/** The origin people reach this server at, for links in emails and the QR code. */
function originOf(req: FastifyRequest): string {
  // PUBLIC_ORIGIN when set; otherwise what Fastify derives, which honours forwarded headers
  // only from a trusted proxy - a raw X-Forwarded-Host would let anyone point the links elsewhere.
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  return `${req.protocol}://${req.host}`;
}

// ── What was paid, from the till's own records ──────────────────────────────

/** A sale line's amount in the commission's currency (the book currency when the till converted). */
function lineAmount(tx: Transaction, lineTotal: number, baseLineTotal: number | undefined, currency: string): number {
  if (tx.currency !== currency && tx.baseCurrency === currency && typeof baseLineTotal === 'number') return baseLineTotal;
  return lineTotal;
}

/**
 * Payments per commission: every sale line that refers to it, in a sale that
 * was not reverted. Derived on each call, so a refund at the till gives the
 * balance back and an offline sale counts the moment it syncs.
 */
export function paymentsByCommission(db: Database.Database, accountId: string, currencyOf: (id: string) => string | undefined): Map<string, CommissionPayment[]> {
  // Only the sales that mention this module are parsed; the revert ops are few and tiny.
  const creates = db
    .prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type = 'tx.create' AND payload LIKE ? ORDER BY seq")
    .all(accountId, `%${MODULE_ID}%`) as { opId: string; type: string; payload: string }[];
  const out = new Map<string, CommissionPayment[]>();
  if (!creates.length) return out;
  const reverts = db.prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type = 'tx.revert' ORDER BY seq").all(accountId) as {
    opId: string;
    type: string;
    payload: string;
  }[];
  const txs = reduceTransactions([...creates, ...reverts].map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) })));
  for (const tx of txs) {
    if (tx.revertedAt || tx.revertedBy) continue;
    for (const item of tx.items) {
      const ref = item.ref;
      if (!ref || ref.moduleId !== MODULE_ID || ref.kind !== COMMISSION_REF_KIND) continue;
      const currency = currencyOf(ref.id);
      if (!currency) continue;
      const amount = lineAmount(tx, item.lineTotal, item.baseLineTotal, currency);
      const list = out.get(ref.id) ?? [];
      list.push({ saleId: tx.id, at: tx.timestamp, amount, label: item.title });
      out.set(ref.id, list);
    }
  }
  return out;
}

function totalsFor(db: Database.Database, accountId: string, all: Commission[]): Map<string, CommissionTotals> {
  const byId = new Map(all.map((c) => [c.id, c]));
  const payments = paymentsByCommission(db, accountId, (id) => byId.get(id)?.currency);
  return new Map(all.map((c) => [c.id, commissionTotals(c.price, (payments.get(c.id) ?? []).sort((a, b) => a.at - b.at))]));
}

// ── Views ───────────────────────────────────────────────────────────────────

function ownerView(req: FastifyRequest, c: Commission, token: string, totals: CommissionTotals) {
  return { ...c, ...totals, token, publicPath: `${COMMISSION_PUBLIC_PATH}${token}`, publicUrl: `${originOf(req)}${COMMISSION_PUBLIC_PATH}${token}` };
}

/** The single place that decides what the customer's page may know. */
export function publicView(c: Commission, totals: CommissionTotals, settings: CommissionSettings, shop: string): PublicCommission {
  const pickup = { name: settings.pickupName, address: settings.pickupAddress, note: settings.pickupNote };
  return {
    shop: settings.shopName || shop,
    title: c.title,
    status: c.status,
    statusLabel: COMMISSION_STATUS_LABEL[c.status],
    dueDate: isClosedStatus(c.status) ? '' : c.dueDate,
    timeZone: settings.timeZone,
    currency: c.currency,
    price: c.price,
    paid: totals.paid,
    balance: totals.balance,
    updates: [...c.updates]
      .sort((a, b) => b.at - a.at)
      .slice(0, PUBLIC_UPDATES)
      .map((u) => ({ at: u.at, status: u.status, statusLabel: COMMISSION_STATUS_LABEL[u.status], changed: u.changed, message: u.message })),
    pickup: pickup.name || pickup.address || pickup.note ? pickup : null,
  };
}

// ── Email ───────────────────────────────────────────────────────────────────

async function tellCustomer(
  ctx: Pick<ModuleContext, 'mail' | 'db'>,
  accountId: string,
  c: Commission,
  link: string,
  update?: { message: string; changed: boolean },
): Promise<boolean> {
  if (!c.email || !ctx.mail.enabled) return false;
  const shop = readSettings(ctx.db, accountId).shopName || accountName(ctx.db, accountId) || 'The shop';
  const lines = update
    ? [
        `Hi ${c.customerName},`,
        '',
        update.changed ? `Your commission "${c.title}" is now: ${COMMISSION_STATUS_LABEL[c.status]}.` : `An update on your commission "${c.title}".`,
        ...(update.message ? ['', update.message] : []),
      ]
    : [`Hi ${c.customerName},`, '', `You can follow your commission "${c.title}" here, any time:`];
  const text = [...lines, '', `Track it here: ${link}`, '', `- ${shop}`].join('\n');
  const replyTo = accountEmail(ctx.db, accountId) ?? undefined;
  return ctx.mail.send({
    to: c.email,
    subject: update ? `${c.title}: ${COMMISSION_STATUS_LABEL[c.status]}` : `Follow your commission: ${c.title}`,
    text,
    ...(replyTo ? { replyTo } : {}),
  });
}

// ── Routes ──────────────────────────────────────────────────────────────────

const IdParam = z.string().min(1).max(80);

export const commissionsServerModule: ServerModule = {
  id: MODULE_ID,
  // Staff create and update commissions and take payments at the till.
  // Settings, link replacement and erasure are admin-only below.
  minRole: 'member',
  migrate,

  routes: (ctx: ModuleContext) => async (app) => {
    const { db } = ctx;
    const bad = (message: string) => ({ error: 'invalid_request', message });
    const adminOnly = (role: string) => role === 'member';
    const forbidden = { error: 'forbidden', message: 'Only an admin can do that.' };

    const all = (accountId: string): { c: Commission; token: string }[] =>
      (db.prepare('SELECT doc, token FROM commissions WHERE accountId = ? ORDER BY updatedAt DESC').all(accountId) as Row[]).map((r) => ({ c: parse(r), token: r.token }));

    app.get('/commissions', async (req) => {
      const who = ctx.identity(req);
      const rows = all(who.accountId);
      const totals = totalsFor(db, who.accountId, rows.map((r) => r.c));
      return {
        commissions: rows.map((r) => ownerView(req, r.c, r.token, totals.get(r.c.id)!)),
        settings: readSettings(db, who.accountId),
        emailEnabled: ctx.mail.enabled,
      };
    });

    app.get<{ Params: { id: string } }>('/commissions/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const row = rowOf(db, who.accountId, req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const c = parse(row);
      return ownerView(req, c, row.token, totalsFor(db, who.accountId, [c]).get(c.id)!);
    });

    app.post('/commissions', async (req, reply) => {
      const who = ctx.identity(req);
      const body = CommissionInputSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'That commission is not valid.'));
      const now = Date.now();
      const c: Commission = {
        ...body.data,
        id: randomUUID(),
        status: 'requested',
        updates: [{ id: randomUUID(), at: now, status: 'requested', changed: true, message: '' }],
        createdAt: now,
        updatedAt: now,
        createdBy: who.userId,
      };
      const token = newToken();
      save(db, who.accountId, c, token);
      return reply.code(201).send(ownerView(req, c, token, commissionTotals(c.price, [])));
    });

    app.put<{ Params: { id: string } }>('/commissions/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const body = CommissionInputSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'That commission is not valid.'));
      const row = rowOf(db, who.accountId, req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const next: Commission = { ...parse(row), ...body.data, updatedAt: Date.now() };
      save(db, who.accountId, next);
      return ownerView(req, next, row.token, totalsFor(db, who.accountId, [next]).get(next.id)!);
    });

    /** Moves it to a new step and/or posts a message the customer sees. */
    app.post<{ Params: { id: string } }>('/commissions/:id/updates', async (req, reply) => {
      const who = ctx.identity(req);
      const body = CommissionUpdateSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'That update is not valid.'));
      const row = rowOf(db, who.accountId, req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const c = parse(row);
      const changed = !!body.data.status && body.data.status !== c.status;
      if (changed && isClosedStatus(c.status)) return reply.code(409).send(bad(`This commission is ${COMMISSION_STATUS_LABEL[c.status].toLowerCase()} and cannot move on.`));
      if (!changed && !body.data.message) return reply.code(400).send(bad('Pick a new status or write a message.'));
      const status = changed ? body.data.status! : c.status;
      const now = Date.now();
      const next: Commission = {
        ...c,
        status,
        updates: [...c.updates, { id: randomUUID(), at: now, status, changed, message: body.data.message }].slice(-MAX_UPDATES),
        updatedAt: now,
      };
      save(db, who.accountId, next);
      const link = `${originOf(req)}${COMMISSION_PUBLIC_PATH}${row.token}`;
      const emailed = body.data.email ? await tellCustomer(ctx, who.accountId, next, link, { message: body.data.message, changed }) : false;
      return { commission: ownerView(req, next, row.token, totalsFor(db, who.accountId, [next]).get(next.id)!), emailed };
    });

    /** Sends the tracking link to the customer's address. */
    app.post<{ Params: { id: string } }>('/commissions/:id/email-link', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
      const who = ctx.identity(req);
      const row = rowOf(db, who.accountId, req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const c = parse(row);
      if (!c.email) return reply.code(400).send(bad('This commission has no email address.'));
      if (!ctx.mail.enabled) return reply.code(409).send(bad('This server cannot send email.'));
      const emailed = await tellCustomer(ctx, who.accountId, c, `${originOf(req)}${COMMISSION_PUBLIC_PATH}${row.token}`);
      return { emailed };
    });

    /** A new link; the old one stops working. */
    app.post<{ Params: { id: string } }>('/commissions/:id/link', async (req, reply) => {
      const who = ctx.identity(req);
      if (adminOnly(who.role)) return reply.code(403).send(forbidden);
      const row = rowOf(db, who.accountId, req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const token = newToken();
      db.prepare('UPDATE commissions SET token = ? WHERE accountId = ? AND id = ?').run(token, who.accountId, req.params.id);
      const c = parse(row);
      return ownerView(req, c, token, totalsFor(db, who.accountId, [c]).get(c.id)!);
    });

    /** Erases a commission and with it the customer's details. Sales already rung up stay in the books. */
    app.delete<{ Params: { id: string } }>('/commissions/:id', async (req, reply) => {
      const who = ctx.identity(req);
      if (adminOnly(who.role)) return reply.code(403).send(forbidden);
      const res = db.prepare('DELETE FROM commissions WHERE accountId = ? AND id = ?').run(who.accountId, IdParam.parse(req.params.id));
      return res.changes ? { ok: true } : reply.code(404).send({ error: 'not_found' });
    });

    app.get('/settings', async (req) => readSettings(db, ctx.identity(req).accountId));

    app.put('/settings', async (req, reply) => {
      const who = ctx.identity(req);
      if (adminOnly(who.role)) return reply.code(403).send(forbidden);
      const body = CommissionSettingsSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'Those settings are not valid.'));
      db.prepare('INSERT INTO commissions_settings (accountId, doc) VALUES (?, ?) ON CONFLICT(accountId) DO UPDATE SET doc = excluded.doc').run(who.accountId, JSON.stringify(body.data));
      return body.data;
    });
  },

  /** The customer's tracking page: `/p/commissions/<token>`. */
  publicRoutes: (ctx: PublicModuleContext) => async (app) => {
    const { db } = ctx;

    // A personal page: never cached, never indexed, and it does not leak its own address.
    app.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
      reply.header('referrer-policy', 'no-referrer');
      reply.header('x-robots-tag', 'noindex, nofollow, noarchive');
    });

    app.get<{ Params: { token: string } }>('/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
      const missing = () => reply.code(404).type('text/html; charset=utf-8').send(renderNotFound());
      if (!COMMISSION_TOKEN_RE.test(req.params.token)) return missing();
      const row = db.prepare('SELECT accountId, doc FROM commissions WHERE token = ?').get(req.params.token) as { accountId: string; doc: string } | undefined;
      if (!row || !ctx.isEnabled(row.accountId)) return missing();
      const c = JSON.parse(row.doc) as Commission;
      const totals = totalsFor(db, row.accountId, [c]).get(c.id)!;
      const page = renderCommission(publicView(c, totals, readSettings(db, row.accountId), accountName(db, row.accountId)));
      return reply.type('text/html; charset=utf-8').send(page);
    });
  },
};
