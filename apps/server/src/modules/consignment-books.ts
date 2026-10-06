import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BooksSettingsSchema,
  DEFAULT_BOOKS_SETTINGS,
  FEE_REASONS,
  FeeInputSchema,
  isTimeZone,
  localDay,
  recentPeriods,
  reportCsv,
  reportPeriod,
  storeReport,
  type BooksSettings,
  type ConsignmentFee,
  type ReportPeriod,
  type SetupMoment,
  type StoreReport,
} from '@zollify/shared';
import { isEnabled, type ModuleContext, type ModuleServices } from '@zollify/server-core';
import { MODULE_ID, accountName, consignorRow, consignorRows, parseDoc, payoutsFor, replay, toConsignor } from './consignment';
import { accountEmail, get, rentalsOf, tellArtist } from './consignment-planner';
import { endArtistDiscounts } from './consignment-discounts';

/**
 * The store's books: fees it charges artists, how it accounts card costs,
 * and the report it closes every two weeks or month.
 *
 * A fee is the store's to issue and waive; the artist is told either way,
 * sees it in their statement, and can object - which reaches the owner.
 * Reports are computed on demand from the op-log, so a past period always
 * reads the same; closing a period only decides when the owner is emailed.
 */

export function migrateBooks(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consignment_fees (
      accountId   TEXT NOT NULL,
      id          TEXT NOT NULL,
      consignorId TEXT NOT NULL,
      doc         TEXT NOT NULL,
      createdAt   INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_consignment_fees ON consignment_fees(accountId, consignorId);
    CREATE TABLE IF NOT EXISTS consignment_settings (
      accountId TEXT PRIMARY KEY,
      doc       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS consignment_reports_sent (
      accountId  TEXT NOT NULL,
      periodFrom TEXT NOT NULL,
      sentAt     INTEGER NOT NULL,
      PRIMARY KEY (accountId, periodFrom)
    );
  `);
}

// ── Data access ─────────────────────────────────────────────────────────────

export function booksSettings(db: Database.Database, accountId: string): BooksSettings {
  const row = db.prepare('SELECT doc FROM consignment_settings WHERE accountId = ?').get(accountId) as { doc: string } | undefined;
  if (!row) return DEFAULT_BOOKS_SETTINGS;
  const parsed = BooksSettingsSchema.safeParse(JSON.parse(row.doc));
  return parsed.success ? parsed.data : DEFAULT_BOOKS_SETTINGS;
}

export function feesOf(db: Database.Database, accountId: string, consignorId?: string): ConsignmentFee[] {
  const rows = (
    consignorId
      ? db.prepare('SELECT doc FROM consignment_fees WHERE accountId = ? AND consignorId = ? ORDER BY createdAt DESC').all(accountId, consignorId)
      : db.prepare('SELECT doc FROM consignment_fees WHERE accountId = ? ORDER BY createdAt DESC').all(accountId)
  ) as { doc: string }[];
  return rows.map((r) => JSON.parse(r.doc) as ConsignmentFee);
}

function saveFee(db: Database.Database, accountId: string, fee: ConsignmentFee): void {
  db.prepare(
    'INSERT INTO consignment_fees (accountId, id, consignorId, doc, createdAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(accountId, id) DO UPDATE SET doc = excluded.doc',
  ).run(accountId, fee.id, fee.consignorId, JSON.stringify(fee), fee.createdAt);
}

/** One period's report for a store account. */
export function reportFor(db: Database.Database, accountId: string, period: ReportPeriod): StoreReport {
  const settings = booksSettings(db, accountId);
  return storeReport({
    period,
    settings,
    transactions: replay(db, accountId).transactions,
    consignors: consignorRows(db, accountId).map((r) => toConsignor(db, r)),
    payouts: payoutsFor(db, accountId),
    fees: feesOf(db, accountId),
    rentals: rentalsOf(db, accountId),
  });
}

const money = (n: number, currency: string): string => `${currency} ${n.toFixed(2)}`;
const periodLabel = (p: ReportPeriod): string => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${d(p.from)} - ${d(p.to)}`;
};

/** The report as an email: the headline numbers, and the CSV for the detail. */
function reportMail(storeName: string, r: StoreReport, venueName: (id: string) => string) {
  const lines = [`${storeName} - report for ${periodLabel(r.period)}`, ''];
  for (const t of r.totals) {
    lines.push(
      `Sales: ${t.sales} (${t.units} items), ${money(t.gross, t.currency)}`,
      `  Discounts given: ${money(t.discounts, t.currency)}`,
      `  VAT included: ${money(t.vat, t.currency)}`,
      `  Cash ${money(t.cash, t.currency)} · Card ${money(t.card, t.currency)}${t.other ? ` · Other ${money(t.other, t.currency)}` : ''}`,
      ...(t.cardFees ? [`  Card costs: ${money(t.cardFees, t.currency)}${t.cardFeesPassed ? ` (${money(t.cardFeesPassed, t.currency)} carried by artists)` : ''}`] : []),
      `  Artists' work: ${money(t.consigned, t.currency)} - your commission ${money(t.commission, t.currency)}, theirs ${money(t.artistShare, t.currency)}`,
      `  Your own stock: ${money(t.own, t.currency)}`,
      '',
    );
  }
  const owed = r.artists.filter((a) => a.balance > 0);
  if (owed.length) {
    lines.push('To pay out:');
    for (const a of owed) lines.push(`  ${a.name}: ${money(a.balance, a.currency)}`);
    lines.push('');
  }
  lines.push('The attached spreadsheet has every artist and store. Record payouts in Zollify under Consignment → Reports.');
  return {
    subject: `${storeName}: report for ${periodLabel(r.period)}`,
    text: lines.join('\n'),
    attachments: [{ filename: `report-${r.period.from}.csv`, content: reportCsv(r, venueName), contentType: 'text/csv' }],
  };
}

const venueNamer = (db: Database.Database, accountId: string) => {
  const events = new Map(replay(db, accountId).events.map((e) => [e.id, e.name]));
  return (id: string): string => events.get(id) ?? id;
};

/**
 * Email each store the report for the period that just closed - once. A
 * store with nothing to report for it (no sales, nobody owed) is skipped,
 * but marked, so it is not reconsidered every hour.
 */
export async function sendClosedReports(svc: ModuleServices, now = Date.now()): Promise<number> {
  const { db } = svc;
  let sent = 0;
  const accounts = db.prepare('SELECT DISTINCT accountId FROM consignors').all() as { accountId: string }[];
  for (const { accountId } of accounts) {
    if (!isEnabled(db, accountId, MODULE_ID)) continue;
    const settings = booksSettings(db, accountId);
    if (!settings.emailReport) continue;
    const current = reportPeriod(settings, localDay(now, settings.timeZone));
    const closed = recentPeriods(settings, current.from, 2)[1]!;
    const done = db.prepare('SELECT 1 FROM consignment_reports_sent WHERE accountId = ? AND periodFrom = ?').get(accountId, closed.from);
    if (done) continue;
    db.prepare('INSERT INTO consignment_reports_sent (accountId, periodFrom, sentAt) VALUES (?, ?, ?)').run(accountId, closed.from, now);
    const report = reportFor(db, accountId, closed);
    if (!report.totals.length && !report.artists.length) continue;
    const name = accountName(db, accountId) ?? 'Your store';
    svc.notify(accountId, { kind: 'reports', title: `Report ready: ${periodLabel(closed)}`, body: `${report.artists.filter((a) => a.balance > 0).length} artists to pay out.`, link: '/m/consignment?tab=reports', minRole: 'admin' });
    const to = accountEmail(db, accountId);
    if (to && svc.mail.enabled && (await svc.mail.send({ to, ...reportMail(name, report, venueNamer(db, accountId)) }))) sent++;
  }
  return sent;
}

// ── Routes ──────────────────────────────────────────────────────────────────

const WaiveBody = z.object({ note: z.string().max(500).default('') });
const DisputeBody = z.object({ note: z.string().trim().min(1).max(1000) });
const PayBody = z.object({ consignorIds: z.array(z.string().min(1).max(80)).max(500).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export function booksForArtist(db: Database.Database, storeAccountId: string, consignorId: string): { fees: ConsignmentFee[] } {
  return { fees: feesOf(db, storeAccountId, consignorId) };
}

export function registerBooks(app: FastifyInstance, ctx: ModuleContext): void {
  const { db } = ctx;

  // An hourly look for periods that just closed. The work is idempotent, so a
  // second gateway or a restart costs nothing but a query.
  const timer = setInterval(() => void sendClosedReports(ctx).catch(() => undefined), 3600_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));

  app.get('/books/settings', async (req) => ({ settings: booksSettings(db, ctx.identity(req).accountId) }));

  app.put('/books/settings', async (req, reply) => {
    const who = ctx.identity(req);
    const body = BooksSettingsSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Check the settings.' });
    if (!isTimeZone(body.data.timeZone)) return reply.code(400).send({ error: 'invalid_request', message: 'Unknown time zone.' });
    const before = booksSettings(db, who.accountId);
    db.prepare('INSERT INTO consignment_settings (accountId, doc) VALUES (?, ?) ON CONFLICT(accountId) DO UPDATE SET doc = excluded.doc').run(who.accountId, JSON.stringify(body.data));
    // No longer allowing artists' own discounts ends the ones running.
    if (before.artistDiscounts && !body.data.artistDiscounts) endArtistDiscounts(ctx, who.accountId);
    // Switching period or anchor must not email a stack of old periods.
    const current = reportPeriod(body.data, localDay(Date.now(), body.data.timeZone));
    db.prepare('INSERT OR IGNORE INTO consignment_reports_sent (accountId, periodFrom, sentAt) VALUES (?, ?, ?)').run(who.accountId, recentPeriods(body.data, current.from, 2)[1]!.from, Date.now());
    return { settings: body.data };
  });

  // ── Fees ────────────────────────────────────────────────────────────────

  app.get<{ Querystring: { consignorId?: string } }>('/fees', async (req) => ({ fees: feesOf(db, ctx.identity(req).accountId, req.query.consignorId || undefined) }));

  app.post('/fees', async (req, reply) => {
    const who = ctx.identity(req);
    const body = FeeInputSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'A fee needs an artist, a reason, an amount and a date.' });
    const row = consignorRow(db, who.accountId, body.data.consignorId);
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'No such artist.' });
    let setup: SetupMoment | undefined;
    if (body.data.setupId) {
      setup = get<SetupMoment>(db, who.accountId, 'setups', body.data.setupId);
      if (!setup || setup.consignorId !== row.id) return reply.code(404).send({ error: 'not_found', message: 'No such setup moment for this artist.' });
      if (feesOf(db, who.accountId, row.id).some((f) => f.setupId === setup!.id && f.status === 'charged')) {
        return reply.code(409).send({ error: 'already_charged', message: 'That setup already has a fee.' });
      }
    }
    const fee: ConsignmentFee = { ...body.data, storeId: body.data.storeId ?? setup?.storeId ?? null, id: randomUUID(), status: 'charged', waivedAt: null, waiveNote: '', dispute: null, disputedAt: null, createdAt: Date.now() };
    saveFee(db, who.accountId, fee);
    const shop = accountName(db, who.accountId) ?? 'The store';
    const what = `${FEE_REASONS[fee.reason]}${setup ? ` (${setup.date} ${setup.time})` : ''}`;
    const delivery = await tellArtist(ctx, who.accountId, row, { kind: 'fees',
      title: `${shop} charged a fee: ${money(fee.amount, fee.currency)}`,
      body: `${what}${fee.note ? ` - ${fee.note}` : ''}. It comes off your balance.`,
      subject: `${shop} charged a fee of ${money(fee.amount, fee.currency)}`,
      text: [
        `${shop} charged you a fee of ${money(fee.amount, fee.currency)}.`,
        '',
        `Reason: ${what}`,
        ...(fee.note ? [`Note: ${fee.note}`] : []),
        '',
        'It comes off what the store owes you. If you think it is wrong, reply to this email or object to it in Zollify under Consignment → Where I consign.',
      ].join('\n'),
    });
    return reply.code(201).send({ fee, delivery });
  });

  app.post<{ Params: { id: string } }>('/fees/:id/waive', async (req, reply) => {
    const who = ctx.identity(req);
    const fee = feesOf(db, who.accountId).find((f) => f.id === req.params.id);
    if (!fee) return reply.code(404).send({ error: 'not_found' });
    if (fee.status === 'waived') return reply.code(409).send({ error: 'waived', message: 'Already waived.' });
    const body = WaiveBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const done: ConsignmentFee = { ...fee, status: 'waived', waivedAt: Date.now(), waiveNote: body.data.note };
    saveFee(db, who.accountId, done);
    const row = consignorRow(db, who.accountId, fee.consignorId);
    const shop = accountName(db, who.accountId) ?? 'The store';
    const delivery = row
      ? await tellArtist(ctx, who.accountId, row, { kind: 'fees',
          title: `${shop} waived a fee of ${money(fee.amount, fee.currency)}`,
          body: body.data.note || 'It no longer comes off your balance.',
          subject: `${shop} waived a fee of ${money(fee.amount, fee.currency)}`,
          text: [`${shop} waived the fee of ${money(fee.amount, fee.currency)} (${FEE_REASONS[fee.reason]}). It no longer comes off your balance.`, ...(body.data.note ? ['', body.data.note] : [])].join('\n'),
        })
      : null;
    return { fee: done, delivery };
  });

  // ── Reports ─────────────────────────────────────────────────────────────

  app.get('/reports', async (req) => {
    const who = ctx.identity(req);
    const settings = booksSettings(db, who.accountId);
    return { settings, periods: recentPeriods(settings, localDay(Date.now(), settings.timeZone), 12) };
  });

  /** A period, named by its first day - which must be the first day of a period. */
  const periodAt = (accountId: string, from: string): ReportPeriod | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return null;
    const p = reportPeriod(booksSettings(db, accountId), from);
    return p.from === from ? p : null;
  };

  app.get<{ Params: { from: string } }>('/reports/:from', async (req, reply) => {
    const who = ctx.identity(req);
    const period = periodAt(who.accountId, req.params.from);
    if (!period) return reply.code(404).send({ error: 'not_found', message: 'No report period starts that day.' });
    const names = venueNamer(db, who.accountId);
    const report = reportFor(db, who.accountId, period);
    return { report, venues: Object.fromEntries(report.byStore.map((s) => [s.storeId, names(s.storeId)])) };
  });

  app.get<{ Params: { from: string } }>('/reports/:from/csv', async (req, reply) => {
    const who = ctx.identity(req);
    const period = periodAt(who.accountId, req.params.from);
    if (!period) return reply.code(404).send({ error: 'not_found' });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="report-${period.from}.csv"`)
      .send(reportCsv(reportFor(db, who.accountId, period), venueNamer(db, who.accountId)));
  });

  /**
   * Pay out what the period left owing. Each artist gets what they were owed
   * at its end, less anything paid since - so pressing it twice, or after a
   * manual payout, never pays twice.
   */
  app.post<{ Params: { from: string } }>('/reports/:from/payouts', async (req, reply) => {
    const who = ctx.identity(req);
    const period = periodAt(who.accountId, req.params.from);
    if (!period) return reply.code(404).send({ error: 'not_found' });
    const body = PayBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Pick the date the payouts were made.' });
    const report = reportFor(db, who.accountId, period);
    const since = payoutsFor(db, who.accountId).filter((p) => p.date > period.to);
    const insert = db.prepare('INSERT INTO consignment_payouts (accountId, id, consignorId, doc, createdAt) VALUES (?, ?, ?, ?, ?)');
    const made: { consignorId: string; amount: number; currency: string }[] = [];
    for (const a of report.artists) {
      if (body.data.consignorIds && !body.data.consignorIds.includes(a.consignorId)) continue;
      if (!consignorRow(db, who.accountId, a.consignorId)) continue;
      const already = since.filter((p) => p.consignorId === a.consignorId && p.currency === a.currency).reduce((s, p) => s + Math.round(p.amount * 100), 0);
      const amount = (Math.round(a.balance * 100) - already) / 100;
      if (amount <= 0) continue;
      const doc = { consignorId: a.consignorId, storeId: null, amount, currency: a.currency, date: body.data.date, note: `Report ${periodLabel(period)}` };
      insert.run(who.accountId, randomUUID(), a.consignorId, JSON.stringify(doc), Date.now());
      made.push({ consignorId: a.consignorId, amount, currency: a.currency });
    }
    return { payouts: made };
  });

  // ── The artist's side ───────────────────────────────────────────────────

  /** The artist objects to a fee; the owner hears about it. */
  app.post<{ Params: { storeAccountId: string; consignorId: string; id: string } }>('/links/:storeAccountId/:consignorId/fees/:id/dispute', async (req, reply) => {
    const row = consignorRow(db, req.params.storeAccountId, req.params.consignorId);
    if (!row || row.linkedAccountId !== ctx.identity(req).accountId || !isEnabled(db, row.accountId, MODULE_ID)) return reply.code(404).send({ error: 'not_found' });
    const fee = feesOf(db, row.accountId, row.id).find((f) => f.id === req.params.id);
    if (!fee) return reply.code(404).send({ error: 'not_found' });
    if (fee.status === 'waived') return reply.code(409).send({ error: 'waived', message: 'The store already waived this fee.' });
    const body = DisputeBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Say why you think the fee is wrong.' });
    const done: ConsignmentFee = { ...fee, dispute: body.data.note, disputedAt: Date.now() };
    saveFee(db, row.accountId, done);
    const name = parseDoc(row.doc).name;
    ctx.notify(row.accountId, { kind: 'fees', title: `${name} objects to a fee of ${money(fee.amount, fee.currency)}`, body: body.data.note, link: '/m/consignment?tab=statement', minRole: 'admin' });
    const to = accountEmail(db, row.accountId);
    if (to && ctx.mail.enabled) {
      const replyTo = accountEmail(db, ctx.identity(req).accountId) ?? undefined;
      await ctx.mail.send({
        to,
        subject: `${name} objects to a fee of ${money(fee.amount, fee.currency)}`,
        text: [`${name} objects to the fee of ${money(fee.amount, fee.currency)} (${FEE_REASONS[fee.reason]}, ${fee.date}):`, '', body.data.note, '', 'You can waive it in Zollify under Consignment → Statement.'].join('\n'),
        ...(replyTo ? { replyTo } : {}),
      });
    }
    return { fee: done };
  });
}
