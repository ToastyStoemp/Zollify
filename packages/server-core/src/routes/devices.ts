import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { DeviceSummary } from '@zollify/shared';
import type { JwtClaims } from '../auth';

/**
 * The account's known devices (name, flavor, lastSeenAt) — backs pickers
 * like "which Carbon terminal to target" for the remote payment trigger.
 * Scoped to the caller's own account; any logged-in member can list these
 * (unlike /api/admin/*, which is owner-only across every account).
 */
export function registerDeviceRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/devices', { preHandler: app.authenticate }, async (req): Promise<DeviceSummary[]> => {
    const claims = req.user as JwtClaims;
    return db
      .prepare('SELECT id, name, flavor, lastSeenAt FROM devices WHERE accountId = ? ORDER BY lastSeenAt DESC')
      .all(claims.accountId) as DeviceSummary[];
  });
}
