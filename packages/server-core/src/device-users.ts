import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { DUMMY_HASH, checkSecondFactor, issueAccessToken, toAuthUser, type JwtClaims, type UserRow } from './auth';
import { makeSecretBox } from './secretbox';
import { STAFF_BADGE_PATTERN } from '@zollify/shared';

/**
 * Shared tills: several people of one account on one device, each unlocking
 * it with a personal PIN.
 *
 * The device keeps its ordinary sign-in - the "device session". Anyone else
 * from the same account is added to the device once, with their email and
 * password (and 2FA code); that binding hands the device a grant. From then
 * on their name and PIN unlock the till, and the server gives the device a
 * short-lived access token for *them*: what they may do and whom a sale is
 * credited to follow the person, not the device.
 *
 * Unlocking needs all three: the device session, the grant, and the PIN. A
 * PIN alone is useless off the device, and a grant without the PIN gets
 * nothing. Wrong PINs lock the person out of this device for a while, and
 * eventually remove them from it, so a 4-digit PIN cannot be walked.
 *
 * A staff badge - a barcode on a card - can stand in for the name and PIN:
 * scanning it unlocks as its owner, on devices they were added to. A device
 * can still ask for the PIN after the badge. Badges are long random codes,
 * stored hashed for lookup and encrypted for reprinting; a new one replaces
 * the old.
 *
 * Refusals are 403, never 401: a client treats 401 as an expired token and
 * retries, which would count one wrong PIN twice.
 *
 * There are no refresh tokens here: a person's token is renewed with the
 * grant for as long as their unlock lasts (a shift), and locking the till
 * ends it after a short grace that lets their last sales sync.
 */

const PIN = z.string().regex(/^\d{4,8}$/, 'A PIN is 4 to 8 digits.');
const UNLOCK_MS = 12 * 3600 * 1000;
/** After locking, a person's token can still be renewed this long, so their last sales sync under their own name. */
const LOCK_GRACE_MS = 5 * 60 * 1000;
const LOCKOUT_AFTER = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
/** This many wrong PINs and the person must be added to the device again, with their password. */
const REMOVE_AFTER = 10;

interface Binding {
  accountId: string;
  deviceId: string;
  userId: string;
  grantHash: string;
  failures: number;
  lockedUntil: number;
  unlockedUntil: number;
  lastUnlockAt: number | null;
  createdAt: number;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Badge codes: "ZS" and 22 characters from an alphabet without look-alikes,
 * about 110 bits - unguessable, and short enough for a Code 128 barcode on a
 * card. Scanners and keyboards may change case or drop the dash.
 */
const BADGE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newBadgeCode(): string {
  const bytes = randomBytes(22);
  return `ZS-${[...bytes].map((b) => BADGE_ALPHABET[b % 32]).join('')}`;
}
const normaliseBadge = (code: string): string => {
  const c = code.trim().toUpperCase().replace(/-/g, '');
  return `ZS-${c.slice(2)}`;
};

const AddBody = z.object({
  deviceId: z.string().min(1).max(100),
  email: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(500),
  code: z.string().max(40).optional(),
  pin: PIN.optional(),
});
const UnlockBody = z.object({ deviceId: z.string().min(1).max(100), userId: z.string().min(1).max(100), pin: z.string().max(20), grant: z.string().max(200).optional() });
const RenewBody = z.object({ deviceId: z.string().min(1).max(100), userId: z.string().min(1).max(100), grant: z.string().min(1).max(200) });
const LockBody = z.object({ deviceId: z.string().min(1).max(100), userId: z.string().min(1).max(100) });
const BadgeUnlockBody = z.object({
  deviceId: z.string().min(1).max(100),
  code: z.string().trim().regex(STAFF_BADGE_PATTERN),
  grants: z.record(z.string().max(100), z.string().max(200)).default({}),
  pin: z.string().max(20).optional(),
});
const PinBody = z.object({ password: z.string().min(1).max(500), pin: PIN.nullable() });

export function registerDeviceUserRoutes(app: FastifyInstance, db: Database.Database, jwtSecret: string): void {
  const box = makeSecretBox(jwtSecret);
  // Each PIN guess costs an argon2 verify; this also caps guessing per IP on top of the per-person lockout.
  const PIN_RATE_LIMIT = { config: { rateLimit: { max: Number(process.env.PIN_RATE_LIMIT_MAX || 30), timeWindow: '1 minute' } } };
  const AUTH_RATE_LIMIT = { config: { rateLimit: { max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20), timeWindow: '1 minute' } } };
  const auth = { preHandler: app.authenticate };

  const userById = (id: string): (UserRow & { pinHash: string | null }) | undefined =>
    db.prepare('SELECT * FROM users WHERE id = ?').get(id) as (UserRow & { pinHash: string | null }) | undefined;
  const binding = (accountId: string, deviceId: string, userId: string): Binding | undefined =>
    db.prepare('SELECT * FROM device_users WHERE accountId = ? AND deviceId = ? AND userId = ?').get(accountId, deviceId, userId) as Binding | undefined;
  const pinOk = async (hash: string | null | undefined, pin: string): Promise<boolean> =>
    argon2.verify(hash ?? DUMMY_HASH, pin).catch(() => false).then((ok) => ok && !!hash);
  const person = (u: UserRow & { pinHash: string | null }, b?: Binding) => ({
    userId: u.id,
    email: u.email,
    role: u.role,
    hasPin: !!u.pinHash,
    lockedUntil: b && b.lockedUntil > Date.now() ? b.lockedUntil : null,
  });

  // The device session's own user has no binding; their misses are counted here.
  const selfMisses = new Map<string, { n: number; until: number }>();

  // ── Your own PIN ──────────────────────────────────────────────────────────

  app.get('/api/users/me/pin', auth, async (req) => {
    const claims = req.user as JwtClaims;
    return { hasPin: !!userById(claims.sub)?.pinHash };
  });

  app.put('/api/users/me/pin', { ...auth, ...AUTH_RATE_LIMIT }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const body = PinBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Invalid request' });
    const user = userById(claims.sub);
    if (!user || !(await argon2.verify(user.passwordHash, body.data.password).catch(() => false))) {
      return reply.code(403).send({ error: 'Wrong password.' });
    }
    const hash = body.data.pin ? await argon2.hash(body.data.pin, { type: argon2.argon2id }) : null;
    db.prepare('UPDATE users SET pinHash = ? WHERE id = ?').run(hash, user.id);
    // Without a PIN nobody can unlock as this person; their bindings go too.
    if (!hash) db.prepare('DELETE FROM device_users WHERE userId = ?').run(user.id);
    return { hasPin: !!hash };
  });

  // ── People on this device ─────────────────────────────────────────────────

  app.get<{ Querystring: { deviceId?: string } }>('/api/device-users', auth, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const deviceId = String(req.query.deviceId ?? '');
    if (!deviceId) return reply.code(400).send({ error: 'deviceId is required' });
    const rows = db.prepare('SELECT * FROM device_users WHERE accountId = ? AND deviceId = ? ORDER BY createdAt').all(claims.accountId, deviceId) as Binding[];
    const people = rows.flatMap((b) => {
      const u = userById(b.userId);
      return u && u.accountId === claims.accountId ? [person(u, b)] : [];
    });
    return { people };
  });

  /** Adding someone to this device: they sign in once with their password; the device gets a grant. */
  app.post('/api/device-users', { ...auth, ...AUTH_RATE_LIMIT }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const body = AddBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Invalid request' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(body.data.email.toLowerCase()) as (UserRow & { pinHash: string | null }) | undefined;
    const ok = await argon2.verify(user?.passwordHash ?? DUMMY_HASH, body.data.password).catch(() => false);
    if (!user || !ok || user.accountId !== claims.accountId) return reply.code(403).send({ error: 'Wrong email or password for this account.' });
    if (user.totpEnabled) {
      const second = checkSecondFactor(db, box, user, body.data.code);
      if (second === 'missing') return reply.code(403).send({ error: 'Authenticator code required.', needs2fa: true });
      if (second === 'invalid') return reply.code(403).send({ error: 'Invalid authenticator code.', needs2fa: true });
    }
    let pinHash = user.pinHash;
    if (body.data.pin) {
      pinHash = await argon2.hash(body.data.pin, { type: argon2.argon2id });
      db.prepare('UPDATE users SET pinHash = ? WHERE id = ?').run(pinHash, user.id);
    }
    if (!pinHash) return reply.code(400).send({ error: 'Choose a PIN.', needsPin: true });

    const grant = randomBytes(32).toString('hex');
    db.prepare(
      `INSERT INTO device_users (accountId, deviceId, userId, grantHash, failures, lockedUntil, unlockedUntil, createdAt)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?)
       ON CONFLICT (deviceId, userId) DO UPDATE SET accountId = excluded.accountId, grantHash = excluded.grantHash, failures = 0, lockedUntil = 0, unlockedUntil = 0`,
    ).run(claims.accountId, body.data.deviceId, user.id, sha256(grant), Date.now());
    return reply.code(201).send({ grant, person: person({ ...user, pinHash }) });
  });

  app.delete<{ Params: { userId: string }; Querystring: { deviceId?: string } }>('/api/device-users/:userId', auth, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const info = db
      .prepare('DELETE FROM device_users WHERE accountId = ? AND deviceId = ? AND userId = ?')
      .run(claims.accountId, String(req.query.deviceId ?? ''), req.params.userId);
    if (!info.changes) return reply.code(404).send({ error: 'Not on this device.' });
    return { ok: true };
  });

  // ── Unlocking ─────────────────────────────────────────────────────────────

  /**
   * Unlocks the device as one person. `pin` null means a badge alone was
   * enough (the device does not ask for the PIN after a badge). For the
   * device session's own user this only checks; for anyone added to the
   * device it returns their own access token.
   */
  async function unlockAs(claims: JwtClaims, deviceId: string, userId: string, grant: string | undefined, pin: string | null, reply: FastifyReply) {
    const now = Date.now();
    if (userId === claims.sub) {
      if (pin === null) return { ok: true, userId };
      const key = `${deviceId}:${userId}`;
      const miss = selfMisses.get(key);
      if (miss && miss.until > now) return reply.code(423).send({ error: 'Too many wrong PINs - try again in a few minutes.', lockedUntil: miss.until });
      const user = userById(userId);
      if (!(await pinOk(user?.pinHash, pin))) {
        const n = (miss?.n ?? 0) + 1;
        selfMisses.set(key, { n: n >= LOCKOUT_AFTER ? 0 : n, until: n >= LOCKOUT_AFTER ? now + LOCKOUT_MS : 0 });
        return reply.code(403).send({ error: 'Wrong PIN.' });
      }
      selfMisses.delete(key);
      return { ok: true, userId };
    }

    const b = binding(claims.accountId, deviceId, userId);
    if (!b || !grant || sha256(grant) !== b.grantHash) return reply.code(404).send({ error: 'Not on this device - add them again.', removed: true, userId });
    const user = userById(userId);
    if (!user || user.accountId !== claims.accountId) return reply.code(404).send({ error: 'Not on this device - add them again.', removed: true, userId });

    if (pin !== null) {
      if (b.lockedUntil > now) return reply.code(423).send({ error: 'Too many wrong PINs - try again in a few minutes.', lockedUntil: b.lockedUntil });
      if (!(await pinOk(user.pinHash, pin))) {
        const failures = b.failures + 1;
        if (failures >= REMOVE_AFTER) {
          db.prepare('DELETE FROM device_users WHERE deviceId = ? AND userId = ?').run(deviceId, userId);
          return reply.code(404).send({ error: 'Too many wrong PINs - sign in with your password to add yourself again.', removed: true, userId });
        }
        const lockedUntil = failures % LOCKOUT_AFTER === 0 ? now + LOCKOUT_MS : 0;
        db.prepare('UPDATE device_users SET failures = ?, lockedUntil = ? WHERE deviceId = ? AND userId = ?').run(failures, lockedUntil, deviceId, userId);
        return lockedUntil
          ? reply.code(423).send({ error: 'Too many wrong PINs - try again in a few minutes.', lockedUntil })
          : reply.code(403).send({ error: 'Wrong PIN.' });
      }
    }
    db.prepare('UPDATE device_users SET failures = 0, lockedUntil = 0, unlockedUntil = ?, lastUnlockAt = ? WHERE deviceId = ? AND userId = ?').run(now + UNLOCK_MS, now, deviceId, userId);
    return { accessToken: issueAccessToken(app, user), user: toAuthUser(db, user) };
  }

  /** Name and PIN. */
  app.post('/api/auth/unlock', { ...auth, ...PIN_RATE_LIMIT }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const body = UnlockBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });
    return unlockAs(claims, body.data.deviceId, body.data.userId, body.data.grant, body.data.pin, reply);
  });

  /**
   * A scanned staff badge. The device sends its grants, since it does not
   * know whose badge it is until the server says; a badge only works for
   * someone added to this device (or the device's own user), and with `pin`
   * the PIN is checked too, as for a name-and-PIN unlock.
   */
  app.post('/api/auth/unlock-badge', { ...auth, ...PIN_RATE_LIMIT }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const body = BadgeUnlockBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });
    const user = db.prepare('SELECT id, accountId FROM users WHERE badgeHash = ?').get(sha256(normaliseBadge(body.data.code))) as { id: string; accountId: string } | undefined;
    if (!user || user.accountId !== claims.accountId) return reply.code(404).send({ error: 'Unknown badge - it may have been replaced.' });
    return unlockAs(claims, body.data.deviceId, user.id, body.data.grants[user.id], body.data.pin ?? null, reply);
  });

  // ── Badges ────────────────────────────────────────────────────────────────

  /** Your own badge, or - for an admin - a colleague's who does not outrank them. */
  const badgeTarget = (claims: JwtClaims, userId: string) => {
    const target = userById(userId);
    if (!target || target.accountId !== claims.accountId) return null;
    if (target.id === claims.sub) return target;
    if (claims.role === 'member' || (target.role === 'owner' && claims.role !== 'owner')) return null;
    return target;
  };

  app.get<{ Params: { userId: string } }>('/api/users/:userId/badge', auth, async (req, reply) => {
    const target = badgeTarget(req.user as JwtClaims, req.params.userId);
    if (!target) return reply.code(404).send({ error: 'No such person.' });
    const row = db.prepare('SELECT badgeBox, badgeIssuedAt FROM users WHERE id = ?').get(target.id) as { badgeBox: string | null; badgeIssuedAt: number | null };
    return { code: row.badgeBox ? box.decrypt<string>(row.badgeBox) : null, issuedAt: row.badgeIssuedAt, email: target.email };
  });

  /** A new badge; the old one stops working. */
  app.post<{ Params: { userId: string } }>('/api/users/:userId/badge', auth, async (req, reply) => {
    const target = badgeTarget(req.user as JwtClaims, req.params.userId);
    if (!target) return reply.code(404).send({ error: 'No such person.' });
    const code = newBadgeCode();
    const now = Date.now();
    db.prepare('UPDATE users SET badgeHash = ?, badgeBox = ?, badgeIssuedAt = ? WHERE id = ?').run(sha256(code), box.encrypt(code), now, target.id);
    return reply.code(201).send({ code, issuedAt: now, email: target.email });
  });

  app.delete<{ Params: { userId: string } }>('/api/users/:userId/badge', auth, async (req, reply) => {
    const target = badgeTarget(req.user as JwtClaims, req.params.userId);
    if (!target) return reply.code(404).send({ error: 'No such person.' });
    db.prepare('UPDATE users SET badgeHash = NULL, badgeBox = NULL, badgeIssuedAt = NULL WHERE id = ?').run(target.id);
    return { ok: true };
  });

  /** A fresh token for someone who is still unlocked (or just locked, so their sales can sync). */
  app.post('/api/auth/unlock/renew', auth, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const body = RenewBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });
    const b = binding(claims.accountId, body.data.deviceId, body.data.userId);
    if (!b || sha256(body.data.grant) !== b.grantHash) return reply.code(404).send({ error: 'Not on this device.', removed: true });
    if (b.unlockedUntil <= Date.now()) return reply.code(403).send({ error: 'Locked - enter the PIN again.' });
    const user = userById(b.userId);
    if (!user || user.accountId !== claims.accountId) return reply.code(404).send({ error: 'Not on this device.', removed: true });
    return { accessToken: issueAccessToken(app, user), user: toAuthUser(db, user) };
  });

  /** The till was locked: the person's unlock ends, after a short grace for syncing. */
  app.post('/api/auth/lock', auth, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const body = LockBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });
    db.prepare('UPDATE device_users SET unlockedUntil = MIN(unlockedUntil, ?) WHERE accountId = ? AND deviceId = ? AND userId = ?').run(
      Date.now() + LOCK_GRACE_MS,
      claims.accountId,
      body.data.deviceId,
      body.data.userId,
    );
    return { ok: true };
  });
}
