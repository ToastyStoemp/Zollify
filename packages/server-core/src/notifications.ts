import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { AppNotification } from '@zollify/shared';
import type { JwtClaims } from './auth';
import type { Rooms } from './ws';

/**
 * In-app notifications: a short note for an account, raised by the server
 * and shown under the shell's bell. A module raises one through its context
 * (`ctx.notify`), the account's open devices hear a doorbell over the live
 * channel, and fetch over HTTP like everything else.
 *
 * A notification belongs to the account rather than one user, the same way
 * the data does; `minRole` keeps e.g. payout news away from a helper.
 */

type Role = 'owner' | 'admin' | 'member';
const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };
const KEEP = 100;

export interface NotificationInput {
  title: string;
  body?: string;
  /** In-app path. Anything that is not a plain same-app path is dropped. */
  link?: string;
  moduleId?: string;
  minRole?: Role;
  /** Its category, for webhooks that listen for some kinds only (see WEBHOOK_EVENTS). */
  kind?: string;
}

export type Notify = (accountId: string, n: NotificationInput) => void;

/** A same-app path only: never another origin, never a script URL. */
const safeLink = (link: string | undefined): string | null =>
  link && /^\/(?!\/)[\w\-./?=&%]*$/.test(link) && link.length <= 300 ? link : null;

export function createNotifier(db: Database.Database, rooms: Rooms): Notify {
  const insert = db.prepare(
    'INSERT INTO notifications (id, accountId, moduleId, minRole, title, body, link, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // Bounded per account: a bell nobody opens must not grow forever.
  const trim = db.prepare(
    'DELETE FROM notifications WHERE accountId = ? AND id NOT IN (SELECT id FROM notifications WHERE accountId = ? ORDER BY createdAt DESC LIMIT ?)',
  );
  return (accountId, n) => {
    insert.run(
      randomUUID(),
      accountId,
      n.moduleId ?? null,
      n.minRole ?? 'member',
      n.title.slice(0, 160),
      (n.body ?? '').slice(0, 1000),
      safeLink(n.link),
      Date.now(),
    );
    trim.run(accountId, accountId, KEEP);
    rooms.notify(accountId);
  };
}

export function registerNotificationRoutes(app: FastifyInstance, db: Database.Database): void {
  const visible = (role: Role): string[] => (Object.keys(RANK) as Role[]).filter((r) => RANK[r] <= RANK[role]);

  app.get('/api/notifications', { preHandler: app.authenticate }, async (req) => {
    const claims = req.user as JwtClaims;
    const roles = visible(claims.role);
    const rows = db
      .prepare(
        `SELECT id, moduleId, title, body, link, createdAt, readAt FROM notifications
         WHERE accountId = ? AND minRole IN (${roles.map(() => '?').join(',')}) ORDER BY createdAt DESC LIMIT 50`,
      )
      .all(claims.accountId, ...roles) as AppNotification[];
    return { notifications: rows, unread: rows.filter((r) => r.readAt == null).length };
  });

  /** Marks the given notifications read, or all of them when no ids are given. */
  app.post('/api/notifications/read', { preHandler: app.authenticate }, async (req) => {
    const claims = req.user as JwtClaims;
    const ids = (req.body as { ids?: unknown } | undefined)?.ids;
    const now = Date.now();
    if (Array.isArray(ids)) {
      const stmt = db.prepare('UPDATE notifications SET readAt = ? WHERE accountId = ? AND id = ? AND readAt IS NULL');
      db.transaction(() => {
        for (const id of ids.slice(0, 100)) if (typeof id === 'string') stmt.run(now, claims.accountId, id);
      })();
    } else {
      db.prepare('UPDATE notifications SET readAt = ? WHERE accountId = ? AND readAt IS NULL').run(now, claims.accountId);
    }
    return { ok: true };
  });
}
