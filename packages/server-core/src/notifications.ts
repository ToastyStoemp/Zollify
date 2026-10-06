import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { AppNotification, NotificationLevel } from '@zollify/shared';
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
  /**
   * How much it asks for attention. `urgent`: something to answer or act on
   * soon (a setup to confirm). `low`: news that needs nothing (items shared).
   * Without one, the kind decides (see LEVEL_OF_KIND), else `normal`.
   */
  level?: NotificationLevel;
  /**
   * Same news again while the last one is still unread: it replaces that one
   * (moved to the top) instead of adding another. E.g. one per artist and
   * store for sharing, however many times they press share.
   */
  groupKey?: string;
}

/** What a kind asks for when the caller does not say. */
const LEVEL_OF_KIND: Record<string, NotificationLevel> = { sharing: 'low', discounts: 'low', reports: 'normal' };

export type Notify = (accountId: string, n: NotificationInput) => void;

/** A same-app path only: never another origin, never a script URL. */
const safeLink = (link: string | undefined): string | null =>
  link && /^\/(?!\/)[\w\-./?=&%]*$/.test(link) && link.length <= 300 ? link : null;

export function createNotifier(db: Database.Database, rooms: Rooms): Notify {
  const insert = db.prepare(
    'INSERT INTO notifications (id, accountId, moduleId, minRole, title, body, link, createdAt, level, groupKey) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const regroup = db.prepare(
    'UPDATE notifications SET title = ?, body = ?, link = ?, createdAt = ?, level = ? WHERE accountId = ? AND groupKey = ? AND readAt IS NULL',
  );
  // Bounded per account: a bell nobody opens must not grow forever.
  const trim = db.prepare(
    'DELETE FROM notifications WHERE accountId = ? AND id NOT IN (SELECT id FROM notifications WHERE accountId = ? ORDER BY createdAt DESC LIMIT ?)',
  );
  return (accountId, n) => {
    const level = n.level ?? LEVEL_OF_KIND[n.kind ?? ''] ?? 'normal';
    const title = n.title.slice(0, 160);
    const body = (n.body ?? '').slice(0, 1000);
    const groupKey = n.groupKey ? n.groupKey.slice(0, 200) : null;
    const replaced = groupKey ? regroup.run(title, body, safeLink(n.link), Date.now(), level, accountId, groupKey).changes > 0 : false;
    if (!replaced) insert.run(randomUUID(), accountId, n.moduleId ?? null, n.minRole ?? 'member', title, body, safeLink(n.link), Date.now(), level, groupKey);
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
        `SELECT id, moduleId, title, body, link, createdAt, readAt, level FROM notifications
         WHERE accountId = ? AND minRole IN (${roles.map(() => '?').join(',')}) ORDER BY createdAt DESC LIMIT 50`,
      )
      .all(claims.accountId, ...roles) as AppNotification[];
    // Low-level news is listed but never counted on the bell.
    const unread = rows.filter((r) => r.readAt == null && r.level !== 'low');
    return { notifications: rows, unread: unread.length, urgent: unread.filter((r) => r.level === 'urgent').length };
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
