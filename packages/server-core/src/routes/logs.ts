import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LogUploadSchema, type AdminLogEntry } from '@zollify/shared';
import type { JwtClaims } from '../auth';

const ID_RE = /^[\w-]+$/;

/**
 * Client-uploaded diagnostic logs (console warnings/errors, uncaught
 * exceptions, and breadcrumbs like payment attempts). Any signed-in device
 * can upload its own; only the server owner can list or download them.
 */
export function registerLogRoutes(app: FastifyInstance, db: Database.Database, dataDir: string): void {
  const requireOwner = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if ((req.user as JwtClaims).role !== 'owner') reply.code(403).send({ error: 'Owner only' });
  };
  const ownerGuard = { preHandler: [app.authenticate, requireOwner] };

  const logPath = (id: string): string => {
    const dir = join(dataDir, 'logs');
    mkdirSync(dir, { recursive: true });
    return join(dir, `${id}.log`);
  };

  app.post('/api/logs', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = LogUploadSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid log upload' });
    const claims = req.user as JwtClaims;
    const { deviceId, deviceName, flavor, appVersion, reason, log } = parsed.data;
    const id = randomUUID();
    await writeFile(logPath(id), log, 'utf-8');
    db.prepare(
      `INSERT INTO logs (id, accountId, deviceId, deviceName, flavor, appVersion, reason, size, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, claims.accountId, deviceId, deviceName ?? null, flavor ?? null, appVersion ?? null, reason ?? null, Buffer.byteLength(log, 'utf-8'), Date.now());
    return { ok: true };
  });

  app.get('/api/admin/logs', ownerGuard, async (): Promise<AdminLogEntry[]> => {
    return db
      .prepare(
        `SELECT l.id, l.accountId, a.name AS accountName, l.deviceId, l.deviceName,
                l.flavor, l.appVersion, l.reason, l.size, l.createdAt
         FROM logs l JOIN accounts a ON a.id = l.accountId
         ORDER BY l.createdAt DESC LIMIT 200`,
      )
      .all() as AdminLogEntry[];
  });

  app.get('/api/admin/logs/:id', ownerGuard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ID_RE.test(id)) return reply.code(400).send({ error: 'Bad log id' });
    const row = db.prepare('SELECT id FROM logs WHERE id = ?').get(id) as { id: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Not found' });
    const text = await readFile(logPath(id), 'utf-8').catch(() => '');
    return { id, text };
  });
}
