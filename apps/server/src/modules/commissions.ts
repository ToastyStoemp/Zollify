import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  COMMISSION_PUBLIC_PATH,
  COMMISSION_REF_KIND,
  COMMISSION_STATUS_LABEL,
  COMMISSION_TOKEN_RE,
  CommissionCreateSchema,
  CommissionInputSchema,
  CommissionSettingsSchema,
  CommissionUpdateSchema,
  CustomerInputSchema,
  closedAtOf,
  commissionTotals,
  decideErase,
  displayName,
  eraseCommission,
  findDuplicates,
  groupForMigration,
  isClosedStatus,
  phoneDigits,
  totalOwed,
  type Commission,
  type CommissionPayment,
  type CommissionSettings,
  type CommissionTotals,
  type PublicCommission,
  type Transaction,
} from '@zollify/shared';
import { isEnabled, reduceTransactions, type ModuleContext, type PublicModuleContext, type ServerModule } from '@zollify/server-core';
import { renderCommission, renderNotFound } from './commissions-page';

/**
 * Commissions - the server half.
 *
 * A commission is custom work for a customer, tracked from request to pickup.
 * Records and the customer's contact details live in this module's own tables,
 * on the server only: they are personal data, so they are never put into the
 * synced op-log that every till carries.
 *
 * The details are kept once per customer, and commissions point at the
 * customer by id. They are kept only while needed: from the moment every
 * commission of a customer is collected or cancelled, a sweep erases them after
 * the retention period the admin set (see `sweepCustomers`). Erasing deletes
 * the customer and clears the free text on their commissions, and keeps what
 * the books need (title, price, dates, status; what was paid comes from sales).
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

/** How often the sweep looks for customers whose details are due for erasure. */
const SWEEP_MS = 3 * 3600_000;
const MAX_CUSTOMER_LIST = 200;
const SEARCH_LIMIT = 8;

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
    CREATE TABLE IF NOT EXISTS commission_customers (
      accountId   TEXT NOT NULL,
      id          TEXT NOT NULL,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      phone       TEXT NOT NULL,
      phoneDigits TEXT NOT NULL,
      -- Nothing is erased before this; set when a customer was made from older commissions.
      keepFrom    INTEGER NOT NULL DEFAULT 0,
      createdAt   INTEGER NOT NULL,
      updatedAt   INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
  `);
  migrateCustomers(db);
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

// ── Customers ───────────────────────────────────────────────────────────────

interface CustomerRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  keepFrom: number;
  createdAt: number;
  updatedAt: number;
}

interface Contact {
  name: string;
  email: string;
  phone: string;
}

type LegacyCommission = Commission & { customerName?: string; email?: string; phone?: string };

const CUSTOMER_COLS = 'id, name, email, phone, keepFrom, createdAt, updatedAt';

const customersOf = (db: Database.Database, accountId: string): CustomerRow[] =>
  db.prepare(`SELECT ${CUSTOMER_COLS} FROM commission_customers WHERE accountId = ? ORDER BY name COLLATE NOCASE, createdAt`).all(accountId) as CustomerRow[];

const customerRow = (db: Database.Database, accountId: string, id: string): CustomerRow | undefined =>
  db.prepare(`SELECT ${CUSTOMER_COLS} FROM commission_customers WHERE accountId = ? AND id = ?`).get(accountId, id) as CustomerRow | undefined;

function insertCustomer(db: Database.Database, accountId: string, c: CustomerRow): void {
  db.prepare(
    'INSERT INTO commission_customers (accountId, id, name, email, phone, phoneDigits, keepFrom, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(accountId, c.id, c.name, c.email, c.phone, phoneDigits(c.phone), c.keepFrom, c.createdAt, c.updatedAt);
}

/** Name, email and phone only: what a picker or a duplicate offer may show. */
const contactOf = (r: CustomerRow) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone });

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Customers of this account whose name, email or phone contains the text; the account id is always in the query. */
function searchCustomers(db: Database.Database, accountId: string, q: string, limit: number): CustomerRow[] {
  const text = q.trim().toLowerCase();
  if (!text) return customersOf(db, accountId).slice(0, limit);
  const like = `%${escapeLike(text)}%`;
  const digits = phoneDigits(text);
  const digitsLike = digits.length >= 3 ? `%${digits}%` : null;
  return db
    .prepare(
      `SELECT ${CUSTOMER_COLS} FROM commission_customers
       WHERE accountId = @accountId AND (lower(name) LIKE @like ESCAPE '\\' OR email LIKE @like ESCAPE '\\' OR (@digits IS NOT NULL AND phoneDigits LIKE @digits))
       ORDER BY name COLLATE NOCASE, createdAt LIMIT @limit`,
    )
    .all({ accountId, like, digits: digitsLike, limit }) as CustomerRow[];
}

/** Who a commission is for. A commission that predates customer records still carries its own details. */
function contactFor(c: Commission, customers: ReadonlyMap<string, Contact>): Contact | null {
  if (c.customerId) return customers.get(c.customerId) ?? null;
  const legacy = c as LegacyCommission;
  return legacy.customerName ? { name: legacy.customerName, email: legacy.email ?? '', phone: legacy.phone ?? '' } : null;
}

const customerMap = (db: Database.Database, accountId: string): Map<string, Contact> => new Map(customersOf(db, accountId).map((r) => [r.id, r]));

function commissionsOf(db: Database.Database, accountId: string): { c: Commission; token: string }[] {
  return (db.prepare('SELECT doc, token FROM commissions WHERE accountId = ? ORDER BY updatedAt DESC').all(accountId) as Row[]).map((r) => ({ c: parse(r), token: r.token }));
}

/**
 * One-off move of commissions that carry their own customer details onto
 * customer records: same email (any case), else same phone digits, else one
 * customer each. Each customer starts its retention clock at `now`, so
 * deploying erases nothing. Idempotent: a commission with a `customerId` (even
 * null) is skipped, so a second run finds nothing to do. Returns how many
 * customers it made.
 */
export function migrateCustomers(db: Database.Database, now = Date.now()): number {
  const rows = db.prepare('SELECT accountId, doc FROM commissions').all() as { accountId: string; doc: string }[];
  const byAccount = new Map<string, LegacyCommission[]>();
  for (const r of rows) {
    const c = JSON.parse(r.doc) as LegacyCommission;
    if (c.customerId !== undefined) continue;
    byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), c]);
  }
  let made = 0;
  db.transaction(() => {
    for (const [accountId, list] of byAccount) {
      const byId = new Map(list.map((c) => [c.id, c]));
      for (const ids of groupForMigration(list.map((c) => ({ id: c.id, email: c.email ?? '', phone: c.phone ?? '' })))) {
        const group = ids.map((id) => byId.get(id)!).sort((a, b) => b.updatedAt - a.updatedAt);
        const customerId = randomUUID();
        // The newest commission's spelling of the name wins; an email or phone is taken from the first that has one.
        insertCustomer(db, accountId, {
          id: customerId,
          name: group[0]!.customerName || 'Customer',
          email: group.find((c) => c.email)?.email ?? '',
          phone: group.find((c) => c.phone)?.phone ?? '',
          keepFrom: now,
          createdAt: Math.min(...group.map((c) => c.createdAt)),
          updatedAt: now,
        });
        made++;
        for (const c of group) {
          const { customerName: _name, email: _email, phone: _phone, ...rest } = c;
          save(db, accountId, { ...rest, customerId, customerErasedAt: null });
        }
      }
    }
  })();
  return made;
}

/** Erases a customer and clears the personal free text on every commission of theirs. Returns the commissions touched. */
function eraseCustomer(db: Database.Database, accountId: string, customerId: string, now: number): number {
  let touched = 0;
  db.transaction(() => {
    for (const { c } of commissionsOf(db, accountId)) {
      if (c.customerId !== customerId) continue;
      save(db, accountId, eraseCommission(c, now));
      touched++;
    }
    db.prepare('DELETE FROM commission_customers WHERE accountId = ? AND id = ?').run(accountId, customerId);
  })();
  return touched;
}

/** What the retention rule says about each customer of the account right now. */
function erasureStates(db: Database.Database, accountId: string, now: number, retentionDays: number) {
  const byCustomer = new Map<string, Commission[]>();
  for (const { c } of commissionsOf(db, accountId)) if (c.customerId) byCustomer.set(c.customerId, [...(byCustomer.get(c.customerId) ?? []), c]);
  return customersOf(db, accountId).map((customer) => {
    const commissions = byCustomer.get(customer.id) ?? [];
    const decision = decideErase({
      commissions: commissions.map((c) => ({ status: c.status, closedAt: closedAtOf(c) })),
      createdAt: customer.createdAt,
      keepFrom: customer.keepFrom,
      now,
      retentionDays,
    });
    return { customer, commissions, decision };
  });
}

/**
 * Erases every customer whose commissions are all closed and whose retention
 * has run out. Only for accounts with the module switched on: a switched-off
 * module is left alone, and picks up where it was when it is switched on
 * again. Idempotent - an erased customer is gone, so a second run finds
 * nothing. Returns how many customers were erased.
 */
export function sweepCustomers(db: Database.Database, now = Date.now()): number {
  const accounts = db.prepare('SELECT DISTINCT accountId FROM commission_customers').all() as { accountId: string }[];
  let erased = 0;
  for (const { accountId } of accounts) {
    if (!isEnabled(db, accountId, MODULE_ID)) continue;
    const days = readSettings(db, accountId).keepCustomerDays;
    for (const s of erasureStates(db, accountId, now, days)) {
      if (!s.decision.erase) continue;
      eraseCustomer(db, accountId, s.customer.id, now);
      erased++;
    }
  }
  return erased;
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

/** The owner's and staff's view: the record with the customer's details joined in, never stored on it. */
function ownerView(req: FastifyRequest, c: Commission, token: string, totals: CommissionTotals, contact: Contact | null) {
  const { customerName: _name, email: _email, phone: _phone, ...record } = c as LegacyCommission;
  return { ...record, customerName: displayName(contact), email: contact?.email ?? '', phone: contact?.phone ?? '', ...totals, token, publicPath: `${COMMISSION_PUBLIC_PATH}${token}`, publicUrl: `${originOf(req)}${COMMISSION_PUBLIC_PATH}${token}` };
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
  customer: Contact | null,
  link: string,
  update?: { message: string; changed: boolean },
): Promise<boolean> {
  // Only while the customer exists and left an address: after erasure there is nobody to write to.
  if (!customer?.email || !ctx.mail.enabled) return false;
  const shop = readSettings(ctx.db, accountId).shopName || accountName(ctx.db, accountId) || 'The shop';
  const lines = update
    ? [
        `Hi ${customer.name},`,
        '',
        update.changed ? `Your commission "${c.title}" is now: ${COMMISSION_STATUS_LABEL[c.status]}.` : `An update on your commission "${c.title}".`,
        ...(update.message ? ['', update.message] : []),
      ]
    : [`Hi ${customer.name},`, '', `You can follow your commission "${c.title}" here, any time:`];
  const text = [...lines, '', `Track it here: ${link}`, '', `- ${shop}`].join('\n');
  const replyTo = accountEmail(ctx.db, accountId) ?? undefined;
  return ctx.mail.send({
    to: customer.email,
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

    const contactOfCommission = (accountId: string, c: Commission): Contact | null => {
      const row = c.customerId ? customerRow(db, accountId, c.customerId) : undefined;
      return contactFor(c, row ? new Map([[row.id, row]]) : new Map());
    };

    /** One commission as the owner's screens get it, with its customer looked up. */
    const viewOf = (req: FastifyRequest, accountId: string, c: Commission, token: string) => {
      return ownerView(req, c, token, totalsFor(db, accountId, [c]).get(c.id)!, contactOfCommission(accountId, c));
    };

    // The server also sweeps at startup and every few hours; see `sweepCustomers`.
    const sweep = () => {
      try {
        sweepCustomers(db);
      } catch {
        /* the next run tries again */
      }
    };
    app.addHook('onReady', async () => sweep());
    const timer = setInterval(sweep, SWEEP_MS);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));

    app.get('/commissions', async (req) => {
      const who = ctx.identity(req);
      const rows = commissionsOf(db, who.accountId);
      const totals = totalsFor(db, who.accountId, rows.map((r) => r.c));
      const customers = customerMap(db, who.accountId);
      return {
        commissions: rows.map((r) => ownerView(req, r.c, r.token, totals.get(r.c.id)!, contactFor(r.c, customers))),
        settings: readSettings(db, who.accountId),
        emailEnabled: ctx.mail.enabled,
      };
    });

    app.get<{ Params: { id: string } }>('/commissions/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const row = rowOf(db, who.accountId, req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      return viewOf(req, who.accountId, parse(row), row.token);
    });

    app.post('/commissions', async (req, reply) => {
      const who = ctx.identity(req);
      const body = CommissionCreateSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'That commission is not valid.'));
      const { customerId, customer: typedIn, forceNewCustomer, ...input } = body.data;
      const now = Date.now();
      // An existing customer, or a new one typed in the same form. A new one that looks like
      // someone we already have is offered back first; nothing is merged without the seller's say.
      let customer = customerId ? customerRow(db, who.accountId, customerId) : undefined;
      if (customerId && !customer) return reply.code(400).send(bad('That customer no longer exists.'));
      if (!customer && typedIn) {
        const matches = findDuplicates(typedIn, customersOf(db, who.accountId));
        if (matches.length && !forceNewCustomer) {
          return reply.code(409).send({ error: 'customer_exists', message: 'A customer with this email or phone number already exists.', matches: matches.map(contactOf) });
        }
        customer = { id: randomUUID(), ...typedIn, keepFrom: 0, createdAt: now, updatedAt: now };
      }
      const c: Commission = {
        ...input,
        customerId: customer!.id,
        customerErasedAt: null,
        id: randomUUID(),
        status: 'requested',
        updates: [{ id: randomUUID(), at: now, status: 'requested', changed: true, message: '' }],
        createdAt: now,
        updatedAt: now,
        createdBy: who.userId,
      };
      const token = newToken();
      db.transaction(() => {
        if (!customerRow(db, who.accountId, customer!.id)) insertCustomer(db, who.accountId, customer!);
        save(db, who.accountId, c, token);
      })();
      return reply.code(201).send(ownerView(req, c, token, commissionTotals(c.price, []), customer!));
    });

    app.put<{ Params: { id: string } }>('/commissions/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const body = CommissionInputSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'That commission is not valid.'));
      const row = rowOf(db, who.accountId, req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const next: Commission = { ...parse(row), ...body.data, updatedAt: Date.now() };
      save(db, who.accountId, next);
      return viewOf(req, who.accountId, next, row.token);
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
      const emailed = body.data.email ? await tellCustomer(ctx, who.accountId, next, contactOfCommission(who.accountId, next), link, { message: body.data.message, changed }) : false;
      return { commission: viewOf(req, who.accountId, next, row.token), emailed };
    });

    /** Sends the tracking link to the customer's address. */
    app.post<{ Params: { id: string } }>('/commissions/:id/email-link', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
      const who = ctx.identity(req);
      const row = rowOf(db, who.accountId, req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const c = parse(row);
      const customer = contactOfCommission(who.accountId, c);
      if (!customer?.email) return reply.code(400).send(bad('This commission has no email address.'));
      if (!ctx.mail.enabled) return reply.code(409).send(bad('This server cannot send email.'));
      const emailed = await tellCustomer(ctx, who.accountId, c, customer, `${originOf(req)}${COMMISSION_PUBLIC_PATH}${row.token}`);
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
      return viewOf(req, who.accountId, parse(row), token);
    });

    /** Erases a commission and with it the customer's details. Sales already rung up stay in the books. */
    app.delete<{ Params: { id: string } }>('/commissions/:id', async (req, reply) => {
      const who = ctx.identity(req);
      if (adminOnly(who.role)) return reply.code(403).send(forbidden);
      const res = db.prepare('DELETE FROM commissions WHERE accountId = ? AND id = ?').run(who.accountId, IdParam.parse(req.params.id));
      return res.changes ? { ok: true } : reply.code(404).send({ error: 'not_found' });
    });

    // ── Customers ───────────────────────────────────────────────────────────
    // Every query below is scoped by the caller's account id, and a customer is
    // only ever read, changed or erased through it.

    type State = ReturnType<typeof erasureStates>[number];
    const summaryOf = (s: State, totals: Map<string, CommissionTotals>) => ({
      ...contactOf(s.customer),
      createdAt: s.customer.createdAt,
      commissionCount: s.commissions.length,
      openCount: s.commissions.filter((c) => !isClosedStatus(c.status)).length,
      owed: totalOwed(s.commissions.map((c) => ({ status: c.status, balance: totals.get(c.id)!.balance }))),
      /** When the details will be erased; null while a commission is still open. */
      erasesAt: s.decision.dueAt,
    });

    /** Search as you type, for picking a customer on a new commission. Name, email or phone. */
    app.get<{ Querystring: { q?: string } }>('/customers/search', { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async (req) => {
      const who = ctx.identity(req);
      const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
      if (q.trim().length < 2) return { customers: [] };
      return { customers: searchCustomers(db, who.accountId, q, SEARCH_LIMIT).map(contactOf) };
    });

    app.get<{ Querystring: { q?: string } }>('/customers', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      const who = ctx.identity(req);
      const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
      const days = readSettings(db, who.accountId).keepCustomerDays;
      const wanted = new Set(searchCustomers(db, who.accountId, q, MAX_CUSTOMER_LIST).map((r) => r.id));
      const states = erasureStates(db, who.accountId, Date.now(), days).filter((s) => wanted.has(s.customer.id));
      const totals = totalsFor(db, who.accountId, states.flatMap((s) => s.commissions));
      return { customers: states.map((s) => summaryOf(s, totals)), keepCustomerDays: days };
    });

    app.get<{ Params: { id: string } }>('/customers/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const days = readSettings(db, who.accountId).keepCustomerDays;
      const state = erasureStates(db, who.accountId, Date.now(), days).find((s) => s.customer.id === req.params.id);
      if (!state) return reply.code(404).send({ error: 'not_found' });
      const totals = totalsFor(db, who.accountId, state.commissions);
      const tokens = new Map(commissionsOf(db, who.accountId).map((r) => [r.c.id, r.token]));
      const contact = contactOf(state.customer);
      return {
        customer: summaryOf(state, totals),
        commissions: state.commissions.map((c) => ownerView(req, c, tokens.get(c.id) ?? '', totals.get(c.id)!, contact)),
        keepCustomerDays: days,
      };
    });

    /** Corrects a customer's details. Staff may: a typo in a phone number is everyday work. */
    app.put<{ Params: { id: string } }>('/customers/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const body = CustomerInputSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'That customer is not valid.'));
      const res = db
        .prepare('UPDATE commission_customers SET name = ?, email = ?, phone = ?, phoneDigits = ?, updatedAt = ? WHERE accountId = ? AND id = ?')
        .run(body.data.name, body.data.email, body.data.phone, phoneDigits(body.data.phone), Date.now(), who.accountId, req.params.id);
      if (!res.changes) return reply.code(404).send({ error: 'not_found' });
      return contactOf(customerRow(db, who.accountId, req.params.id)!);
    });

    /** Every customer with nothing open, now, without waiting for the retention period. Admin only. */
    app.post('/customers/erase-closed', async (req, reply) => {
      const who = ctx.identity(req);
      if (adminOnly(who.role)) return reply.code(403).send(forbidden);
      const now = Date.now();
      let erased = 0;
      for (const s of erasureStates(db, who.accountId, now, readSettings(db, who.accountId).keepCustomerDays)) {
        if (s.decision.needed) continue;
        eraseCustomer(db, who.accountId, s.customer.id, now);
        erased++;
      }
      return { erased };
    });

    /** Erases one customer now. Refused while they have a commission that is not collected or cancelled. Admin only. */
    app.post<{ Params: { id: string } }>('/customers/:id/erase', async (req, reply) => {
      const who = ctx.identity(req);
      if (adminOnly(who.role)) return reply.code(403).send(forbidden);
      const days = readSettings(db, who.accountId).keepCustomerDays;
      const state = erasureStates(db, who.accountId, Date.now(), days).find((s) => s.customer.id === req.params.id);
      if (!state) return reply.code(404).send({ error: 'not_found' });
      if (state.decision.needed) return reply.code(409).send(bad('This customer still has an open commission. Collect or cancel it first.'));
      return { ok: true, commissions: eraseCustomer(db, who.accountId, state.customer.id, Date.now()) };
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
