import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EVENT_FILES_MAX_PER_EVENT,
  EVENT_FILE_MAX_BYTES,
  EventFileUploadSchema,
  type EventFileDownload,
} from '@zollify/shared';
import { parseAllowedEvents, type JwtClaims } from '../auth';

const ID_RE = /^[\w-]{1,80}$/;
/** What one account may keep in total, so a runaway client cannot fill the volume. */
const ACCOUNT_QUOTA_BYTES = 500 * 1024 * 1024;
/** base64 inflates by a third; leave room for the JSON around it. */
const BODY_LIMIT = Math.ceil((EVENT_FILE_MAX_BYTES * 4) / 3) + 4096;

/** Where an account's event files live; also what account deletion removes. */
export const eventFilesDir = (dataDir: string, accountId: string): string => join(dataDir, 'event-files', accountId);

/**
 * Files attached to events - tickets, floor plans, schedules.
 *
 * The event record (and so who can see it) syncs as ops; the bytes do not,
 * because a booth's connection at a convention is better spent on sales.
 * Anyone who can see the event may download its files, a helper included;
 * only owners and admins may add or remove them.
 */
export function registerEventFileRoutes(app: FastifyInstance, db: Database.Database, dataDir: string): void {
  const pathOf = (accountId: string, id: string): string => {
    const dir = eventFilesDir(dataDir, accountId);
    mkdirSync(dir, { recursive: true });
    return join(dir, id);
  };
  const allowedFor = (userId: string): string[] | null => {
    const row = db.prepare('SELECT allowedEventIds FROM users WHERE id = ?').get(userId) as { allowedEventIds: string | null } | undefined;
    return parseAllowedEvents(row?.allowedEventIds);
  };
  const canSee = (claims: JwtClaims, eventId: string): boolean => {
    const allowed = allowedFor(claims.sub);
    return !allowed || allowed.includes(eventId);
  };
  const canManage = (claims: JwtClaims): boolean => (claims.role === 'owner' || claims.role === 'admin') && !allowedFor(claims.sub);

  app.put(
    '/api/events/:eventId/files/:id',
    { preHandler: app.authenticate, bodyLimit: BODY_LIMIT, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const claims = req.user as JwtClaims;
      const { eventId, id } = req.params as { eventId: string; id: string };
      if (!ID_RE.test(eventId) || !ID_RE.test(id)) return reply.code(400).send({ error: 'Bad id' });
      if (!canManage(claims)) return reply.code(403).send({ error: 'Only an owner or admin can attach files.' });
      const parsed = EventFileUploadSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid file' });

      const bytes = Buffer.from(parsed.data.data, 'base64');
      if (bytes.length === 0) return reply.code(400).send({ error: 'That file is empty.' });
      if (bytes.length > EVENT_FILE_MAX_BYTES) return reply.code(413).send({ error: 'That file is too large.' });

      const existing = db.prepare('SELECT size FROM event_files WHERE id = ? AND accountId = ?').get(id, claims.accountId) as { size: number } | undefined;
      const count = (db.prepare('SELECT COUNT(*) AS n FROM event_files WHERE accountId = ? AND eventId = ?').get(claims.accountId, eventId) as { n: number }).n;
      if (!existing && count >= EVENT_FILES_MAX_PER_EVENT) return reply.code(409).send({ error: `An event can hold ${EVENT_FILES_MAX_PER_EVENT} files.` });
      const used = (db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM event_files WHERE accountId = ?').get(claims.accountId) as { n: number }).n;
      if (used - (existing?.size ?? 0) + bytes.length > ACCOUNT_QUOTA_BYTES) return reply.code(413).send({ error: 'This account has used up its file storage.' });

      await writeFile(pathOf(claims.accountId, id), bytes);
      db.prepare(
        `INSERT INTO event_files (id, accountId, eventId, name, mime, size, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id, accountId) DO UPDATE SET eventId = excluded.eventId, name = excluded.name, mime = excluded.mime, size = excluded.size`,
      ).run(id, claims.accountId, eventId, parsed.data.name, parsed.data.mime, bytes.length, Date.now());
      return { ok: true, size: bytes.length };
    },
  );

  app.get('/api/events/:eventId/files/:id', { preHandler: app.authenticate }, async (req, reply): Promise<EventFileDownload | void> => {
    const claims = req.user as JwtClaims;
    const { eventId, id } = req.params as { eventId: string; id: string };
    if (!ID_RE.test(eventId) || !ID_RE.test(id)) return reply.code(400).send({ error: 'Bad id' });
    // Same answer for "not yours" and "not there": a helper learns nothing about other events.
    const row = canSee(claims, eventId)
      ? (db.prepare('SELECT name, mime FROM event_files WHERE id = ? AND accountId = ? AND eventId = ?').get(id, claims.accountId, eventId) as { name: string; mime: string } | undefined)
      : undefined;
    if (!row) return reply.code(404).send({ error: 'Not found' });
    const bytes = await readFile(pathOf(claims.accountId, id)).catch(() => null);
    if (!bytes) return reply.code(404).send({ error: 'Not found' });
    return { name: row.name, mime: row.mime, data: bytes.toString('base64') };
  });

  app.delete('/api/events/:eventId/files/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const { eventId, id } = req.params as { eventId: string; id: string };
    if (!ID_RE.test(eventId) || !ID_RE.test(id)) return reply.code(400).send({ error: 'Bad id' });
    if (!canManage(claims)) return reply.code(403).send({ error: 'Only an owner or admin can remove files.' });
    const gone = db.prepare('DELETE FROM event_files WHERE id = ? AND accountId = ? AND eventId = ?').run(id, claims.accountId, eventId).changes;
    if (gone) await rm(pathOf(claims.accountId, id), { force: true });
    return { ok: true };
  });
}
