import type Database from 'better-sqlite3';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ACTION_LABELS,
  TaxDeadlineSettingsSchema,
  dayInZone,
  dueIn,
  isTimeZone,
  leadLabel,
  normalizeLeadDays,
  remindersDue,
  type ReminderDue,
  type TaxDeadlineSettings,
} from '@zollify/shared';
import { isEnabled, reasonOf, reportProblem, resolveProblem, type ModuleContext, type ModuleServices, type ServerModule } from '@zollify/server-core';

/**
 * Tax deadlines - the server half. Keeps each account's tax profile, which
 * deadlines are done, and which reminders went out; an hourly sweep rings the
 * bell (and emails the owner) at the lead times the account picked. The
 * deadlines themselves are worked out by `deadlinesBetween` in
 * @zollify/shared, the same code the app shows them with.
 */

export const TAX_DEADLINES_MODULE_ID = 'tax-deadlines';
const LINK = '/m/tax-deadlines';
/** Reminders go out from this local hour on, not in the middle of the night. */
const SEND_FROM_HOUR = 8;

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tax_deadline_settings (
      accountId TEXT PRIMARY KEY,
      doc       TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tax_deadline_done (
      accountId  TEXT NOT NULL,
      deadlineId TEXT NOT NULL,
      doneAt     INTEGER NOT NULL,
      userId     TEXT NOT NULL,
      PRIMARY KEY (accountId, deadlineId)
    );
    CREATE TABLE IF NOT EXISTS tax_deadline_sent (
      accountId  TEXT NOT NULL,
      deadlineId TEXT NOT NULL,
      lead       INTEGER NOT NULL,
      sentAt     INTEGER NOT NULL,
      PRIMARY KEY (accountId, deadlineId, lead)
    );
  `);
}

export function readSettings(db: Database.Database, accountId: string): TaxDeadlineSettings {
  const row = db.prepare('SELECT doc FROM tax_deadline_settings WHERE accountId = ?').get(accountId) as { doc: string } | undefined;
  let raw: unknown = {};
  try {
    raw = row ? JSON.parse(row.doc) : {};
  } catch {
    raw = {};
  }
  const parsed = TaxDeadlineSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : TaxDeadlineSettingsSchema.parse({});
}

function doneIds(db: Database.Database, accountId: string): Set<string> {
  return new Set((db.prepare('SELECT deadlineId FROM tax_deadline_done WHERE accountId = ?').all(accountId) as { deadlineId: string }[]).map((r) => r.deadlineId));
}

function sentKeys(db: Database.Database, accountId: string): Set<string> {
  return new Set((db.prepare('SELECT deadlineId, lead FROM tax_deadline_sent WHERE accountId = ?').all(accountId) as { deadlineId: string; lead: number }[]).map((r) => `${r.deadlineId}|${r.lead}`));
}

const accountEmail = (db: Database.Database, accountId: string): string | null =>
  (
    db
      .prepare("SELECT email FROM users WHERE accountId = ? AND role IN ('owner','admin') ORDER BY role = 'owner' DESC, createdAt LIMIT 1")
      .get(accountId) as { email: string } | undefined
  )?.email ?? null;

function hourInZone(at: number, timeZone: string): number {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(at)));
  } catch {
    return new Date(at).getUTCHours();
  }
}

const fmtDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function noteTitle(r: ReminderDue, today: string): string {
  const d = r.deadline;
  return r.lead < 0 ? `Overdue: ${d.title}` : `${d.title} due ${dueIn(d.due, today)}`;
}

function reminderMail(rs: ReminderDue[], today: string): { subject: string; text: string } {
  const first = rs[0]!;
  const subject = rs.length === 1 ? noteTitle(first, today) : `${rs.length} tax deadlines coming up`;
  const lines = rs.map((r) => {
    const d = r.deadline;
    return [
      `${r.lead < 0 ? 'OVERDUE - ' : ''}${d.title}`,
      `  ${ACTION_LABELS[d.action]} by ${fmtDay(d.due)} (${dueIn(d.due, today)})${d.where ? ` - ${d.where}` : ''}`,
      d.statutory !== d.due ? `  The law says ${fmtDay(d.statutory)}; that is not a working day, so it moves.` : '',
      d.detail ? `  ${d.detail}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return {
    subject,
    text: `${lines.join('\n\n')}\n\nTick deadlines off in Zollify under Tax deadlines to stop reminders for them.\nWorked out from your tax profile; check your own dates with the tax office or your tax advisor.`,
  };
}

/**
 * Sends what is due today for every account with the module on. Idempotent:
 * a reminder is recorded before it goes out, so a second gateway or a
 * restart sends nothing twice. Returns how many reminders were raised.
 */
export async function sendDeadlineReminders(svc: ModuleServices, now = Date.now()): Promise<number> {
  const { db } = svc;
  let raised = 0;
  const rows = db.prepare('SELECT accountId FROM tax_deadline_settings').all() as { accountId: string }[];
  for (const { accountId } of rows) {
    try {
      if (!isEnabled(db, accountId, TAX_DEADLINES_MODULE_ID)) continue;
      const settings = readSettings(db, accountId);
      if (!settings.configured || !settings.reminders.leadDays.length && !settings.reminders.overdue) continue;
      const tz = settings.reminders.timeZone;
      if (hourInZone(now, tz) < SEND_FROM_HOUR) continue;
      const today = dayInZone(now, tz);
      const due = remindersDue(settings, today, doneIds(db, accountId), sentKeys(db, accountId));
      if (!due.length) continue;
      const mark = db.prepare('INSERT OR IGNORE INTO tax_deadline_sent (accountId, deadlineId, lead, sentAt) VALUES (?, ?, ?, ?)');
      db.transaction(() => {
        for (const r of due) for (const lead of [r.lead, ...r.covers]) mark.run(accountId, r.deadline.id, lead, now);
      })();
      for (const r of due) {
        svc.notify(accountId, {
          kind: 'tax-deadlines',
          title: noteTitle(r, today),
          body: `${ACTION_LABELS[r.deadline.action]} by ${fmtDay(r.deadline.due)}${r.deadline.where ? ` - ${r.deadline.where}` : ''}`,
          link: LINK,
          minRole: 'admin',
          level: r.lead <= 1 ? 'urgent' : 'normal',
          groupKey: `tax-deadline:${r.deadline.id}`,
        });
        raised++;
      }
      const to = accountEmail(db, accountId);
      if (settings.reminders.email && to && svc.mail.enabled) await svc.mail.send({ to, accountId, ...reminderMail(due, today) });
      resolveProblem(svc, accountId, 'job.tax-deadlines');
    } catch (err) {
      reportProblem(svc, accountId, { kind: 'job.tax-deadlines', severity: 'error', message: 'Sending tax deadline reminders failed', detail: reasonOf(null, err), link: LINK });
    }
  }
  return raised;
}

const DoneBody = z.object({ done: z.boolean() });
const DeadlineId = z.string().regex(/^[\w.:-]{1,120}$/);

function routes(ctx: ModuleContext): FastifyPluginAsync {
  return async (app) => {
    const { db } = ctx;

    // Hourly; the work is idempotent, so restarts and a second gateway cost a query.
    const timer = setInterval(() => void sendDeadlineReminders(ctx).catch(() => undefined), 3600_000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));

    const state = (accountId: string) => ({
      settings: readSettings(db, accountId),
      done: (db.prepare('SELECT deadlineId AS id, doneAt FROM tax_deadline_done WHERE accountId = ? ORDER BY doneAt DESC LIMIT 2000').all(accountId) as { id: string; doneAt: number }[]),
    });

    app.get('/state', async (req) => state(ctx.identity(req).accountId));

    app.put('/settings', async (req, reply) => {
      const who = ctx.identity(req);
      const body = TaxDeadlineSettingsSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Check the settings.' });
      if (!isTimeZone(body.data.reminders.timeZone)) return reply.code(400).send({ error: 'invalid_request', message: 'Unknown time zone.' });
      const ids = body.data.custom.map((c) => c.id);
      if (new Set(ids).size !== ids.length) return reply.code(400).send({ error: 'invalid_request', message: 'Two custom deadlines share an id.' });
      const doc: TaxDeadlineSettings = { ...body.data, reminders: { ...body.data.reminders, leadDays: normalizeLeadDays(body.data.reminders.leadDays) }, configured: true };
      db.prepare('INSERT INTO tax_deadline_settings (accountId, doc, updatedAt) VALUES (?, ?, ?) ON CONFLICT(accountId) DO UPDATE SET doc = excluded.doc, updatedAt = excluded.updatedAt').run(who.accountId, JSON.stringify(doc), Date.now());
      return state(who.accountId);
    });

    app.put<{ Params: { id: string } }>('/done/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const id = DeadlineId.safeParse(req.params.id);
      const body = DoneBody.safeParse(req.body);
      if (!id.success || !body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Unknown deadline.' });
      if (body.data.done) db.prepare('INSERT OR REPLACE INTO tax_deadline_done (accountId, deadlineId, doneAt, userId) VALUES (?, ?, ?, ?)').run(who.accountId, id.data, Date.now(), who.userId);
      else db.prepare('DELETE FROM tax_deadline_done WHERE accountId = ? AND deadlineId = ?').run(who.accountId, id.data);
      return state(who.accountId);
    });
  };
}

export const taxDeadlinesServerModule: ServerModule = {
  id: TAX_DEADLINES_MODULE_ID,
  // Taxes are the account holder's business, not a helper's.
  minRole: 'admin',
  migrate,
  routes,
  onAccountDeleted(db, accountId) {
    for (const table of ['tax_deadline_settings', 'tax_deadline_done', 'tax_deadline_sent']) db.prepare(`DELETE FROM ${table} WHERE accountId = ?`).run(accountId);
  },
};
