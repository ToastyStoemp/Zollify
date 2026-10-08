import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bumpMetric } from './db';
import { issueTokens, sha256, touchDevice, type JwtClaims, type UserRow } from './auth';
import { lookupGeo, parseDevice } from './session-info';

/**
 * Sign in by QR: a signed-out device shows a code, a signed-in device scans
 * and approves it, and the signed-out device comes away with a session for
 * the approving user - no password typed on a shared booth tablet.
 *
 * Two secrets per request, deliberately separate:
 *   - the poll secret stays on the new device and is the only thing that can
 *     collect the session. It never appears on screen.
 *   - the code is what the QR shows. It rotates every ROTATE_MS while the
 *     new device keeps polling, so a photo of the screen goes stale within
 *     seconds, and it only ever lets a signed-in user approve - never sign in.
 *
 * The remaining risk is the classic one for this flow: someone shows you
 * *their* QR and you approve it. The approve screen therefore shows which
 * device is asking (browser/OS, IP, location) and the client tells the user
 * to approve only a device they are standing in front of.
 */

/** Whole request lifetime - long enough to find your phone, short enough to go stale. */
const LINK_TTL_MS = 5 * 60_000;
/** How often the code shown in the QR changes. */
const ROTATE_MS = 20_000;
/** A code scanned just before it rotated still counts for this long. */
const PREV_GRACE_MS = 10_000;
/**
 * A current code nobody has polled past (the new device closed the page)
 * stops working after this, instead of living for the whole LINK_TTL_MS.
 */
const CURRENT_MAX_AGE_MS = ROTATE_MS * 2;

const StartBody = z.object({
  deviceId: z.string().max(128).optional(),
  deviceName: z.string().max(128).optional(),
  flavor: z.string().max(32).optional(),
});
const PollBody = z.object({ id: z.string().uuid(), pollSecret: z.string().min(32).max(128) });
const CodeBody = z.object({ code: z.string().min(16).max(128) });

interface LinkRow {
  id: string;
  pollHash: string;
  codeHash: string | null;
  prevCodeHash: string | null;
  codeIssuedAt: number;
  status: 'pending' | 'approved' | 'denied' | 'consumed';
  userId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  flavor: string | null;
  ip: string | null;
  device: string | null;
  geo: string | null;
  createdAt: number;
  expiresAt: number;
}

const newSecret = (): string => randomBytes(32).toString('base64url');
const newCode = (): string => randomBytes(18).toString('base64url');

export function registerDeviceLinkRoutes(app: FastifyInstance, db: Database.Database): void {
  // Starting a request is unauthenticated and writes a row, so it shares the
  // login cap. Polling is a cheap indexed lookup every couple of seconds per
  // waiting device, so it gets a looser one.
  const START_LIMIT = { config: { rateLimit: { max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20), timeWindow: '1 minute' } } };
  const POLL_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
  const APPROVE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  const sweep = (): void => {
    db.prepare('DELETE FROM device_links WHERE expiresAt < ?').run(Date.now());
  };

  /** The pending request a scanned code belongs to, if the code is still live. */
  const byCode = (code: string): LinkRow | undefined => {
    const now = Date.now();
    const hash = sha256(code);
    const row = db
      .prepare("SELECT * FROM device_links WHERE (codeHash = ? OR prevCodeHash = ?) AND status = 'pending' AND expiresAt > ?")
      .get(hash, hash, now) as LinkRow | undefined;
    if (!row) return undefined;
    const age = now - row.codeIssuedAt;
    if (row.codeHash === hash && age < CURRENT_MAX_AGE_MS) return row;
    if (row.prevCodeHash === hash && age < PREV_GRACE_MS) return row;
    return undefined;
  };

  // ── New (signed-out) device ────────────────────────────────────────────────
  // Under /api/auth/ so the refresh-cookie adapter banks the session the poll
  // finally returns, exactly as it does for a password login.

  app.post('/api/auth/link/start', START_LIMIT, async (req, reply) => {
    const parsed = StartBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    sweep();

    const id = randomUUID();
    const pollSecret = newSecret();
    const code = newCode();
    const now = Date.now();
    db.prepare(
      `INSERT INTO device_links (id, pollHash, codeHash, codeIssuedAt, status, deviceId, deviceName, flavor, ip, device, geo, createdAt, expiresAt)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      sha256(pollSecret),
      sha256(code),
      now,
      parsed.data.deviceId || null,
      parsed.data.deviceName || null,
      parsed.data.flavor || null,
      req.ip,
      parseDevice(req.headers['user-agent']),
      await lookupGeo(req.ip),
      now,
      now + LINK_TTL_MS,
    );
    return { id, pollSecret, code, rotatesInMs: ROTATE_MS, expiresAt: now + LINK_TTL_MS };
  });

  app.post('/api/auth/link/poll', POLL_LIMIT, async (req, reply) => {
    const parsed = PollBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    const { id, pollSecret } = parsed.data;
    const now = Date.now();

    const row = db.prepare('SELECT * FROM device_links WHERE id = ? AND pollHash = ?').get(id, sha256(pollSecret)) as LinkRow | undefined;
    if (!row || row.expiresAt <= now || row.status === 'consumed') {
      return reply.code(410).send({ error: 'This sign-in code has expired.', status: 'expired' });
    }
    if (row.status === 'denied') {
      db.prepare('DELETE FROM device_links WHERE id = ?').run(id);
      return reply.code(403).send({ error: 'The other device declined this sign-in.', status: 'denied' });
    }

    if (row.status === 'approved') {
      // Single use: only the poll that flips approved → consumed gets tokens,
      // even if two polls race.
      const claimed = db.prepare("UPDATE device_links SET status = 'consumed' WHERE id = ? AND status = 'approved'").run(id);
      if (claimed.changes !== 1) return reply.code(410).send({ error: 'This sign-in code has expired.', status: 'expired' });
      db.prepare('DELETE FROM device_links WHERE id = ?').run(id);

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.userId) as UserRow | undefined;
      if (!user) return reply.code(410).send({ error: 'That account no longer exists.', status: 'expired' });

      db.prepare('UPDATE users SET lastLoginAt = ? WHERE id = ?').run(now, user.id);
      touchDevice(db, user.accountId, user.id, row.deviceId ?? undefined, row.deviceName ?? undefined, row.device ?? undefined, row.flavor);
      bumpMetric(db, user.accountId, 'logins');
      const tokens = await issueTokens(app, db, user, {
        deviceId: row.deviceId,
        deviceName: row.deviceName,
        flavor: row.flavor,
        ip: row.ip,
        device: row.device,
        geo: row.geo,
      });
      return { status: 'approved', ...tokens };
    }

    // Still waiting: rotate the code once it has been on screen long enough.
    if (now - row.codeIssuedAt >= ROTATE_MS) {
      const code = newCode();
      db.prepare('UPDATE device_links SET prevCodeHash = codeHash, codeHash = ?, codeIssuedAt = ? WHERE id = ?').run(sha256(code), now, id);
      return { status: 'pending', code, rotatesInMs: ROTATE_MS, expiresAt: row.expiresAt };
    }
    // The current code is only known to the client already showing it.
    return { status: 'pending', rotatesInMs: ROTATE_MS - (now - row.codeIssuedAt), expiresAt: row.expiresAt };
  });

  // ── Signed-in device ───────────────────────────────────────────────────────

  /** What the approve screen shows, so the user can tell whose device is asking. */
  app.post('/api/link/lookup', { ...APPROVE_LIMIT, preHandler: app.authenticate }, async (req, reply) => {
    const parsed = CodeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    const row = byCode(parsed.data.code);
    if (!row) return reply.code(404).send({ error: 'This code has expired. Show a fresh one on the other device and scan again.' });
    return {
      deviceName: row.deviceName,
      device: row.device,
      flavor: row.flavor,
      ip: row.ip,
      geo: row.geo,
      createdAt: row.createdAt,
    };
  });

  app.post('/api/link/approve', { ...APPROVE_LIMIT, preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const parsed = CodeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    const row = byCode(parsed.data.code);
    if (!row) return reply.code(404).send({ error: 'This code has expired. Show a fresh one on the other device and scan again.' });

    // Codes are cleared so the same scan can't be replayed onto the request.
    const info = db
      .prepare("UPDATE device_links SET status = 'approved', userId = ?, codeHash = NULL, prevCodeHash = NULL WHERE id = ? AND status = 'pending'")
      .run(claims.sub, row.id);
    if (info.changes !== 1) return reply.code(409).send({ error: 'Someone already answered this sign-in request.' });
    return { ok: true };
  });

  app.post('/api/link/deny', { ...APPROVE_LIMIT, preHandler: app.authenticate }, async (req, reply) => {
    const parsed = CodeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    const row = byCode(parsed.data.code);
    if (!row) return { ok: true };
    db.prepare("UPDATE device_links SET status = 'denied', codeHash = NULL, prevCodeHash = NULL WHERE id = ? AND status = 'pending'").run(row.id);
    return { ok: true };
  });
}
