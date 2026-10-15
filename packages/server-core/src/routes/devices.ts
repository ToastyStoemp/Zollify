import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { DeviceSummary } from '@zollify/shared';
import type { JwtClaims } from '../auth';

/**
 * The account's known devices - backs pickers like "which Carbon terminal
 * to target" for the remote payment trigger, and the list under Device
 * settings. Scoped to the caller's own account; any logged-in member can
 * list these (unlike /api/admin/*, which is owner-only across every account).
 *
 * A device's id lives in the app's own storage, so a reinstall or a cleared
 * browser comes back as a new one and the old row lingers. Removing a row
 * also signs the device out: its refresh tokens go, and the access tokens
 * it still holds are refused from now on (see checkClaims). Signing in
 * again from it is allowed - that simply makes it a device on the account
 * again, with a fresh sign-in.
 */
export function registerDeviceRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/devices', { preHandler: app.authenticate }, async (req): Promise<DeviceSummary[]> => {
    const claims = req.user as JwtClaims;
    return db
      .prepare(
        `SELECT d.id, d.name, d.flavor, d.device, d.userId, u.email AS userEmail, d.lastSeenAt, d.createdAt,
                (SELECT COUNT(*) FROM refresh_tokens r WHERE r.deviceId = d.id AND r.expiresAt > ? AND r.rotatedAt IS NULL
                   AND r.userId IN (SELECT id FROM users WHERE accountId = d.accountId)) AS sessions
         FROM devices d LEFT JOIN users u ON u.id = d.userId
         WHERE d.accountId = ? ORDER BY d.lastSeenAt DESC`,
      )
      .all(Date.now(), claims.accountId) as DeviceSummary[];
  });

  /** Remove a device from the account and sign it out. Admins may remove any; a member only one they signed in. */
  app.delete<{ Params: { id: string } }>('/api/devices/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const { id } = req.params;
    const row = db.prepare('SELECT userId FROM devices WHERE accountId = ? AND id = ?').get(claims.accountId, id) as { userId: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Device not found' });
    if (claims.role === 'member' && row.userId !== claims.sub) return reply.code(403).send({ error: 'Only an admin can remove a device someone else signed in.' });
    if (id === claims.dev) return reply.code(409).send({ error: 'This is the device you are on - sign out instead.' });
    const now = Date.now();
    const revoked = db.transaction(() => {
      const sessions = db
        .prepare('DELETE FROM refresh_tokens WHERE deviceId = ? AND userId IN (SELECT id FROM users WHERE accountId = ?)')
        .run(id, claims.accountId).changes;
      db.prepare('DELETE FROM trusted_devices WHERE deviceId = ? AND userId IN (SELECT id FROM users WHERE accountId = ?)').run(id, claims.accountId);
      db.prepare('DELETE FROM device_users WHERE accountId = ? AND deviceId = ?').run(claims.accountId, id);
      db.prepare('DELETE FROM devices WHERE accountId = ? AND id = ?').run(claims.accountId, id);
      db.prepare('INSERT INTO device_revocations (accountId, deviceId, revokedAt) VALUES (?, ?, ?) ON CONFLICT (accountId, deviceId) DO UPDATE SET revokedAt = excluded.revokedAt').run(claims.accountId, id, now);
      return sessions;
    })();
    return { ok: true, sessionsRevoked: revoked };
  });
}
