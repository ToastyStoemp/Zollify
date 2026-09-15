import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import type { AdminAccount, AdminAccountDetail, AdminMetricRow, AdminOverview } from '@zollify/shared';
import type { JwtClaims } from '../auth';
import { geoEnabled } from '../session-info';
import { resolveCommit } from '../version';

/** Owner-only usage/health endpoints backing the /admin panel in the app. */
export function registerAdminRoutes(app: FastifyInstance, db: Database.Database, deployDir?: string, dataDir = '.'): void {
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
    COALESCE((SELECT MAX(d.lastSeenAt) FROM devices d WHERE d.accountId = a.id), 0) AS lastSeenAt`;

  type AccountRow = Omit<AdminAccount, 'lastActivityAt'> & { lastOpAt: number; lastSeenAt: number };
  const toAccount = ({ lastOpAt, lastSeenAt, ...rest }: AccountRow): AdminAccount => ({
    ...rest,
    lastActivityAt: Math.max(lastOpAt, lastSeenAt),
  });

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
