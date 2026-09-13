import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { ProfileUpdateSchema, type AccountProfile } from '@zollify/shared';
import { parseProfile, toAuthUser, type JwtClaims, type UserRow } from '../auth';

/**
 * The account profile: who the booth is, and whether first-run setup has been
 * done. Held on the server rather than synced as ops because it is one record
 * per account with no offline write path worth building — the wizard runs on
 * a signed-in device, and every other device reads it at its next login.
 */
export function registerAccountRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/account/profile', { preHandler: app.authenticate }, async (req): Promise<AccountProfile> => {
    const claims = req.user as JwtClaims;
    const row = db.prepare('SELECT profile FROM accounts WHERE id = ?').get(claims.accountId) as
      | { profile: string | null }
      | undefined;
    return parseProfile(row?.profile);
  });

  app.put('/api/account/profile', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    if (claims.role === 'member') {
      return reply.code(403).send({ error: 'forbidden', message: 'Only an admin can change the booth profile.' });
    }
    const parsed = ProfileUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', message: 'That profile is not valid.' });
    const body = parsed.data;

    if (body.name !== undefined && claims.role !== 'owner') {
      return reply.code(403).send({ error: 'forbidden', message: 'Only the owner can rename the account.' });
    }

    const row = db.prepare('SELECT profile FROM accounts WHERE id = ?').get(claims.accountId) as
      | { profile: string | null }
      | undefined;
    const current = parseProfile(row?.profile);
    const next: AccountProfile = {
      setupCompletedAt: body.setupCompleted ? (current.setupCompletedAt ?? Date.now()) : current.setupCompletedAt,
      artist: { ...current.artist, ...(body.artist ?? {}) },
    };

    db.transaction(() => {
      db.prepare('UPDATE accounts SET profile = ? WHERE id = ?').run(JSON.stringify(next), claims.accountId);
      if (body.name !== undefined) {
        db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(body.name, claims.accountId);
      }
    })();

    // Return the whole user so the client can refresh its snapshot in one step.
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(claims.sub) as UserRow;
    return { user: toAuthUser(db, user) };
  });
}
