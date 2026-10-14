import type Database from 'better-sqlite3';
import { z } from 'zod';
import { EconomicSettingsSchema, dayJournal, isTimeZone, localDay, type DayJournal, type EconomicSettings, type Transaction } from '@zollify/shared';
import { makeSecretBox, reduceMerges, reduceTransactions, type ModuleContext, type ServerModule } from '@zollify/server-core';
import { consignorRows, parseDoc } from './consignment';

/**
 * e-conomic - the server half. Books each closed day of till sales into the
 * store's e-conomic journal as one voucher, for the accountant to post; VAT
 * reporting then happens in e-conomic. The split itself is `dayJournal`.
 *
 * Two tokens reach e-conomic: the app secret token, which is Zollify's own as
 * a registered e-conomic developer (an environment variable), and the
 * agreement grant token, which each store gets by approving the app and is
 * kept encrypted per account.
 *
 * A day is reserved before it is sent, so two clicks never post it twice. If
 * e-conomic does not answer, the day stays "pending": the voucher may or may
 * not have arrived, and only someone looking in e-conomic can say.
 */

export const ECONOMIC_MODULE_ID = 'economic';
const ECONOMIC_API = 'https://restapi.e-conomic.com';
const MAX_RANGE_DAYS = 62;

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS economic_settings (
      accountId TEXT PRIMARY KEY,
      doc       TEXT NOT NULL,
      grantToken TEXT
    );
    CREATE TABLE IF NOT EXISTS economic_bookings (
      accountId     TEXT NOT NULL,
      day           TEXT NOT NULL,
      status        TEXT NOT NULL,
      voucherNumber INTEGER,
      year          TEXT,
      totalMinor    INTEGER NOT NULL,
      note          TEXT,
      createdAt     INTEGER NOT NULL,
      PRIMARY KEY (accountId, day)
    );
  `);
}

interface Booking {
  day: string;
  status: 'pending' | 'booked';
  voucherNumber: number | null;
  year: string | null;
  totalMinor: number;
  note: string | null;
  createdAt: number;
}

class EconomicError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** e-conomic's own words for what went wrong: the message, then the first field error. */
function messageOf(body: unknown, status: number): string {
  const b = body as { message?: string; errors?: Record<string, { errors?: { message?: string }[] }> } | null;
  const field = b?.errors ? Object.values(b.errors).flatMap((e) => e?.errors ?? [])[0]?.message : undefined;
  return [b?.message ?? `e-conomic answered ${status}`, field].filter(Boolean).join(' - ');
}

async function economic(appSecret: string, grant: string, method: 'GET' | 'POST', path: string, json?: unknown): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${ECONOMIC_API}${path}`, {
        method,
        redirect: 'error',
        headers: { 'X-AppSecretToken': appSecret, 'X-AgreementGrantToken': grant, 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // No answer: whether e-conomic acted on it is unknown.
      throw new EconomicError(null, err instanceof Error ? err.message : 'e-conomic did not answer.');
    }
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000));
      continue;
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new EconomicError(res.status, messageOf(data, res.status));
    return data;
  }
}

/** "2026-10-12" → the next day, by the calendar. */
const nextDay = (day: string): string => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const GrantBody = z.object({ token: z.string().trim().min(10).max(200).nullable() });

export function economicServerModule(jwtSecret: string, appSecret = process.env.ZOLLIFY_ECONOMIC_APP_SECRET ?? ''): ServerModule {
  const box = makeSecretBox(jwtSecret, 'zollify-economic-v1');

  return {
    id: ECONOMIC_MODULE_ID,
    minRole: 'admin',
    migrate,
    onAccountDeleted: (db, accountId) => {
      for (const t of ['economic_settings', 'economic_bookings']) db.prepare(`DELETE FROM ${t} WHERE accountId = ?`).run(accountId);
    },

    routes: (ctx: ModuleContext) => async (app) => {
      const { db } = ctx;
      const who = (req: Parameters<ModuleContext['identity']>[0]) => ctx.identity(req).accountId;

      const settingsOf = (accountId: string): EconomicSettings => {
        const row = db.prepare('SELECT doc FROM economic_settings WHERE accountId = ?').get(accountId) as { doc: string } | undefined;
        const parsed = EconomicSettingsSchema.safeParse(row ? JSON.parse(row.doc) : {});
        return parsed.success ? parsed.data : EconomicSettingsSchema.parse({});
      };
      const grantOf = (accountId: string): string | null => {
        const row = db.prepare('SELECT grantToken FROM economic_settings WHERE accountId = ?').get(accountId) as { grantToken: string | null } | undefined;
        return row?.grantToken ? box.decrypt<string>(row.grantToken) : null;
      };
      const bookingsOf = (accountId: string, from: string, to: string): Map<string, Booking> =>
        new Map(
          (db.prepare('SELECT * FROM economic_bookings WHERE accountId = ? AND day >= ? AND day <= ?').all(accountId, from, to) as Booking[]).map((b) => [b.day, b]),
        );
      const salesOf = (accountId: string): Transaction[] => {
        const ops = (
          db.prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN ('tx.create', 'tx.revert', 'product.merge') ORDER BY seq").all(accountId) as {
            opId: string;
            type: string;
            payload: string;
          }[]
        ).map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) as unknown }));
        return reduceTransactions(ops, reduceMerges(ops)) as Transaction[];
      };
      // Renters live in the consignment module; a store without it simply has none.
      const rentersOf = (accountId: string) => {
        try {
          return consignorRows(db, accountId).map((r) => ({ id: r.id, ...parseDoc(r.doc) }));
        } catch {
          return [];
        }
      };
      const journalOf = (accountId: string, day: string): DayJournal => dayJournal(salesOf(accountId), rentersOf(accountId), day, settingsOf(accountId));
      const todayOf = (accountId: string): string => localDay(Date.now(), settingsOf(accountId).timeZone);
      const connection = (accountId: string) => ({ server: Boolean(appSecret), grant: Boolean(grantOf(accountId)) });

      // ── Settings ────────────────────────────────────────────────────────

      app.get('/settings', async (req) => ({ settings: settingsOf(who(req)), ...connection(who(req)) }));

      app.put('/settings', async (req, reply) => {
        const body = EconomicSettingsSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message ?? 'Check the settings.' });
        if (!isTimeZone(body.data.timeZone)) return reply.code(400).send({ error: 'invalid_request', message: 'Unknown time zone.' });
        db.prepare('INSERT INTO economic_settings (accountId, doc) VALUES (?, ?) ON CONFLICT (accountId) DO UPDATE SET doc = excluded.doc').run(who(req), JSON.stringify(body.data));
        return { settings: body.data, ...connection(who(req)) };
      });

      /** The agreement grant token, kept encrypted and never sent back. Null disconnects. */
      app.put('/grant', async (req, reply) => {
        const body = GrantBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Paste the whole agreement grant token.' });
        const sealed = body.data.token ? box.encrypt(body.data.token) : null;
        db.prepare('INSERT INTO economic_settings (accountId, doc, grantToken) VALUES (?, ?, ?) ON CONFLICT (accountId) DO UPDATE SET grantToken = excluded.grantToken').run(
          who(req),
          JSON.stringify(settingsOf(who(req))),
          sealed,
        );
        return connection(who(req));
      });

      app.post('/test', async (req, reply) => {
        const grant = grantOf(who(req));
        if (!appSecret) return reply.code(503).send({ error: 'not_configured', message: 'This server is not registered with e-conomic yet.' });
        if (!grant) return reply.code(400).send({ error: 'no_grant', message: 'Connect your e-conomic agreement first.' });
        try {
          const self = (await economic(appSecret, grant, 'GET', '/self')) as { company?: { name?: string }; agreementNumber?: number };
          return { ok: true, company: self.company?.name ?? null, agreementNumber: self.agreementNumber ?? null };
        } catch (err) {
          return reply.code(502).send({ error: 'economic', message: err instanceof Error ? err.message : 'e-conomic refused.' });
        }
      });

      // ── Days ────────────────────────────────────────────────────────────

      /** Every day in the range with sales, reversals or a booking: what it would book, and whether it was. */
      app.get<{ Querystring: { from?: string; to?: string } }>('/days', async (req, reply) => {
        const accountId = who(req);
        const from = Day.safeParse(req.query.from);
        const to = Day.safeParse(req.query.to);
        if (!from.success || !to.success || from.data > to.data) return reply.code(400).send({ error: 'invalid_request', message: 'Give a from and to day.' });
        if ((Date.parse(to.data) - Date.parse(from.data)) / 86_400_000 >= MAX_RANGE_DAYS) return reply.code(400).send({ error: 'invalid_request', message: `At most ${MAX_RANGE_DAYS} days at a time.` });
        const sales = salesOf(accountId);
        const renters = rentersOf(accountId);
        const settings = settingsOf(accountId);
        const booked = bookingsOf(accountId, from.data, to.data);
        const today = todayOf(accountId);
        const days = [];
        // ponytail: replays every sale per day; index sales by day if a range gets slow.
        for (let day = from.data; day <= to.data; day = nextDay(day)) {
          const j = dayJournal(sales, renters, day, settings);
          const b = booked.get(day) ?? null;
          if (!j.lines.length && !b) continue;
          days.push({ day, total: j.total, currency: j.currency, sales: j.sales, reversals: j.reversals, problems: j.problems, open: day >= today, booking: b });
        }
        return { days: days.reverse() };
      });

      app.get<{ Params: { day: string } }>('/days/:day', async (req, reply) => {
        const day = Day.safeParse(req.params.day);
        if (!day.success) return reply.code(400).send({ error: 'invalid_request' });
        const accountId = who(req);
        return { journal: journalOf(accountId, day.data), booking: bookingsOf(accountId, day.data, day.data).get(day.data) ?? null, open: day.data >= todayOf(accountId) };
      });

      app.post<{ Params: { day: string } }>('/days/:day/book', async (req, reply) => {
        const day = Day.safeParse(req.params.day);
        if (!day.success) return reply.code(400).send({ error: 'invalid_request' });
        const accountId = who(req);
        if (day.data >= todayOf(accountId)) return reply.code(409).send({ error: 'open_day', message: 'Book a day once it is over.' });
        if (!appSecret) return reply.code(503).send({ error: 'not_configured', message: 'This server is not registered with e-conomic yet.' });
        const grant = grantOf(accountId);
        if (!grant) return reply.code(400).send({ error: 'no_grant', message: 'Connect your e-conomic agreement first.' });
        const settings = settingsOf(accountId);
        const journal = journalOf(accountId, day.data);
        if (journal.problems.length) return reply.code(422).send({ error: 'problems', message: journal.problems[0], problems: journal.problems });
        if (!journal.lines.length) return reply.code(409).send({ error: 'empty', message: 'Nothing to book on this day.' });

        const totalMinor = Math.round(journal.total * 100);
        const reserved = db
          .prepare("INSERT INTO economic_bookings (accountId, day, status, totalMinor, createdAt) VALUES (?, ?, 'pending', ?, ?) ON CONFLICT (accountId, day) DO NOTHING")
          .run(accountId, day.data, totalMinor, Date.now());
        if (!reserved.changes) return reply.code(409).send({ error: 'already_booked', message: 'This day was already sent to e-conomic.' });

        try {
          const years = (await economic(appSecret, grant, 'GET', '/accounting-years?pagesize=1000')) as { collection?: { year: string; fromDate: string; toDate: string }[] };
          const year = years.collection?.find((y) => y.fromDate <= day.data && day.data <= y.toDate)?.year;
          if (!year) throw new EconomicError(422, `e-conomic has no accounting year for ${day.data} - create it there first.`);
          // e-conomic: a positive amount debits the account, a negative one credits it.
          const voucher = {
            accountingYear: { year },
            journal: { journalNumber: settings.journalNumber },
            entries: {
              financeVouchers: journal.lines.map((l) => ({
                account: { accountNumber: l.account },
                amount: l.amount,
                currency: { code: journal.currency },
                date: day.data,
                text: l.text,
                ...(l.vatCode ? { vatAccount: { vatCode: l.vatCode } } : {}),
              })),
            },
          };
          const res = (await economic(appSecret, grant, 'POST', `/journals/${settings.journalNumber}/vouchers`, voucher)) as { voucherNumber?: number } | { voucherNumber?: number }[];
          const voucherNumber = (Array.isArray(res) ? res[0] : res)?.voucherNumber ?? null;
          db.prepare("UPDATE economic_bookings SET status = 'booked', voucherNumber = ?, year = ?, note = NULL WHERE accountId = ? AND day = ?").run(voucherNumber, year, accountId, day.data);
          return { booking: bookingsOf(accountId, day.data, day.data).get(day.data) };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'e-conomic refused the voucher.';
          if (err instanceof EconomicError && err.status != null) {
            // A clear refusal: nothing arrived, so the day is free to try again.
            db.prepare('DELETE FROM economic_bookings WHERE accountId = ? AND day = ?').run(accountId, day.data);
            return reply.code(502).send({ error: 'economic', message });
          }
          db.prepare('UPDATE economic_bookings SET note = ? WHERE accountId = ? AND day = ?').run(`No answer from e-conomic: ${message}`, accountId, day.data);
          return reply.code(504).send({ error: 'unknown', message: 'e-conomic did not answer. Check the journal there before booking this day again.' });
        }
      });

      /** Frees a day: a pending one that never arrived, or a voucher the accountant deleted in e-conomic. */
      app.delete<{ Params: { day: string } }>('/days/:day/booking', async (req, reply) => {
        const day = Day.safeParse(req.params.day);
        if (!day.success) return reply.code(400).send({ error: 'invalid_request' });
        db.prepare('DELETE FROM economic_bookings WHERE accountId = ? AND day = ?').run(who(req), day.data);
        return { ok: true };
      });
    },
  };
}
