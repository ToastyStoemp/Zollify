import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  LoginRequestSchema,
  RefreshRequestSchema,
  RegisterRequestSchema,
  type AuthUser,
  type TokenResponse,
  type UserRole,
} from '@zollify/shared';
import { bumpMetric } from './db';
import { generateSecret, otpauthUri, verifyToken, generateRecoveryCodes, hashRecovery } from './totp';
import { issueChallenge, verifyChallenge } from './captcha';
import { makeSecretBox } from './secretbox';
import { parseDevice, lookupGeo, geoEnabled } from './session-info';

const ACCESS_TTL = '15m';
const DAY = 24 * 3600 * 1000;
// Refresh-token idle lifetime, sliding on every refresh. Longer for the Carbon
// POS so a device used at conventions every few weeks never re-prompts 2FA.
const REFRESH_TTL_WEB = Number(process.env.REFRESH_TTL_DAYS || 30) * DAY;
const REFRESH_TTL_CARBON = Number(process.env.REFRESH_TTL_DAYS_CARBON || 90) * DAY;
const refreshTtl = (flavor?: string | null): number => (flavor === 'carbon' ? REFRESH_TTL_CARBON : REFRESH_TTL_WEB);
// After a 2FA login on a device, that device can skip the code for this long.
const TRUST_TTL = Number(process.env.DEVICE_TRUST_DAYS || 60) * DAY;

interface SessionInfo {
  deviceId?: string | null;
  deviceName?: string | null;
  flavor?: string | null;
  ip?: string | null;
  device?: string | null;
  geo?: string | null;
}

// A valid argon2id hash of a throwaway value. Verified against on login when the
// email is unknown, so a missing user costs the same time as a wrong password —
// closing the timing side-channel that would otherwise reveal which emails exist.
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$LNyRVyktowy+Cb4nmWxqVg$RYqS8odpvRgQmClUelVQI2+sTXtVDEmp7/ejvWlyryA';

export interface JwtClaims {
  sub: string;
  accountId: string;
  role: UserRole;
}

interface UserRow {
  id: string;
  accountId: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  totpSecret?: string | null;
  totpEnabled?: number;
  recoveryCodes?: string | null;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Parse a user's stored allowedEventIds JSON → string[] | null (null = full access). */
export function parseAllowedEvents(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr) && arr.length) return arr.map(String);
  } catch { /* unrestricted */ }
  return null;
}

function toAuthUser(db: Database.Database, user: UserRow): AuthUser {
  const account = db.prepare('SELECT name FROM accounts WHERE id = ?').get(user.accountId) as { name: string };
  const row = db.prepare('SELECT allowedEventIds FROM users WHERE id = ?').get(user.id) as { allowedEventIds: string | null } | undefined;
  return {
    id: user.id, email: user.email, role: user.role, accountId: user.accountId, accountName: account.name,
    allowedEventIds: parseAllowedEvents(row?.allowedEventIds),
  };
}

async function issueTokens(
  app: FastifyInstance,
  db: Database.Database,
  user: UserRow,
  session: SessionInfo = {},
): Promise<TokenResponse> {
  const claims: JwtClaims = { sub: user.id, accountId: user.accountId, role: user.role };
  const accessToken = app.jwt.sign(claims, { expiresIn: ACCESS_TTL });
  const refreshToken = randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    `INSERT INTO refresh_tokens (id, userId, tokenHash, expiresAt, createdAt, deviceId, deviceName, flavor, ip, device, geo, lastUsedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    user.id,
    sha256(refreshToken),
    now + refreshTtl(session.flavor),
    now,
    session.deviceId ?? null,
    session.deviceName ?? null,
    session.flavor ?? null,
    session.ip ?? null,
    session.device ?? null,
    session.geo ?? null,
    now,
  );
  return { accessToken, refreshToken, user: toAuthUser(db, user) };
}

// ── Device trust: a 2FA'd device can skip the code on later logins ───────────
function issueDeviceTrust(db: Database.Database, userId: string, deviceId: string): string {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO trusted_devices (id, userId, deviceId, tokenHash, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
    randomUUID(),
    userId,
    deviceId,
    sha256(token),
    Date.now() + TRUST_TTL,
    Date.now(),
  );
  return token;
}
function deviceTrusted(db: Database.Database, userId: string, deviceId: string | undefined, token: string | undefined): boolean {
  if (!deviceId || !token) return false;
  const row = db
    .prepare('SELECT id FROM trusted_devices WHERE userId = ? AND deviceId = ? AND tokenHash = ? AND expiresAt > ?')
    .get(userId, deviceId, sha256(token), Date.now());
  return !!row;
}
function clearDeviceTrust(db: Database.Database, userId: string): void {
  db.prepare('DELETE FROM trusted_devices WHERE userId = ?').run(userId);
}

function touchDevice(db: Database.Database, accountId: string, userId: string, deviceId?: string, name?: string): void {
  if (!deviceId) return;
  db.prepare(
    `INSERT INTO devices (id, accountId, userId, name, lastSeenAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET lastSeenAt = excluded.lastSeenAt, name = COALESCE(excluded.name, name)`,
  ).run(deviceId, accountId, userId, name ?? null, Date.now(), Date.now());
}

/** Seed the server owner from env on first boot (OWNER_EMAIL / OWNER_PASSWORD). */
export async function seedOwner(db: Database.Database): Promise<void> {
  const email = process.env.OWNER_EMAIL?.toLowerCase();
  const password = process.env.OWNER_PASSWORD;
  if (!email || !password) return;
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return;
  const accountId = randomUUID();
  db.prepare('INSERT INTO accounts (id, name, createdAt) VALUES (?, ?, ?)').run(accountId, 'Owner', Date.now());
  db.prepare('INSERT INTO users (id, accountId, email, passwordHash, role, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
    randomUUID(),
    accountId,
    email,
    await argon2.hash(password, { type: argon2.argon2id }),
    'owner',
    Date.now(),
  );
}

export function registerAuthRoutes(app: FastifyInstance, db: Database.Database, jwtSecret: string, dataDir: string): void {
  const box = makeSecretBox(jwtSecret); // encrypts TOTP secrets at rest
  const requireCaptcha = process.env.REQUIRE_CAPTCHA !== '0';
  const has2fa = (u: UserRow): boolean => !!u.totpEnabled;

  // Caps for the auth surface (per client IP). Login/register run an expensive
  // argon2 hash, so this blunts both password brute-forcing and the CPU-DoS of
  // hammering the hasher. Kept generous enough that a venue full of helper
  // devices behind one NAT/WiFi (shared public IP) isn't locked out at shift
  // start. Read at startup (env), so it's configurable per deployment. A
  // per-account lockout is a stronger follow-up.
  const AUTH_RATE_LIMIT = {
    config: { rateLimit: { max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20), timeWindow: '1 minute' } },
  };
  // Refresh is a cheap indexed lookup of a 256-bit unguessable token, so the
  // only risk is flooding (already covered globally) — a higher cap avoids
  // throttling several devices on one IP that all refresh their 15-min access
  // token together.
  const REFRESH_RATE_LIMIT = {
    config: { rateLimit: { max: Number(process.env.REFRESH_RATE_LIMIT_MAX || 60), timeWindow: '1 minute' } },
  };

  // Public proof-of-work CAPTCHA challenge (the client solves it before register).
  app.get('/api/captcha/challenge', async () => issueChallenge());

  app.post('/api/auth/register', AUTH_RATE_LIMIT, async (req, reply) => {
    const parsed = RegisterRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const { email, password, inviteCode, accountName } = parsed.data;
    const emailLc = email.toLowerCase();

    // Account creation is bot-gated by the proof-of-work CAPTCHA (unless disabled
    // for tests/headless via REQUIRE_CAPTCHA=0).
    if (requireCaptcha) {
      const b = (req.body ?? {}) as { captchaToken?: string; captchaSolution?: string };
      const cap = verifyChallenge(b.captchaToken ?? '', b.captchaSolution ?? '');
      if (!cap.ok) return reply.code(400).send({ error: cap.error });
    }

    if (db.prepare('SELECT id FROM users WHERE email = ?').get(emailLc)) {
      return reply.code(409).send({ error: 'Email already registered' });
    }

    const open = process.env.REGISTRATION_OPEN === '1';
    let invite: { code: string; accountId: string | null; role: UserRole; allowedEventIds: string | null } | undefined;
    if (inviteCode) {
      invite = db
        .prepare('SELECT code, accountId, role, allowedEventIds FROM invites WHERE code = ? AND usedBy IS NULL AND expiresAt > ?')
        .get(inviteCode.trim().toUpperCase(), Date.now()) as typeof invite;
      if (!invite && !open) return reply.code(403).send({ error: 'Invalid or expired invite code' });
    } else if (!open) {
      return reply.code(403).send({ error: 'An invite code is required' });
    }

    // Hash before any DB write so invite consumption and user creation are one
    // synchronous, atomic step (no `await` in between). Combined with the
    // conditional UPDATE below, an invite code can never be spent twice — not
    // even by two registrations racing on the same code.
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const userId = randomUUID();
    const role: UserRole = invite ? (invite.accountId ? invite.role : 'admin') : 'admin';
    let accountId = invite?.accountId ?? null;

    try {
      db.transaction(() => {
        if (!accountId) {
          accountId = randomUUID();
          db.prepare('INSERT INTO accounts (id, name, createdAt) VALUES (?, ?, ?)').run(
            accountId,
            accountName?.trim() || emailLc.split('@')[0],
            Date.now(),
          );
        }
        db.prepare('INSERT INTO users (id, accountId, email, passwordHash, role, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
          userId,
          accountId,
          emailLc,
          passwordHash,
          role,
          Date.now(),
        );
        if (invite) {
          // Single-use: the UPDATE only matches while the code is still unspent.
          // 0 rows changed means a concurrent registration just claimed it, so
          // throw to roll the whole transaction back (no user/account created).
          const claimed = db.prepare('UPDATE invites SET usedBy = ? WHERE code = ? AND usedBy IS NULL').run(userId, invite.code);
          if (claimed.changes !== 1) throw new Error('INVITE_USED');
          // A helper invite binds the new member to specific events (server-enforced isolation).
          if (invite.allowedEventIds && invite.accountId) {
            db.prepare('UPDATE users SET allowedEventIds = ? WHERE id = ?').run(invite.allowedEventIds, userId);
          }
        }
      })();
    } catch (e) {
      if (e instanceof Error && e.message === 'INVITE_USED') {
        return reply.code(409).send({ error: 'This invite code has already been used' });
      }
      throw e;
    }

    const user: UserRow = { id: userId, accountId: accountId!, email: emailLc, passwordHash, role };
    bumpMetric(db, accountId!, 'logins');
    const b = (req.body ?? {}) as { flavor?: string };
    return issueTokens(app, db, user, {
      flavor: b.flavor ?? null,
      ip: req.ip,
      device: parseDevice(req.headers['user-agent']),
      geo: await lookupGeo(req.ip),
    });
  });

  app.post('/api/auth/login', AUTH_RATE_LIMIT, async (req, reply) => {
    const parsed = LoginRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    const { email, password, deviceId, deviceName } = parsed.data;
    const b = (req.body ?? {}) as { code?: string; flavor?: string; trustToken?: string; rememberDevice?: boolean };

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as UserRow | undefined;
    // Always run a verify — against the real hash or a dummy — so an unknown
    // email takes the same time as a wrong password (no user-enumeration oracle).
    const ok = await argon2.verify(user?.passwordHash ?? DUMMY_HASH, password).catch(() => false);
    if (!user || !ok) {
      return reply.code(401).send({ error: 'Wrong email or password' });
    }

    // Second factor, unless this device is already trusted from a prior 2FA login.
    let usedRecovery = false;
    if (has2fa(user) && !deviceTrusted(db, user.id, deviceId, b.trustToken)) {
      const code = String(b.code ?? '').trim();
      if (!code) return reply.code(401).send({ error: 'Authenticator code required.', needs2fa: true });
      if (verifyToken(box.decrypt<string>(user.totpSecret as string), code)) {
        /* valid TOTP */
      } else {
        const codes: string[] = JSON.parse(user.recoveryCodes ?? '[]');
        const idx = codes.indexOf(hashRecovery(code));
        if (idx < 0) return reply.code(401).send({ error: 'Invalid authenticator code.', needs2fa: true });
        codes.splice(idx, 1); // recovery codes are single-use
        db.prepare('UPDATE users SET recoveryCodes = ? WHERE id = ?').run(JSON.stringify(codes), user.id);
        usedRecovery = true;
      }
    }

    db.prepare('UPDATE users SET lastLoginAt = ? WHERE id = ?').run(Date.now(), user.id);
    touchDevice(db, user.accountId, user.id, deviceId, deviceName);
    bumpMetric(db, user.accountId, 'logins');
    const tokens = await issueTokens(app, db, user, {
      deviceId,
      deviceName,
      flavor: b.flavor ?? null,
      ip: req.ip,
      device: parseDevice(req.headers['user-agent']),
      geo: await lookupGeo(req.ip),
    });
    // "Remember this device" — issue a trust token so 2FA is skipped here next time.
    const extra: Record<string, unknown> = {};
    if (has2fa(user) && b.rememberDevice && deviceId) extra.deviceTrustToken = issueDeviceTrust(db, user.id, deviceId);
    if (usedRecovery) extra.usedRecovery = true;
    return { ...tokens, ...extra };
  });

  app.post('/api/auth/refresh', REFRESH_RATE_LIMIT, async (req, reply) => {
    const parsed = RefreshRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });

    const hash = sha256(parsed.data.refreshToken);
    const row = db
      .prepare('SELECT id, userId, deviceId, deviceName, flavor, ip, device, geo FROM refresh_tokens WHERE tokenHash = ? AND expiresAt > ?')
      .get(hash, Date.now()) as
      | { id: string; userId: string; deviceId: string | null; deviceName: string | null; flavor: string | null; ip: string | null; device: string | null; geo: string | null }
      | undefined;
    if (!row) return reply.code(401).send({ error: 'Invalid refresh token' });

    // Rotate: the old token is single-use. The new one carries the session's
    // device/geo forward and slides its expiry by the flavor's TTL.
    db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(row.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.userId) as UserRow | undefined;
    if (!user) return reply.code(401).send({ error: 'User no longer exists' });
    return issueTokens(app, db, user, {
      deviceId: row.deviceId,
      deviceName: row.deviceName,
      flavor: row.flavor,
      ip: row.ip,
      device: row.device,
      geo: row.geo,
    });
  });

  /**
   * Ends this device's session. Revokes the refresh token server-side so a
   * copied cookie is dead too; the cookie adapter clears the browser's copy.
   * Always 200: a token that is already gone is the outcome we want.
   */
  app.post('/api/auth/logout', REFRESH_RATE_LIMIT, async (req) => {
    const token = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    if (typeof token === 'string' && token.length > 0) {
      db.prepare('DELETE FROM refresh_tokens WHERE tokenHash = ?').run(sha256(token));
    }
    return { ok: true };
  });

  // ── Two-factor auth (TOTP authenticator) ───────────────────────────────────
  app.get('/api/2fa/status', { preHandler: app.authenticate }, async (req) => {
    const claims = req.user as JwtClaims;
    const u = db.prepare('SELECT totpEnabled FROM users WHERE id = ?').get(claims.sub) as { totpEnabled: number } | undefined;
    return { enabled: !!u?.totpEnabled };
  });
  app.post('/api/2fa/setup', { preHandler: app.authenticate }, async (req) => {
    const claims = req.user as JwtClaims;
    const u = db.prepare('SELECT email FROM users WHERE id = ?').get(claims.sub) as { email: string };
    const secret = generateSecret();
    db.prepare('UPDATE users SET totpSecret = ?, totpEnabled = 0 WHERE id = ?').run(box.encrypt(secret), claims.sub);
    return { secret, otpauth: otpauthUri({ secret, account: u.email, issuer: 'Zollify' }) };
  });
  app.post('/api/2fa/enable', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const u = db.prepare('SELECT totpSecret FROM users WHERE id = ?').get(claims.sub) as { totpSecret: string | null } | undefined;
    if (!u?.totpSecret) return reply.code(400).send({ error: 'Start 2FA setup first.' });
    const code = String((req.body as { code?: string } | undefined)?.code ?? '').trim();
    if (!verifyToken(box.decrypt<string>(u.totpSecret), code)) {
      return reply.code(400).send({ error: 'That code is not valid — check your device clock and try again.' });
    }
    const codes = generateRecoveryCodes(10);
    db.prepare('UPDATE users SET totpEnabled = 1, recoveryCodes = ? WHERE id = ?').run(JSON.stringify(codes.map(hashRecovery)), claims.sub);
    return { enabled: true, recovery: codes };
  });
  app.post('/api/2fa/disable', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const u = db.prepare('SELECT totpSecret, totpEnabled, recoveryCodes FROM users WHERE id = ?').get(claims.sub) as UserRow | undefined;
    if (!u?.totpEnabled) return { enabled: false };
    const code = String((req.body as { code?: string } | undefined)?.code ?? '').trim();
    const recovery: string[] = JSON.parse(u.recoveryCodes ?? '[]');
    const ok = verifyToken(box.decrypt<string>(u.totpSecret as string), code) || recovery.includes(hashRecovery(code));
    if (!ok) return reply.code(400).send({ error: 'Enter a valid authenticator or recovery code to disable 2FA.' });
    db.prepare('UPDATE users SET totpSecret = NULL, totpEnabled = 0, recoveryCodes = NULL WHERE id = ?').run(claims.sub);
    clearDeviceTrust(db, claims.sub);
    return { enabled: false };
  });

  // ── Sessions (this user) ───────────────────────────────────────────────────
  app.get('/api/sessions', { preHandler: app.authenticate }, async (req) => {
    const claims = req.user as JwtClaims;
    const sessions = db
      .prepare(
        `SELECT id, deviceId, deviceName, device, ip, geo, flavor, createdAt, lastUsedAt
         FROM refresh_tokens WHERE userId = ? AND expiresAt > ? ORDER BY lastUsedAt DESC`,
      )
      .all(claims.sub, Date.now());
    return { geo: geoEnabled(), sessions };
  });
  app.delete('/api/sessions/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const { id } = req.params as { id: string };
    const info = db.prepare('DELETE FROM refresh_tokens WHERE id = ? AND userId = ?').run(id, claims.sub);
    if (!info.changes) return reply.code(404).send({ error: 'Session not found' });
    return { ok: true };
  });
  // Log out everywhere except the current device (identified by its deviceId).
  app.post('/api/sessions/revoke-others', { preHandler: app.authenticate }, async (req) => {
    const claims = req.user as JwtClaims;
    const keep = (req.body as { deviceId?: string } | undefined)?.deviceId;
    const info = keep
      ? db.prepare('DELETE FROM refresh_tokens WHERE userId = ? AND (deviceId IS NULL OR deviceId != ?)').run(claims.sub, keep)
      : db.prepare('DELETE FROM refresh_tokens WHERE userId = ?').run(claims.sub);
    return { revoked: info.changes };
  });

  // Current user (with up-to-date role + allowedEventIds) — the client polls this
  // each sync so an admin changing a helper's events takes effect without re-login.
  app.get('/api/auth/me', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const user = db
      .prepare('SELECT id, email, role, accountId, passwordHash FROM users WHERE id = ?')
      .get(claims.sub) as UserRow | undefined;
    if (!user) return reply.code(401).send({ error: 'Not authenticated' });
    return { user: toAuthUser(db, user) };
  });

  // Members invite helpers' devices into their account; the server owner can
  // also mint invites that create brand-new accounts (newAccount: true).
  app.post('/api/invites', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const body = (req.body ?? {}) as { newAccount?: boolean; role?: UserRole; allowedEventIds?: string[] };
    if (body.newAccount && claims.role !== 'owner') {
      return reply.code(403).send({ error: 'Only the server owner can create new-account invites' });
    }
    if (!body.newAccount && claims.role === 'member') {
      return reply.code(403).send({ error: 'Only admins can invite members' });
    }
    // A restricted "helper" invite: a member bound to one or more events.
    const events = Array.isArray(body.allowedEventIds) ? body.allowedEventIds.filter((e) => typeof e === 'string' && e) : [];
    const allowedEventIds = !body.newAccount && events.length ? JSON.stringify(events) : null;
    const code = randomBytes(4).toString('hex').toUpperCase();
    db.prepare('INSERT INTO invites (code, accountId, role, allowedEventIds, createdBy, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      code,
      body.newAccount ? null : claims.accountId,
      allowedEventIds ? 'member' : body.role === 'admin' ? 'admin' : 'member',
      allowedEventIds,
      claims.sub,
      Date.now(),
      Date.now() + 14 * 24 * 3600 * 1000,
    );
    return { code, expiresInDays: 14 };
  });

  // List this account's invite codes (admins/owner) with used/expiry status.
  app.get('/api/invites', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    if (claims.role === 'member') return reply.code(403).send({ error: 'Admins only' });
    const rows = db
      .prepare('SELECT code, role, allowedEventIds, createdAt, expiresAt, usedBy FROM invites WHERE accountId = ? ORDER BY createdAt DESC')
      .all(claims.accountId) as { code: string; role: UserRole; allowedEventIds: string | null; createdAt: number; expiresAt: number; usedBy: string | null }[];
    return {
      invites: rows.map((i) => ({
        code: i.code,
        role: i.role,
        allowedEventIds: parseAllowedEvents(i.allowedEventIds),
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
        used: !!i.usedBy,
        usedByEmail: i.usedBy
          ? ((db.prepare('SELECT email FROM users WHERE id = ?').get(i.usedBy) as { email?: string } | undefined)?.email ?? null)
          : null,
      })),
    };
  });

  // Revoke / delete one of the account's invite codes (admins/owner).
  app.delete('/api/invites/:code', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    if (claims.role === 'member') return reply.code(403).send({ error: 'Admins only' });
    const { code } = req.params as { code: string };
    const info = db
      .prepare('DELETE FROM invites WHERE code = ? AND accountId = ?')
      .run(String(code).trim().toUpperCase(), claims.accountId);
    return { deleted: info.changes };
  });

  // Members of the caller's account (admins/owner) — for managing helpers.
  app.get('/api/users', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    if (claims.role === 'member') return reply.code(403).send({ error: 'Admins only' });
    const rows = db
      .prepare('SELECT id, email, role, allowedEventIds, createdAt, lastLoginAt FROM users WHERE accountId = ? ORDER BY createdAt')
      .all(claims.accountId) as { id: string; email: string; role: UserRole; allowedEventIds: string | null; createdAt: number; lastLoginAt: number | null }[];
    return {
      users: rows.map((u) => ({
        id: u.id, email: u.email, role: u.role,
        allowedEventIds: parseAllowedEvents(u.allowedEventIds),
        createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
      })),
    };
  });

  // Set which events a member ("helper") is restricted to. Empty array / null =
  // full access. Admins/owner only, same account, target must be a member.
  app.put('/api/users/:id/events', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    if (claims.role === 'member') return reply.code(403).send({ error: 'Admins only' });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { allowedEventIds?: string[] | null };
    const target = db.prepare('SELECT id, accountId, role FROM users WHERE id = ?').get(id) as
      | { id: string; accountId: string; role: UserRole }
      | undefined;
    if (!target || target.accountId !== claims.accountId) return reply.code(404).send({ error: 'User not found' });
    if (target.role !== 'member') return reply.code(400).send({ error: 'Only members can be restricted to events' });
    const events = Array.isArray(body.allowedEventIds) ? body.allowedEventIds.filter((e) => typeof e === 'string' && e) : [];
    const value = events.length ? JSON.stringify(events) : null;
    db.prepare('UPDATE users SET allowedEventIds = ? WHERE id = ?').run(value, id);
    return { ok: true, allowedEventIds: events.length ? events : null };
  });

  // Re-verify the caller's own password — a gate for irreversible actions.
  async function passwordOk(userId: string, password: unknown): Promise<boolean> {
    const row = db.prepare('SELECT passwordHash FROM users WHERE id = ?').get(userId) as { passwordHash: string } | undefined;
    if (!row) return false;
    try {
      return await argon2.verify(row.passwordHash, String(password ?? ''));
    } catch {
      return false;
    }
  }

  // Delete the caller's own user, leaving the shared account/data intact. For
  // members (helpers) leaving, and for admins when another admin remains — the
  // last admin must delete the whole account instead (below), never orphan it.
  app.post('/api/users/me/delete', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const body = (req.body ?? {}) as { password?: string };
    if (!(await passwordOk(claims.sub, body.password))) return reply.code(401).send({ error: 'Password is incorrect' });
    if (claims.role !== 'member') {
      const otherAdmins = (
        db.prepare("SELECT COUNT(*) AS n FROM users WHERE accountId = ? AND id != ? AND role IN ('admin','owner')").get(claims.accountId, claims.sub) as { n: number }
      ).n;
      if (otherAdmins === 0) {
        return reply.code(409).send({ error: 'You are the only admin. Delete the whole account instead, or promote another admin first.' });
      }
    }
    db.transaction(() => {
      db.prepare('DELETE FROM refresh_tokens WHERE userId = ?').run(claims.sub);
      db.prepare('DELETE FROM trusted_devices WHERE userId = ?').run(claims.sub);
      db.prepare('DELETE FROM devices WHERE userId = ?').run(claims.sub);
      // Clear FK references to this user before removing it.
      db.prepare('DELETE FROM invites WHERE usedBy = ? OR createdBy = ?').run(claims.sub, claims.sub);
      db.prepare('UPDATE api_tokens SET createdBy = NULL WHERE createdBy = ?').run(claims.sub);
      db.prepare('DELETE FROM users WHERE id = ?').run(claims.sub);
    })();
    return { ok: true };
  });

  // Delete the caller's entire account: every user, all sync data, images,
  // tokens, metrics and logs. Account admins/owner only, password-confirmed,
  // irreversible. This is a client erasing their own workspace for good.
  app.post('/api/account/delete', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    if (claims.role === 'member') return reply.code(403).send({ error: 'Only an account admin can delete the account' });
    const body = (req.body ?? {}) as { password?: string };
    if (!(await passwordOk(claims.sub, body.password))) return reply.code(401).send({ error: 'Password is incorrect' });
    const accountId = claims.accountId;
    db.transaction(() => {
      const userIds = (db.prepare('SELECT id FROM users WHERE accountId = ?').all(accountId) as { id: string }[]).map((u) => u.id);
      const delTokens = db.prepare('DELETE FROM refresh_tokens WHERE userId = ?');
      const delTrust = db.prepare('DELETE FROM trusted_devices WHERE userId = ?');
      for (const uid of userIds) {
        delTokens.run(uid);
        delTrust.run(uid);
      }
      // Invites can reference this account's users via createdBy/usedBy even when
      // the invite itself is for a new account (accountId NULL) — clear all of them.
      db.prepare(
        'DELETE FROM invites WHERE accountId = ? OR createdBy IN (SELECT id FROM users WHERE accountId = ?) OR usedBy IN (SELECT id FROM users WHERE accountId = ?)',
      ).run(accountId, accountId, accountId);
      for (const table of ['ops', 'images', 'metrics', 'logs', 'api_tokens', 'devices']) {
        db.prepare(`DELETE FROM ${table} WHERE accountId = ?`).run(accountId);
      }
      db.prepare('DELETE FROM users WHERE accountId = ?').run(accountId);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
    })();
    // Full-size images live on disk per account — remove that tree too.
    try {
      rmSync(join(dataDir, 'images', accountId), { recursive: true, force: true });
    } catch {
      /* best-effort: the DB rows are already gone */
    }
    return { ok: true };
  });

  // ── Scoped API tokens (machine access, e.g. the ZollTax accounting bridge) ──
  // Admins/owners mint a read-only token so a config never holds a password.
  app.post('/api/tokens', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    if (claims.role === 'member') return reply.code(403).send({ error: 'Only admins or the owner can create tokens' });
    const body = (req.body ?? {}) as { name?: string; scopes?: string };
    const scopes = body.scopes?.trim() || 'data:read';
    const token = `zt_${randomBytes(24).toString('hex')}`;
    const id = randomUUID();
    db.prepare(
      'INSERT INTO api_tokens (id, accountId, name, tokenHash, scopes, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, claims.accountId, body.name?.trim() || 'API token', sha256(token), scopes, claims.sub, Date.now());
    // The plaintext token is shown exactly once — only its hash is stored.
    return { id, token, name: body.name?.trim() || 'API token', scopes };
  });

  app.get('/api/tokens', { preHandler: app.authenticate }, async (req) => {
    const claims = req.user as JwtClaims;
    return db
      .prepare(
        'SELECT id, name, scopes, createdAt, lastUsedAt, revokedAt FROM api_tokens WHERE accountId = ? ORDER BY createdAt DESC',
      )
      .all(claims.accountId);
  });

  app.delete('/api/tokens/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    if (claims.role === 'member') return reply.code(403).send({ error: 'Only admins or the owner can revoke tokens' });
    const { id } = req.params as { id: string };
    const info = db
      .prepare('UPDATE api_tokens SET revokedAt = ? WHERE id = ? AND accountId = ? AND revokedAt IS NULL')
      .run(Date.now(), id, claims.accountId);
    if (!info.changes) return reply.code(404).send({ error: 'Token not found' });
    return { revoked: true };
  });

  // Permanently remove a token row. Only an already-revoked token can be purged —
  // an active token must be revoked first, so a live integration never vanishes
  // out from under itself by accident.
  app.delete('/api/tokens/:id/purge', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    if (claims.role === 'member') return reply.code(403).send({ error: 'Only admins or the owner can delete tokens' });
    const { id } = req.params as { id: string };
    const info = db
      .prepare('DELETE FROM api_tokens WHERE id = ? AND accountId = ? AND revokedAt IS NOT NULL')
      .run(id, claims.accountId);
    if (!info.changes) return reply.code(404).send({ error: 'Token not found or still active' });
    return { deleted: true };
  });
}

/** Fastify decorator: verifies the bearer token, populates req.user with JwtClaims. */
export async function authenticate(this: FastifyInstance, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Not authenticated' });
  }
}

/**
 * Accepts EITHER a `zt_…` API token (read-only, `data:read`) OR a normal JWT.
 * Used by the read-only data API so machine clients need a scoped token, not an
 * account password. On success `req.user` is populated with JwtClaims.
 */
export async function authenticateApiOrJwt(
  this: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const m = /^Bearer\s+(zt_[A-Za-z0-9]+)$/.exec(req.headers.authorization ?? '');
  if (m) {
    const row = this.db
      .prepare('SELECT id, accountId, scopes FROM api_tokens WHERE tokenHash = ? AND revokedAt IS NULL')
      .get(sha256(m[1])) as { id: string; accountId: string; scopes: string } | undefined;
    if (!row) return reply.code(401).send({ error: 'Invalid or revoked API token' });
    const scopes = String(row.scopes || '').split(/[\s,]+/).filter(Boolean);
    if (!scopes.includes('data:read')) return reply.code(403).send({ error: 'Token lacks the data:read scope' });
    this.db.prepare('UPDATE api_tokens SET lastUsedAt = ? WHERE id = ?').run(Date.now(), row.id);
    req.user = { sub: `token:${row.id}`, accountId: row.accountId, role: 'member' } as JwtClaims;
    return;
  }
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Not authenticated' });
  }
}

/**
 * Write-capable sibling of {@link authenticateApiOrJwt}. Accepts EITHER a `zt_…`
 * API token carrying the `data:write` scope OR a normal JWT whose role is owner
 * or admin. Backs the catalog write API used by external tooling such as the
 * Shopify sync tool. On success `req.user` is populated with JwtClaims.
 */
export async function authenticateApiWrite(
  this: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const m = /^Bearer\s+(zt_[A-Za-z0-9]+)$/.exec(req.headers.authorization ?? '');
  if (m) {
    const row = this.db
      .prepare('SELECT id, accountId, scopes FROM api_tokens WHERE tokenHash = ? AND revokedAt IS NULL')
      .get(sha256(m[1])) as { id: string; accountId: string; scopes: string } | undefined;
    if (!row) return reply.code(401).send({ error: 'Invalid or revoked API token' });
    const scopes = String(row.scopes || '').split(/[\s,]+/).filter(Boolean);
    if (!scopes.includes('data:write')) return reply.code(403).send({ error: 'Token lacks the data:write scope' });
    this.db.prepare('UPDATE api_tokens SET lastUsedAt = ? WHERE id = ?').run(Date.now(), row.id);
    // role 'admin' marks the token as write-capable; there is no restricted-member scoping here.
    req.user = { sub: `token:${row.id}`, accountId: row.accountId, role: 'admin' } as JwtClaims;
    return;
  }
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Not authenticated' });
  }
  const claims = req.user as JwtClaims;
  if (claims.role === 'member') {
    return reply.code(403).send({ error: 'Catalog writes require an owner/admin or a data:write token' });
  }
}
