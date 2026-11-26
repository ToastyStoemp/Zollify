import { createSign } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { NotificationInput } from './notifications';

/**
 * Push notifications to the Android app through Firebase Cloud Messaging.
 *
 * Android freezes an app in the background, so the app cannot pick up a note over its live
 * channel and post it itself: Google's push service has to bring it. Each signed-in app sends
 * its FCM token (PUT /api/devices/me/push); every note the bell gets also goes, as a push, to
 * the account's devices that would pop it up on screen - every note above the low level, and
 * low ones only to devices that asked for their kind (Settings → This device → Notifications).
 *
 * The server sends with a Firebase service account: the JSON key from Firebase → Project
 * settings → Service accounts, set as FCM_SERVICE_ACCOUNT (Settings → Server admin, or the
 * environment). It is read when a note goes out, so setting it needs no restart. Without it
 * nothing is pushed and the app works as before.
 */

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/** The service account in a pasted key file; null when it is not one. */
export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw?.trim()) return null;
  try {
    const j = JSON.parse(raw) as Partial<ServiceAccount>;
    return j.project_id && j.client_email && j.private_key?.includes('PRIVATE KEY') ? { project_id: j.project_id, client_email: j.client_email, private_key: j.private_key } : null;
  } catch {
    return null;
  }
}

const b64url = (s: string | Buffer): string => Buffer.from(s).toString('base64url');
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The signed assertion Google trades for an access token (RFC 7523), valid an hour. */
export function assertion(sa: ServiceAccount, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(sa.private_key);
  return `${head}.${body}.${b64url(sig)}`;
}

const RANK: Record<string, number> = { member: 0, admin: 1, owner: 2 };

/** A device that gets this note as a push: signed in, allowed to see it, and asking for it. */
export function pushTargets(db: Database.Database, accountId: string, n: Pick<NotificationInput, 'kind' | 'level' | 'minRole'>, now = Date.now()): { id: string; token: string }[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.pushToken AS token, d.notifyKinds, u.role FROM devices d JOIN users u ON u.id = d.userId
       WHERE d.accountId = ? AND d.pushToken IS NOT NULL
         AND EXISTS (SELECT 1 FROM refresh_tokens r WHERE r.deviceId = d.id AND r.userId = d.userId AND r.expiresAt > ? AND r.rotatedAt IS NULL)`,
    )
    .all(accountId, now) as { id: string; token: string; notifyKinds: string | null; role: string }[];
  const low = (n.level ?? 'normal') === 'low';
  return rows
    .filter((d) => (RANK[d.role] ?? 0) >= (RANK[n.minRole ?? 'member'] ?? 0))
    .filter((d) => !low || (!!n.kind && (JSON.parse(d.notifyKinds ?? '[]') as string[]).includes(n.kind)))
    .map(({ id, token }) => ({ id, token }));
}

export interface Push {
  /** Whether a service account is set, so anything is pushed at all. */
  configured(): boolean;
  /** Sends the note to the devices that should get it; never throws. */
  send(accountId: string, n: NotificationInput): Promise<void>;
  /** Sends a note to one device's token; whether Google took it. */
  sendTo(device: { id: string; token: string }, n: NotificationInput): Promise<boolean>;
}

export function createPush(
  db: Database.Database,
  deps: { config?: () => string | undefined; fetch?: typeof fetch; log?: (err: unknown) => void } = {},
): Push {
  const config = deps.config ?? (() => process.env.FCM_SERVICE_ACCOUNT);
  const http = deps.fetch ?? fetch;
  let cached: { email: string; token: string; until: number } | null = null;

  async function accessToken(sa: ServiceAccount): Promise<string> {
    if (cached && cached.email === sa.client_email && cached.until > Date.now()) return cached.token;
    const res = await http(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion(sa) }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !json.access_token) throw new Error(`Firebase sign-in failed: ${json.error_description ?? res.status}`);
    cached = { email: sa.client_email, token: json.access_token, until: Date.now() + ((json.expires_in ?? 3600) - 120) * 1000 };
    return cached.token;
  }

  const forget = db.prepare('UPDATE devices SET pushToken = NULL WHERE id = ? AND pushToken = ?');

  async function one(sa: ServiceAccount, auth: string, t: { id: string; token: string }, n: NotificationInput): Promise<boolean> {
    const res = await http(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: t.token,
          notification: { title: n.title.slice(0, 160), body: (n.body ?? '').slice(0, 1000) },
          data: { link: n.link ?? '', kind: n.kind ?? '' },
          android: { priority: 'HIGH' },
        },
      }),
    });
    if (res.ok) return true;
    const err = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string } };
    // The app was uninstalled or the token replaced: stop sending to it.
    if (res.status === 404 || err.error?.status === 'NOT_FOUND' || err.error?.status === 'UNREGISTERED') forget.run(t.id, t.token);
    else deps.log?.(new Error(`Push to a device failed: ${err.error?.message ?? res.status}`));
    return false;
  }

  return {
    configured: () => !!parseServiceAccount(config()),
    async send(accountId, n) {
      const sa = parseServiceAccount(config());
      if (!sa) return;
      try {
        const targets = pushTargets(db, accountId, n);
        if (!targets.length) return;
        const auth = await accessToken(sa);
        await Promise.all(targets.map((t) => one(sa, auth, t, n)));
      } catch (err) {
        deps.log?.(err);
      }
    },
    async sendTo(device, n) {
      const sa = parseServiceAccount(config());
      if (!sa) return false;
      try {
        return await one(sa, await accessToken(sa), device, n);
      } catch (err) {
        deps.log?.(err);
        return false;
      }
    },
  };
}
