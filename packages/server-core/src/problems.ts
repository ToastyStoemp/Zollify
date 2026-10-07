import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { JwtClaims } from './auth';
import type { Mailer } from './mailer';
import type { Notify } from './notifications';

/**
 * Problems: what quietly failed, per account, in one place.
 *
 * A webhook that keeps failing, an email that did not go out, a scheduled job
 * that threw: before this each was a log line or a counter nobody read. A
 * source reports a failure (`report`) and its success (`resolve`); repeats of
 * the same kind and key update one row instead of adding rows, and a success
 * closes it by itself. Owners and admins see the open ones under Settings →
 * Problems, hear about a new error under the bell, and get at most one email
 * digest a day.
 *
 * A row never holds a secret, a payload, a name or an address: a source name
 * and a sanitised reason only (an HTTP status, an error class). `sanitizeText`
 * enforces that again on whatever a caller passes.
 */

export type Severity = 'warning' | 'error';
type Role = 'owner' | 'admin' | 'member';

export interface ProblemInput {
  /** What failed, e.g. `webhook`, `email`, `job.consignment-report`. */
  kind: string;
  /** Which one of them, e.g. a webhook id. The same kind and key is one problem. */
  key?: string;
  severity?: Severity;
  /** Short and plain, for the person who has to act. */
  message: string;
  /** A sanitised reason (HTTP status, error class). Never a payload. */
  detail?: string;
  /** In-app path of the screen that fixes it. */
  link?: string;
  /** False when the caller already told the bell itself (the webhook switch-off note). */
  notify?: boolean;
  /** Open the problem only on the Nth failure in a row (resolved by a success). */
  after?: number;
}

export interface Problem {
  id: string;
  kind: string;
  key: string;
  severity: Severity;
  message: string;
  detail: string;
  link: string | null;
  count: number;
  firstSeen: number;
  lastSeen: number;
  resolvedAt: number | null;
  dismissedAt: number | null;
}

/** What a module's context offers; the account is always named, like `notify`. */
export interface ModuleProblems {
  report(accountId: string, input: ProblemInput): void;
  resolve(accountId: string, kind: string, key?: string): void;
}

export interface Problems extends ModuleProblems {
  list(accountId: string, opts?: { open?: boolean }): Problem[];
  /** Closes a problem by hand. It reopens as a fresh one if the source fails again. */
  dismiss(accountId: string, id: string): boolean;
  /** Deletes resolved problems older than the retention. Returns how many. */
  prune(now?: number): number;
  /** Emails each owner the new error-level problems, at most once a day. Returns how many digests went out. */
  sendDigests(now?: number): Promise<number>;
  stop(): void;
}

// ── Thresholds ──────────────────────────────────────────────────────────────

export const DAY_MS = 86_400_000;
/** Resolved and dismissed problems are kept this long, then deleted. */
export const RETENTION_MS = 30 * DAY_MS;
/** A problem tells the bell at most this often. */
export const NOTIFY_EVERY_MS = DAY_MS;
/** The email digest goes out at most this often per account. */
export const DIGEST_EVERY_MS = DAY_MS;
/** Consecutive failed deliveries before a webhook shows as a warning (it is an error once it switches itself off). */
export const WEBHOOK_WARN_AFTER = 3;
/** Consecutive pushes that lost ops, or crashed a module, from one device before it shows. */
export const SYNC_WARN_AFTER = 3;

// ── Pure decisions ──────────────────────────────────────────────────────────

const RANK: Record<Severity, number> = { warning: 0, error: 1 };

export interface OpenState {
  severity: Severity;
}

export interface Decision {
  action: 'insert' | 'update';
  /** The severity the row ends up with: it never drops while the problem is open. */
  severity: Severity;
  escalated: boolean;
  /** Whether the bell hears about it. */
  notify: boolean;
}

/**
 * What a report does, given the open problem of the same kind and key (if
 * any) and when that source last told the bell. Only a NEW error, or a
 * warning that escalates to an error, rings, and never twice in a day.
 */
export function decideReport(existing: OpenState | null, incoming: Severity, lastNotifiedAt: number | null, now: number): Decision {
  const severity = existing && RANK[existing.severity] > RANK[incoming] ? existing.severity : incoming;
  const escalated = !!existing && existing.severity === 'warning' && severity === 'error';
  const fresh = !existing;
  const quiet = lastNotifiedAt != null && now - lastNotifiedAt < NOTIFY_EVERY_MS;
  return { action: existing ? 'update' : 'insert', severity, escalated, notify: severity === 'error' && (fresh || escalated) && !quiet };
}

/** The failure streak after one more attempt. */
export const nextStreak = (streak: number, ok: boolean): number => (ok ? 0 : streak + 1);
/** Whether a streak is long enough to open a problem. */
export const streakOpens = (streak: number, after: number | undefined): boolean => streak >= Math.max(1, after ?? 1);
/** Whether a resolved problem is old enough to delete. */
export const expired = (resolvedAt: number | null, now: number): boolean => resolvedAt != null && now - resolvedAt > RETENTION_MS;
/** Whether an account is due its digest. */
export const digestDue = (lastDigestAt: number | null, now: number): boolean => lastDigestAt == null || now - lastDigestAt >= DIGEST_EVERY_MS;

/**
 * Text that is safe to keep: links, addresses and anything shaped like a
 * token or key are replaced, whitespace is flattened, and it is cut short.
 * A caller should not pass such things; this is the net under it.
 */
export function sanitizeText(s: string, max: number): string {
  return s
    .replace(/\b(?:bearer|basic)\s+\S+/gi, '[secret]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]')
    .replace(/[^\s@<>()"']+@[^\s@<>()"']+/g, '[email]')
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, '[secret]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** A same-app path only, as notifications allow. */
const safeLink = (link: string | undefined): string | null =>
  link && /^\/(?!\/)[\w\-./?=&%]*$/.test(link) && link.length <= 300 ? link : null;

/**
 * A reason from an HTTP status or an error, with nothing the remote side
 * wrote: the status, or a coarse class of failure.
 */
export function reasonOf(status: number | null | undefined, err?: unknown): string {
  if (status) return `HTTP ${status}`;
  const text = err instanceof Error ? `${(err as { code?: string }).code ?? ''} ${err.message}` : String(err ?? '');
  if (/time(d)? ?out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(text)) return 'Timed out';
  if (/private network|EPRIVATE/i.test(text)) return 'Address not allowed';
  if (/ENOTFOUND|EAI_AGAIN|does not resolve/i.test(text)) return 'Address did not resolve';
  if (/ECONNREFUSED|ECONNRESET|EPIPE|socket/i.test(text)) return 'Connection refused or dropped';
  if (/cert|tls|ssl/i.test(text)) return 'TLS error';
  const cls = err instanceof Error ? err.name : '';
  return cls && cls !== 'Error' ? sanitizeText(cls, 40) : 'Failed';
}

// ── Storage ─────────────────────────────────────────────────────────────────

export function migrateProblems(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS problems (
      id          TEXT PRIMARY KEY,
      accountId   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      key         TEXT NOT NULL DEFAULT '',
      severity    TEXT NOT NULL CHECK (severity IN ('warning','error')),
      message     TEXT NOT NULL,
      detail      TEXT NOT NULL DEFAULT '',
      link        TEXT,
      count       INTEGER NOT NULL DEFAULT 1,
      firstSeen   INTEGER NOT NULL,
      lastSeen    INTEGER NOT NULL,
      resolvedAt  INTEGER,
      dismissedAt INTEGER,
      notifiedAt  INTEGER,
      digestedAt  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_problems_source ON problems(accountId, kind, key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_problems_open ON problems(accountId, kind, key) WHERE resolvedAt IS NULL;
    CREATE TABLE IF NOT EXISTS problem_settings (
      accountId   TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      emailDigest INTEGER NOT NULL DEFAULT 1,
      digestAt    INTEGER
    );
  `);
}

const COLUMNS = 'id, kind, key, severity, message, detail, link, count, firstSeen, lastSeen, resolvedAt, dismissedAt';

export function createProblems(
  db: Database.Database,
  deps: { notify: Notify; mail: () => Mailer; log?: (err: unknown) => void },
): Problems {
  /** Consecutive failures per source, for reports that wait for `after`. Lost on restart, which only delays a warning. */
  const streaks = new Map<string, number>();
  const streakKey = (accountId: string, kind: string, key: string) => `${accountId}|${kind}|${key}`;

  function report(accountId: string, input: ProblemInput): void {
    try {
      const kind = sanitizeText(input.kind, 80);
      const key = input.key ? input.key.slice(0, 200) : '';
      if (!kind) return;
      if (input.after && input.after > 1) {
        const sk = streakKey(accountId, kind, key);
        if (streaks.size > 5000) streaks.clear();
        const streak = nextStreak(streaks.get(sk) ?? 0, false);
        streaks.set(sk, streak);
        if (!streakOpens(streak, input.after)) return;
      }
      const now = Date.now();
      const message = sanitizeText(input.message, 200);
      const detail = sanitizeText(input.detail ?? '', 160);
      const link = safeLink(input.link);
      const incoming: Severity = input.severity === 'error' ? 'error' : 'warning';

      const decision = db.transaction((): Decision & { id: string } => {
        const open = db.prepare('SELECT id, severity FROM problems WHERE accountId = ? AND kind = ? AND key = ? AND resolvedAt IS NULL').get(accountId, kind, key) as { id: string; severity: Severity } | undefined;
        const told = (db.prepare('SELECT MAX(notifiedAt) AS t FROM problems WHERE accountId = ? AND kind = ? AND key = ?').get(accountId, kind, key) as { t: number | null }).t;
        const d = decideReport(open ?? null, incoming, told, now);
        if (open) {
          db.prepare('UPDATE problems SET severity = ?, message = ?, detail = ?, link = ?, count = count + 1, lastSeen = ?, notifiedAt = CASE WHEN ? THEN ? ELSE notifiedAt END WHERE id = ?').run(d.severity, message, detail, link, now, d.notify ? 1 : 0, now, open.id);
          return { ...d, id: open.id };
        }
        const id = randomUUID();
        db.prepare('INSERT INTO problems (id, accountId, kind, key, severity, message, detail, link, count, firstSeen, lastSeen, notifiedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)').run(id, accountId, kind, key, d.severity, message, detail, link, now, now, d.notify ? now : null);
        return { ...d, id };
      })();

      if (decision.notify && input.notify !== false) {
        deps.notify(accountId, {
          title: `Needs attention: ${message}`.slice(0, 160),
          body: detail ? `${detail}. Open Settings, Problems for details.` : 'Open Settings, Problems for details.',
          link: '/settings?panel=core.problems',
          kind: 'problems',
          level: 'urgent',
          minRole: 'admin',
          groupKey: `problem:${kind}:${key}`,
        });
      }
    } catch (err) {
      // Reporting a problem must never be one.
      deps.log?.(err);
    }
  }

  function resolve(accountId: string, kind: string, key = ''): void {
    try {
      streaks.delete(streakKey(accountId, kind, key));
      db.prepare('UPDATE problems SET resolvedAt = ? WHERE accountId = ? AND kind = ? AND key = ? AND resolvedAt IS NULL').run(Date.now(), accountId, kind, key);
    } catch (err) {
      deps.log?.(err);
    }
  }

  function list(accountId: string, opts: { open?: boolean } = {}): Problem[] {
    return db
      .prepare(`SELECT ${COLUMNS} FROM problems WHERE accountId = ? ${opts.open ? 'AND resolvedAt IS NULL' : ''} ORDER BY resolvedAt IS NOT NULL, severity = 'warning', lastSeen DESC LIMIT 200`)
      .all(accountId) as Problem[];
  }

  function dismiss(accountId: string, id: string): boolean {
    const now = Date.now();
    return db.prepare('UPDATE problems SET resolvedAt = ?, dismissedAt = ? WHERE id = ? AND accountId = ? AND resolvedAt IS NULL').run(now, now, id, accountId).changes > 0;
  }

  function prune(now = Date.now()): number {
    return db.prepare('DELETE FROM problems WHERE resolvedAt IS NOT NULL AND resolvedAt < ?').run(now - RETENTION_MS).changes;
  }

  async function sendDigests(now = Date.now()): Promise<number> {
    const mail = deps.mail();
    if (!mail.enabled) return 0;
    const accounts = db.prepare("SELECT DISTINCT accountId FROM problems WHERE severity = 'error' AND resolvedAt IS NULL AND digestedAt IS NULL").all() as { accountId: string }[];
    let sent = 0;
    for (const { accountId } of accounts) {
      const settings = db.prepare('SELECT emailDigest, digestAt FROM problem_settings WHERE accountId = ?').get(accountId) as { emailDigest: number; digestAt: number | null } | undefined;
      if (settings && !settings.emailDigest) continue;
      if (!digestDue(settings?.digestAt ?? null, now)) continue;
      const rows = db.prepare("SELECT id, message, detail, count FROM problems WHERE accountId = ? AND severity = 'error' AND resolvedAt IS NULL AND digestedAt IS NULL ORDER BY firstSeen").all(accountId) as { id: string; message: string; detail: string; count: number }[];
      const owners = db.prepare("SELECT email FROM users WHERE accountId = ? AND role = 'owner'").all(accountId) as { email: string }[];
      if (!rows.length || !owners.length) continue;
      db.prepare('INSERT INTO problem_settings (accountId, digestAt) VALUES (?, ?) ON CONFLICT(accountId) DO UPDATE SET digestAt = excluded.digestAt').run(accountId, now);
      const text = [
        `Zollify found ${rows.length === 1 ? 'a problem' : `${rows.length} problems`} that need${rows.length === 1 ? 's' : ''} attention:`,
        '',
        ...rows.map((r) => `- ${r.message}${r.detail ? ` (${r.detail})` : ''}${r.count > 1 ? `, ${r.count} times` : ''}`),
        '',
        'Open Zollify, Settings, Problems to see them and dismiss what is done.',
        'You get at most one of these emails a day. Switch it off under Settings, Problems.',
      ].join('\n');
      let ok = false;
      for (const o of owners) ok = (await mail.send({ to: o.email, subject: rows.length === 1 ? 'Zollify: a problem needs attention' : `Zollify: ${rows.length} problems need attention`, text, accountId })) || ok;
      // Only what was actually mailed counts as told; the rest goes in tomorrow's.
      if (ok) {
        const mark = db.prepare('UPDATE problems SET digestedAt = ? WHERE id = ?');
        db.transaction(() => rows.forEach((r) => mark.run(now, r.id)))();
        sent++;
      }
    }
    return sent;
  }

  // Hourly housekeeping: retention, and the digest for whatever opened since.
  const timer = setInterval(() => {
    try {
      prune();
    } catch (err) {
      deps.log?.(err);
    }
    void sendDigests().catch((err) => deps.log?.(err));
  }, 3600_000);
  timer.unref();

  return { report, resolve, list, dismiss, prune, sendDigests, stop: () => clearInterval(timer) };
}

// ── Routes ──────────────────────────────────────────────────────────────────

/** Owners and admins see and dismiss the account's problems; staff never do. The digest switch is the owner's. */
export function registerProblemRoutes(app: FastifyInstance, db: Database.Database, problems: Problems): void {
  const need = (min: Role) => async (req: Parameters<typeof app.authenticate>[0], reply: Parameters<typeof app.authenticate>[1]) => {
    const role = (req.user as JwtClaims).role;
    if (role === 'member' || (min === 'owner' && role !== 'owner')) return reply.code(403).send({ error: 'forbidden', message: min === 'owner' ? 'Only the owner changes this.' : 'Only owners and admins see problems.' });
    return undefined;
  };
  const admin = { preHandler: [app.authenticate, need('admin')] };
  const owner = { preHandler: [app.authenticate, need('owner')] };
  const digestOn = (accountId: string): boolean => {
    const row = db.prepare('SELECT emailDigest FROM problem_settings WHERE accountId = ?').get(accountId) as { emailDigest: number } | undefined;
    return row ? !!row.emailDigest : true;
  };

  app.get('/api/problems', admin, async (req) => {
    const accountId = (req.user as JwtClaims).accountId;
    const rows = problems.list(accountId);
    const open = rows.filter((p) => p.resolvedAt == null);
    return { problems: rows, openErrors: open.filter((p) => p.severity === 'error').length, openWarnings: open.filter((p) => p.severity === 'warning').length, emailDigest: digestOn(accountId) };
  });

  app.post<{ Params: { id: string } }>('/api/problems/:id/dismiss', admin, async (req, reply) => {
    if (!problems.dismiss((req.user as JwtClaims).accountId, req.params.id)) return reply.code(404).send({ error: 'No such open problem.' });
    return { ok: true };
  });

  app.put('/api/problems/settings', owner, async (req, reply) => {
    const on = (req.body as { emailDigest?: unknown } | undefined)?.emailDigest;
    if (typeof on !== 'boolean') return reply.code(400).send({ error: 'invalid_request', message: 'emailDigest must be true or false.' });
    db.prepare('INSERT INTO problem_settings (accountId, emailDigest) VALUES (?, ?) ON CONFLICT(accountId) DO UPDATE SET emailDigest = excluded.emailDigest').run((req.user as JwtClaims).accountId, on ? 1 : 0);
    return { emailDigest: on };
  });
}
