import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import type { AdminAccount, AdminAccountDetail, AdminAccountRelation, AdminMetricRow, AdminOverview } from '@zollify/shared';
import type { JwtClaims } from '../auth';
import type { ServerModule } from '../modules/mount';
import { geoEnabled } from '../session-info';
import { resolveCommit } from '../version';

/** Owner-only usage/health endpoints backing the /admin panel in the app. */
export function registerAdminRoutes(app: FastifyInstance, db: Database.Database, deployDir?: string, dataDir = '.', modules: Pick<ServerModule, 'id' | 'accountRelations'>[] = []): void {
  const commit = resolveCommit(dataDir);
  const requireOwner = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if ((req.user as JwtClaims).role !== 'owner') {
      reply.code(403).send({ error: 'Owner only' });
    }
  };
  const guard = { preHandler: [app.authenticate, requireOwner] };

  const accountColumns = `
    a.id, a.name, a.createdAt,
    (SELECT COUNT(*) FROM users u WHERE u.accountId = a.id)   AS userCount,
    (SELECT COUNT(*) FROM devices d WHERE d.accountId = a.id) AS deviceCount,
    (SELECT COUNT(*) FROM ops o WHERE o.accountId = a.id)     AS opCount,
    (SELECT COALESCE(SUM(m.txCount), 0) FROM metrics m WHERE m.accountId = a.id) AS txTotal,
    COALESCE((SELECT MAX(o.receivedAt) FROM ops o WHERE o.accountId = a.id), 0) AS lastOpAt,
    COALESCE((SELECT MAX(d.lastSeenAt) FROM devices d WHERE d.accountId = a.id), 0) AS lastSeenAt,
    EXISTS(SELECT 1 FROM users u WHERE u.accountId = a.id AND u.role = 'owner') AS ownsServer,
    (SELECT u.email FROM users u WHERE u.accountId = a.id AND u.role IN ('owner','admin') ORDER BY u.createdAt LIMIT 1) AS adminEmail`;

  type AccountRow = Omit<AdminAccount, 'lastActivityAt' | 'ownsServer'> & { lastOpAt: number; lastSeenAt: number; ownsServer: number };
  const toAccount = ({ lastOpAt, lastSeenAt, ownsServer, ...rest }: AccountRow): AdminAccount => ({
    ...rest,
    ownsServer: !!ownsServer,
    lastActivityAt: Math.max(lastOpAt, lastSeenAt),
  });

  /**
   * How accounts are tied to one another: the invite that made an account
   * (from the inviter's account to the new one), and whatever the modules
   * keep between accounts - a store and the artists consigning to it.
   */
  const accountRelations = (): AdminAccountRelation[] => {
    const names = new Map((db.prepare('SELECT id, name FROM accounts').all() as { id: string; name: string }[]).map((a) => [a.id, a.name]));
    const named = (id: string) => ({ id, name: names.get(id) ?? 'Deleted account' });
    const invited = db
      .prepare(
        `SELECT c.accountId AS fromId, n.accountId AS toId, n.email AS label, i.createdAt AS since
         FROM invites i JOIN users c ON c.id = i.createdBy JOIN users n ON n.id = i.usedBy
         WHERE i.accountId IS NULL AND i.usedBy IS NOT NULL AND c.accountId != n.accountId`,
      )
      .all() as { fromId: string; toId: string; label: string; since: number }[];
    const out: AdminAccountRelation[] = invited.map((r) => ({ from: named(r.fromId), to: named(r.toId), kind: 'invited', label: r.label, since: r.since }));
    for (const m of modules) {
      if (!m.accountRelations) continue;
      try {
        for (const r of m.accountRelations(db)) out.push({ from: named(r.from), to: named(r.to), kind: r.kind, label: r.label, since: r.since });
      } catch (err) {
        app.log.warn({ err, moduleId: m.id }, 'accountRelations failed');
      }
    }
    return out.sort((a, b) => a.from.name.localeCompare(b.from.name) || a.kind.localeCompare(b.kind) || a.to.name.localeCompare(b.to.name));
  };

  /**
   * "Update server": the container cannot run Docker, so it leaves a flag in
   * a directory the host bind-mounts, and a systemd path unit there runs
   * deploy.sh --auto (see apps/server/systemd/). 503 when nobody is watching.
   */
  app.post('/api/admin/deploy', guard, async (_req, reply) => {
    if (!deployDir) return reply.code(503).send({ error: 'Deploys are not wired on this server.' });
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    try {
      mkdirSync(deployDir, { recursive: true });
      writeFileSync(join(deployDir, 'requested'), new Date().toISOString());
    } catch (err) {
      return reply.code(503).send({ error: `Could not request a deploy: ${(err as Error).message}` });
    }
    return { ok: true };
  });

  app.get('/api/admin/overview', guard, async (): Promise<AdminOverview> => {
    const row = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM accounts) AS accounts,
           (SELECT COUNT(*) FROM users)    AS users,
           (SELECT COUNT(*) FROM devices)  AS devices,
           (SELECT COUNT(*) FROM ops)      AS ops,
           (SELECT COALESCE(SUM(txCount), 0) FROM metrics) AS transactions,
           (SELECT COUNT(DISTINCT accountId) FROM metrics WHERE day = date('now')) AS activeToday`,
      )
      .get() as AdminOverview;
    return { ...row, commit };
  });

  app.get('/api/admin/accounts', guard, async (): Promise<AdminAccount[]> => {
    const rows = db.prepare(`SELECT ${accountColumns} FROM accounts a ORDER BY a.createdAt`).all() as AccountRow[];
    return rows.map(toAccount);
  });

  app.get('/api/admin/relations', guard, async (): Promise<{ relations: AdminAccountRelation[] }> => ({ relations: accountRelations() }));

  app.get('/api/admin/accounts/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare(`SELECT ${accountColumns} FROM accounts a WHERE a.id = ?`).get(id) as
      | AccountRow
      | undefined;
    if (!row) return reply.code(404).send({ error: 'No such account' });

    const users = db
      .prepare('SELECT id, email, role, createdAt, lastLoginAt FROM users WHERE accountId = ? ORDER BY createdAt')
      .all(id) as AdminAccountDetail['users'];
    const devices = db
      .prepare('SELECT id, name, createdAt, lastSeenAt FROM devices WHERE accountId = ? ORDER BY lastSeenAt DESC')
      .all(id) as AdminAccountDetail['devices'];
    const detail: AdminAccountDetail = { account: toAccount(row), users, devices };
    return detail;
  });

  app.get('/api/admin/metrics', guard, async (req): Promise<AdminMetricRow[]> => {
    const days = Math.min(Math.max(Number((req.query as { days?: string }).days ?? 30) || 30, 1), 365);
    return db
      .prepare(
        `SELECT m.accountId, a.name AS accountName, m.day, m.logins, m.syncPushes, m.opsReceived, m.txCount
         FROM metrics m JOIN accounts a ON a.id = m.accountId
         WHERE m.day >= date('now', ?)
         ORDER BY m.day, a.name`,
      )
      .all(`-${days} days`) as AdminMetricRow[];
  });

  // All active login sessions across accounts, with device + geo, and remote
  // log-out. A refresh token IS a session (rotating; sliding TTL).
  app.get('/api/admin/sessions', guard, async () => {
    const sessions = db
      .prepare(
        `SELECT r.id, r.userId, u.email, u.role, a.name AS accountName,
                r.deviceId, r.deviceName, r.device, r.ip, r.geo, r.flavor, r.createdAt, r.lastUsedAt
         FROM refresh_tokens r JOIN users u ON u.id = r.userId JOIN accounts a ON a.id = u.accountId
         WHERE r.expiresAt > ? ORDER BY r.lastUsedAt DESC`,
      )
      .all(Date.now());
    return { geo: geoEnabled(), sessions };
  });

  app.delete('/api/admin/sessions/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const info = db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(id);
    if (!info.changes) return reply.code(404).send({ error: 'Session not found' });
    return { ok: true };
  });
}
