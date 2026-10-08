import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { bumpMetric } from './db';
import { deviceTrusted, issueDeviceTrust, issueTokens, sha256, touchDevice, type UserRow } from './auth';
import { lookupGeo, parseDevice } from './session-info';

/**
 * Sign in with Google. Google refuses OAuth inside an embedded WebView, so
 * the Android app cannot show Google's page itself: the sign-in happens in
 * the device's own browser and the result comes back the way sign-in by QR
 * does (see device-link.ts) - the waiting app polls with a secret only it
 * holds. The web does the same dance with a redirect instead of a poll loop,
 * so there is one flow, not two.
 *
 *   begin   the app registers a waiting sign-in and gets the start address
 *   start   (opened in a browser) sends the person to Google
 *   callback Google sends them back with a code; the server swaps it for the
 *            ID token and remembers who they are on the waiting row
 *   poll    the app asks what became of it: pending, needs an invite code
 *            (unknown person - the invite still decides who may join), needs
 *            the authenticator code (the account has 2FA), or approved with
 *            tokens - once, like the QR flow
 *
 * The ID token comes straight from Google over TLS in a server-to-server
 * exchange, which is the one case where Google's own guidance says its
 * signature need not be checked; the claims (issuer, audience, expiry,
 * verified email) are. A person who signs up this way has no password: the
 * users row carries an unusable hash, so the password form cannot reach it.
 *
 * Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from a web OAuth client in
 * Google Cloud, with PUBLIC_ORIGIN/api/auth/google/callback as its redirect
 * URI. Without them the buttons stay hidden (GET /api/auth/providers).
 */

export const GOOGLE_PASSWORD = '!google'; // never a valid argon2 hash: argon2.verify rejects it

const LINK_TTL_MS = 10 * 60_000;
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const BeginBody = z.object({
  deviceId: z.string().max(128).optional(),
  deviceName: z.string().max(128).optional(),
  flavor: z.string().max(32).optional(),
});
const PollBody = z.object({
  id: z.string().uuid(),
  pollSecret: z.string().min(32).max(128),
  inviteCode: z.string().max(64).optional(),
  accountName: z.string().max(120).optional(),
  code: z.string().max(32).optional(),
  trustToken: z.string().max(200).optional(),
  rememberDevice: z.boolean().optional(),
});

interface LinkRow {
  id: string;
  pollHash: string;
  stateHash: string;
  status: 'pending' | 'verified' | 'failed' | 'consumed';
  googleSub: string | null;
  email: string | null;
  failure: string | null;
  deviceId: string | null;
  deviceName: string | null;
  flavor: string | null;
  ip: string | null;
  device: string | null;
  geo: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface GoogleAuthDeps {
  signUp(req: FastifyRequest, input: { email: string; passwordHash: string; inviteCode?: string; accountName?: string; googleSub?: string }): { ok: true; user: UserRow } | { ok: false; code: number; error: string };
  has2fa(user: UserRow): boolean;
  secondFactor(user: UserRow, code: string | undefined): 'ok' | 'recovery' | 'missing' | 'invalid';
  rateLimit: { config: { rateLimit: { max: number; timeWindow: string } } };
}

export const googleConfigured = (): boolean => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

/** PUBLIC_ORIGIN when set; else what Fastify derives, which honours forwarded headers only from a trusted proxy. */
function publicOrigin(req: FastifyRequest): string {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.trim().replace(/\/+$/, '');
  return `${req.protocol}://${req.host}`;
}

interface IdClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  exp?: number;
}

/** The claims of an ID token Google just handed us, or why they are no good. */
export function readIdToken(idToken: string, clientId: string, now = Date.now()): { ok: true; sub: string; email: string } | { ok: false; error: string } {
  const parts = idToken.split('.');
  if (parts.length !== 3) return { ok: false, error: 'Google returned something that is not an ID token.' };
  let claims: IdClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as IdClaims;
  } catch {
    return { ok: false, error: 'Google returned an unreadable ID token.' };
  }
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') return { ok: false, error: 'The ID token is not from Google.' };
  if (claims.aud !== clientId) return { ok: false, error: 'The ID token was issued for a different app.' };
  if (!claims.exp || claims.exp * 1000 < now) return { ok: false, error: 'The ID token has expired.' };
  if (!claims.sub || !claims.email) return { ok: false, error: 'Google did not say who signed in.' };
  if (claims.email_verified !== true) return { ok: false, error: 'This Google account has no verified email address.' };
  return { ok: true, sub: claims.sub, email: claims.email.toLowerCase() };
}

/** What the browser shows once Google has sent the person back - the app, not this page, finishes the sign-in. */
function donePage(ok: boolean, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Zollify</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1419;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0;padding:1rem}main{max-width:22rem;text-align:center}h1{font-size:1.25rem}p{color:#9aa4b2}</style></head>
<body><main><h1>${ok ? 'Signed in with Google' : 'Could not sign in with Google'}</h1><p>${esc(message)}</p></main></body></html>`;
}

export function registerGoogleAuthRoutes(app: FastifyInstance, db: Database.Database, deps: GoogleAuthDeps): void {
  const POLL_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
  const sweep = (): void => {
    db.prepare('DELETE FROM google_links WHERE expiresAt < ?').run(Date.now());
  };
  const notConfigured = (reply: FastifyReply) => reply.code(404).send({ error: 'Sign in with Google is not set up on this server.' });

  /** Which sign-in methods the login screen may offer, besides a password. */
  app.get('/api/auth/providers', async () => ({ google: googleConfigured() }));

  app.post('/api/auth/google/begin', deps.rateLimit, async (req, reply) => {
    if (!googleConfigured()) return notConfigured(reply);
    const parsed = BeginBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    sweep();
    const id = randomUUID();
    const pollSecret = randomBytes(32).toString('base64url');
    const startSecret = randomBytes(24).toString('base64url');
    const now = Date.now();
    db.prepare(
      `INSERT INTO google_links (id, pollHash, stateHash, status, deviceId, deviceName, flavor, ip, device, geo, createdAt, expiresAt)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, sha256(pollSecret), sha256(startSecret), parsed.data.deviceId || null, parsed.data.deviceName || null, parsed.data.flavor || null, req.ip, parseDevice(req.headers['user-agent']), await lookupGeo(req.ip), now, now + LINK_TTL_MS);
    const url = `${publicOrigin(req)}/api/auth/google/start?id=${encodeURIComponent(id)}&s=${encodeURIComponent(startSecret)}`;
    return { id, pollSecret, url, expiresAt: now + LINK_TTL_MS };
  });

  /** Opened in a browser: off to Google. The start secret keeps a stranger from attaching their own Google account to a waiting app. */
  app.get<{ Querystring: { id?: string; s?: string } }>('/api/auth/google/start', async (req, reply) => {
    if (!googleConfigured()) return notConfigured(reply);
    const { id = '', s = '' } = req.query;
    const row = db.prepare("SELECT id FROM google_links WHERE id = ? AND stateHash = ? AND status = 'pending' AND expiresAt > ?").get(id, sha256(s), Date.now());
    if (!row) return reply.code(410).type('text/html').send(donePage(false, 'This sign-in has expired. Go back to Zollify and try again.'));
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: `${publicOrigin(req)}/api/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email',
      state: `${id}.${s}`,
      prompt: 'select_account',
    });
    return reply.redirect(`${AUTH_URL}?${params}`);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/auth/google/callback', async (req, reply) => {
    if (!googleConfigured()) return notConfigured(reply);
    const [id = '', s = ''] = String(req.query.state ?? '').split('.');
    const row = db.prepare("SELECT * FROM google_links WHERE id = ? AND stateHash = ? AND status = 'pending' AND expiresAt > ?").get(id, sha256(s), Date.now()) as LinkRow | undefined;
    if (!row) return reply.code(410).type('text/html').send(donePage(false, 'This sign-in has expired. Go back to Zollify and try again.'));

    const fail = (message: string) => {
      db.prepare("UPDATE google_links SET status = 'failed', failure = ? WHERE id = ?").run(message, id);
      return finish(false, message);
    };
    const finish = (ok: boolean, message: string) => {
      // The web app finishes in the tab it started in; the Android app is waiting behind the browser.
      if (!row.flavor || row.flavor === 'web') return reply.redirect(`${publicOrigin(req)}/#/login?google=${encodeURIComponent(id)}`);
      return reply.type('text/html').send(donePage(ok, ok ? 'Go back to the Zollify app to finish.' : `${message} Go back to the Zollify app and try again.`));
    };

    if (req.query.error || !req.query.code) return fail(req.query.error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google did not complete the sign-in.');
    let idToken = '';
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: `${publicOrigin(req)}/api/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });
      const body = (await res.json()) as { id_token?: string; error_description?: string; error?: string };
      if (!res.ok || !body.id_token) {
        req.log.warn({ status: res.status, error: body.error }, 'google token exchange failed');
        return fail('Google did not accept the sign-in.');
      }
      idToken = body.id_token;
    } catch (err) {
      req.log.warn({ err }, 'google token exchange failed');
      return fail('Could not reach Google.');
    }
    const who = readIdToken(idToken, process.env.GOOGLE_CLIENT_ID!);
    if (!who.ok) return fail(who.error);
    db.prepare("UPDATE google_links SET status = 'verified', googleSub = ?, email = ? WHERE id = ? AND status = 'pending'").run(who.sub, who.email, id);
    return finish(true, '');
  });

  app.post('/api/auth/google/poll', POLL_LIMIT, async (req, reply) => {
    const parsed = PollBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    const p = parsed.data;
    const now = Date.now();
    const row = db.prepare('SELECT * FROM google_links WHERE id = ? AND pollHash = ?').get(p.id, sha256(p.pollSecret)) as LinkRow | undefined;
    if (!row || row.expiresAt <= now || row.status === 'consumed') return reply.code(410).send({ status: 'expired', error: 'This sign-in has expired. Try again.' });
    if (row.status === 'failed') {
      db.prepare('DELETE FROM google_links WHERE id = ?').run(row.id);
      return reply.code(403).send({ status: 'failed', error: row.failure ?? 'Google sign-in failed.' });
    }
    if (row.status === 'pending') return { status: 'pending', expiresAt: row.expiresAt };

    // Verified: Google vouched for an email. Known by Google id, else by that
    // email (a person who had a password and now uses Google), else new.
    let user = db.prepare('SELECT * FROM users WHERE googleSub = ?').get(row.googleSub) as UserRow | undefined;
    if (!user) user = db.prepare('SELECT * FROM users WHERE email = ?').get(row.email) as UserRow | undefined;
    let deviceTrustToken: string | undefined;
    if (user) {
      if (deps.has2fa(user) && !deviceTrusted(db, user.id, row.deviceId ?? undefined, p.trustToken)) {
        const second = deps.secondFactor(user, p.code);
        if (second === 'missing') return { status: 'needs2fa', email: row.email };
        if (second === 'invalid') return reply.code(401).send({ status: 'needs2fa', email: row.email, error: 'Invalid authenticator code.' });
      }
      if (deps.has2fa(user) && p.rememberDevice && row.deviceId) deviceTrustToken = issueDeviceTrust(db, user.id, row.deviceId);
    } else {
      if (!p.inviteCode?.trim()) return { status: 'needsInvite', email: row.email };
      const made = deps.signUp(req, { email: row.email!, passwordHash: GOOGLE_PASSWORD, inviteCode: p.inviteCode, accountName: p.accountName, googleSub: row.googleSub! });
      if (!made.ok) return reply.code(made.code).send({ status: 'needsInvite', email: row.email, error: made.error });
      user = made.user;
    }

    // Single use: only the poll that flips verified → consumed gets tokens.
    const claimed = db.prepare("UPDATE google_links SET status = 'consumed' WHERE id = ? AND status = 'verified'").run(row.id);
    if (claimed.changes !== 1) return reply.code(410).send({ status: 'expired', error: 'This sign-in has expired. Try again.' });
    db.prepare('DELETE FROM google_links WHERE id = ?').run(row.id);
    db.prepare('UPDATE users SET lastLoginAt = ?, googleSub = COALESCE(googleSub, ?) WHERE id = ?').run(now, row.googleSub, user.id);
    touchDevice(db, user.accountId, user.id, row.deviceId ?? undefined, row.deviceName ?? undefined);
    bumpMetric(db, user.accountId, 'logins');
    const tokens = await issueTokens(app, db, user, { deviceId: row.deviceId, deviceName: row.deviceName, flavor: row.flavor, ip: row.ip, device: row.device, geo: row.geo });
    return { status: 'approved', ...tokens, ...(deviceTrustToken ? { deviceTrustToken } : {}) };
  });
}
