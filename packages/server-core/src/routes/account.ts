import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { rm } from 'node:fs/promises';
import { ProfileUpdateSchema, VatProfileSchema, cleanArtistUpdate, cleanProfileLinks, type AccountProfile } from '@zollify/shared';
import { eventFilesDir } from './event-files';
import { parseProfile, toAuthUser, type JwtClaims, type UserRow } from '../auth';

/**
 * The account profile: who the booth is, and whether first-run setup has been
 * done. Held on the server rather than synced as ops because it is one record
 * per account with no offline write path worth building - the wizard runs on
 * a signed-in device, and every other device reads it at its next login.
 */
export function registerAccountRoutes(app: FastifyInstance, db: Database.Database, dataDir?: string): void {
  /**
   * Starts the booth over: every synced op, image and metric row for the
   * account is dropped and the sync epoch is bumped, so devices that still
   * hold the old log throw it away on their next pull. Users, devices and the
   * profile stay - it is the data that is reset, not the account.
   */
  app.post('/api/account/wipe', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    if (claims.role !== 'owner') {
      return reply.code(403).send({ error: 'forbidden', message: 'Only the owner can erase the booth data.' });
    }
    const removed = db.transaction((accountId: string) => {
      const ops = db.prepare('DELETE FROM ops WHERE accountId = ?').run(accountId).changes;
      db.prepare('DELETE FROM images WHERE accountId = ?').run(accountId);
      db.prepare('DELETE FROM event_files WHERE accountId = ?').run(accountId);
      db.prepare('DELETE FROM metrics WHERE accountId = ?').run(accountId);
      db.prepare('UPDATE accounts SET syncEpoch = syncEpoch + 1 WHERE id = ?').run(accountId);
      return ops;
    })(claims.accountId);
    if (dataDir) await rm(eventFilesDir(dataDir, claims.accountId), { recursive: true, force: true });
    return { ok: true, removedOps: removed };
  });

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
      return reply.code(403).send({ error: 'forbidden', message: 'Only an admin can change the business profile.' });
    }
    const parsed = ProfileUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', message: 'That profile is not valid.' });
    const body = parsed.data;

    // Links and the enterprise number end up on pages and invoices, so they are checked here, in words a person can act on.
    let artistUpdate: typeof body.artist;
    let links: AccountProfile['links'];
    try {
      artistUpdate = body.artist && cleanArtistUpdate(body.artist);
    } catch (err) {
      return reply.code(400).send({ error: 'invalid', message: (err as Error).message });
    }

    if (body.name !== undefined && claims.role !== 'owner') {
      return reply.code(403).send({ error: 'forbidden', message: 'Only the owner can rename the account.' });
    }

    const row = db.prepare('SELECT profile FROM accounts WHERE id = ?').get(claims.accountId) as
      | { profile: string | null }
      | undefined;
    const current = parseProfile(row?.profile);
    try {
      if (body.links) {
        // Field by field, like the artist: naming one link leaves the others alone.
        links = cleanProfileLinks({ ...current.links, ...body.links });
      } else links = current.links;
    } catch (err) {
      return reply.code(400).send({ error: 'invalid', message: (err as Error).message });
    }
    const next: AccountProfile = {
      setupCompletedAt: body.setupCompleted ? (current.setupCompletedAt ?? Date.now()) : current.setupCompletedAt,
      artist: { ...current.artist, ...(artistUpdate ?? {}) },
      defaultCurrency: body.defaultCurrency ?? current.defaultCurrency,
      vat: VatProfileSchema.parse({ ...current.vat, ...(body.vat ?? {}) }),
      staffSeesTotals: body.staffSeesTotals ?? current.staffSeesTotals ?? false,
      ...(body.sells ?? current.sells ? { sells: body.sells ?? current.sells } : {}),
      ...(links ? { links } : {}),
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
