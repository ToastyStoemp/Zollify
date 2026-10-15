import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { JwtClaims } from './auth';
import { makeSecretBox } from './secretbox';

/**
 * Every setting the server reads from its environment, in one list: what it
 * is, its default, and whether the server owner may change it from Settings →
 * Server admin instead of the .env file.
 *
 * Editable ones are read where they are used (`process.env.X` at the moment of
 * the request), so a value saved here is written into `process.env` and takes
 * effect at once - except the few marked `restart`, read when the server
 * starts. The rest are deployment wiring (paths, ports, secrets the server
 * starts with, tuning read once at start-up): those stay in the environment,
 * and the panel only shows them.
 *
 * A value set in the real environment always wins: the deploy config is the
 * operator's, and the panel shows it as locked rather than quietly overriding
 * it. Secrets are stored encrypted and never sent back to a browser.
 */

export type SettingKind = 'text' | 'secret' | 'multiline' | 'bool' | 'number' | 'select';

export interface SettingDef {
  key: string;
  group: string;
  label: string;
  hint: string;
  kind: SettingKind;
  /** May the server owner set it from the panel. */
  editable: boolean;
  /** Read when the server starts: a change applies after a restart. */
  restart?: boolean;
  /** Never shown or sent back, even when its kind is multiline. */
  secret?: boolean;
  options?: string[];
  /** What applies when nothing is set, for the panel to show. */
  fallback?: string;
  /** Why a value cannot be saved, or null. */
  check?: (v: string) => string | null;
}

const https = (what: string) => (v: string) => (/^https:\/\/[^\s/]+(\/\S*)?$/.test(v) ? null : `${what} must be an https address.`);
const between = (min: number, max: number) => (v: string) => (/^\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? null : `A whole number from ${min} to ${max}.`);

export const SERVER_SETTINGS: SettingDef[] = [
  // ── Server ───────────────────────────────────────────────────────────────
  { key: 'PUBLIC_ORIGIN', group: 'Server', label: 'Public address', kind: 'text', editable: true, hint: 'The address people reach this server at, used in emails, QR codes and payment redirects. Leave empty to use what the proxy reports.', check: (v) => (/^https?:\/\/[^\s/]+$/.test(v) ? null : 'Just the address, like https://pos.example.com - no path.') },
  { key: 'REGISTRATION_OPEN', group: 'Server', label: 'Anyone may create an account', kind: 'bool', editable: true, fallback: 'off', hint: 'Off: new accounts need an invite code. On: anyone who finds the server can sign up.' },
  { key: 'ZOLLIFY_ACCOUNT_STORAGE_MB', group: 'Server', label: 'Storage per account (MB)', kind: 'number', editable: true, fallback: '500', hint: 'Attachments one account may keep in total: event files, ledger invoices, sourcing files.', check: between(10, 100_000) },
  { key: 'ZOLLIFY_EVENT_FILES_MAX', group: 'Server', label: 'Files per event', kind: 'number', editable: true, fallback: '20', hint: 'How many files one event may hold.', check: between(1, 500) },
  { key: 'WEBHOOK_ALLOW_PRIVATE', group: 'Server', label: 'Webhooks may reach the local network', kind: 'bool', editable: true, fallback: 'off', hint: 'Only for a LAN-only install. On lets webhooks post to addresses inside your own network and over plain http - anyone with an admin account could then make the server call your internal services.' },

  // ── Sign-in ──────────────────────────────────────────────────────────────
  { key: 'GOOGLE_CLIENT_ID', group: 'Sign in with Google', label: 'Client ID', kind: 'text', editable: true, hint: 'A "Web application" OAuth client from Google Cloud → APIs & Services → Credentials, with PUBLIC_ORIGIN/api/auth/google/callback as redirect URI. Both fields set shows the Google button.', check: (v) => (/\.apps\.googleusercontent\.com$/.test(v) ? null : 'A Google client id ends in .apps.googleusercontent.com.') },
  { key: 'GOOGLE_CLIENT_SECRET', group: 'Sign in with Google', label: 'Client secret', kind: 'secret', editable: true, hint: 'From the same OAuth client.' },

  // ── Email ────────────────────────────────────────────────────────────────
  { key: 'SMTP_URL', group: 'Email', label: 'SMTP server', kind: 'secret', editable: true, restart: true, hint: 'Like smtps://user:password@smtp.example.com:465. Without it (and a sender) nothing is emailed; in-app notifications work either way.', check: (v) => (/^smtps?:\/\/\S+$/.test(v) ? null : 'Starts with smtp:// or smtps://.') },
  { key: 'MAIL_FROM', group: 'Email', label: 'Sender', kind: 'text', editable: true, restart: true, hint: 'Like "Zollify <pos@example.com>".', check: (v) => (/@/.test(v) ? null : 'An email address.') },

  // ── Card payments ────────────────────────────────────────────────────────
  { key: 'SUMUP_AFFILIATE_KEY', group: 'SumUp', label: 'Affiliate key', kind: 'text', editable: true, hint: "Made once in a SumUp account (Settings → For Developers → Toolkit → Affiliate Keys) for the app id below. Merchants then only sign in with their own SumUp login." },
  { key: 'SUMUP_APP_ID', group: 'SumUp', label: 'App id of the affiliate key', kind: 'text', editable: true, fallback: 'com.phuongninjin.zollify', hint: 'Only for a build with its own app id.', check: (v) => (/^[a-z][\w]*(\.[\w]+)+$/i.test(v) ? null : 'Like com.example.app.') },
  { key: 'SUMUP_CLIENT_ID', group: 'SumUp', label: 'OAuth client ID (Solo over the internet)', kind: 'text', editable: true, hint: 'From SumUp → For Developers → OAuth, with redirect URL PUBLIC_ORIGIN/p/pos/sumup/authorized.' },
  { key: 'SUMUP_CLIENT_SECRET', group: 'SumUp', label: 'OAuth client secret', kind: 'secret', editable: true, hint: 'From the same OAuth app.' },
  { key: 'POYNT_APPLICATION_ID', group: 'Nexi SmartPOS', label: 'Poynt application id', kind: 'text', editable: true, hint: 'Optional: one Poynt cloud app offered to accounts without their own (each can still add theirs under Payments).', check: (v) => (/^urn:aid:[0-9a-f-]{36}$/i.test(v) ? null : 'Looks like urn:aid:…') },
  { key: 'POYNT_PRIVATE_KEY', group: 'Nexi SmartPOS', label: 'Private key (.pem)', kind: 'multiline', secret: true, editable: true, hint: 'The key downloaded with the app. Stored encrypted.', check: (v) => (/PRIVATE KEY/.test(v) ? null : 'Paste the whole .pem, from -----BEGIN to -----END.') },
  { key: 'POYNT_PRIVATE_KEY_FILE', group: 'Nexi SmartPOS', label: 'Private key file', kind: 'text', editable: false, hint: 'A path to the .pem on the server, instead of pasting the key. Environment only.' },
  { key: 'POYNT_REGION', group: 'Nexi SmartPOS', label: 'Region', kind: 'select', options: ['eu', 'us'], editable: true, fallback: 'eu', hint: 'eu for Nexi in Europe.' },
  { key: 'POYNT_AUTH_PUBLIC_KEY', group: 'Nexi SmartPOS', label: "Poynt's public key", kind: 'multiline', editable: true, hint: 'Optional: checks the signature on authorisation codes.' },

  // ── Bookkeeping ──────────────────────────────────────────────────────────
  { key: 'ZOLLIFY_ECONOMIC_APP_SECRET', group: 'e-conomic', label: 'App secret token', kind: 'secret', editable: true, hint: "This server's own token as a registered e-conomic developer. Each store then connects its agreement under Settings → e-conomic." },

  // ── Feedback ─────────────────────────────────────────────────────────────
  { key: 'FEEDBACK_DISCORD_WEBHOOK', group: 'Feedback & community', label: 'Discord webhook for feedback', kind: 'secret', editable: true, hint: 'Channel settings → Integrations → Webhooks. Each piece of feedback is also posted there: message, screen and version only.', check: (v) => (/^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(v) ? null : 'A Discord webhook address: https://discord.com/api/webhooks/…') },
  { key: 'DISCORD_INVITE_URL', group: 'Feedback & community', label: 'Discord invite link', kind: 'text', editable: true, hint: 'Adds a Discord button next to Send feedback.', check: (v) => (/^https:\/\/(?:discord\.gg\/[\w-]+|(?:www\.)?discord\.com\/invite\/[\w-]+)\/?$/.test(v) ? null : 'A discord.gg or discord.com/invite link.') },

  // ── Deployment: the environment only ────────────────────────────────────
  { key: 'ZOLLIFY_DATA_DIR', group: 'Deployment', label: 'Data folder', kind: 'text', editable: false, fallback: './data', hint: 'SQLite, uploads and the minted signing secret.' },
  { key: 'ZOLLIFY_JWT_SECRET', group: 'Deployment', label: 'Signing secret', kind: 'secret', editable: false, fallback: 'minted on first start, kept in the data folder', hint: 'Signs sessions and encrypts stored keys. Changing it signs everyone out and makes stored keys unreadable.' },
  { key: 'PORT', group: 'Deployment', label: 'Port', kind: 'number', editable: false, fallback: '8787', hint: '' },
  { key: 'HOST', group: 'Deployment', label: 'Listen address', kind: 'text', editable: false, fallback: '0.0.0.0', hint: '' },
  { key: 'ZOLLIFY_REQUIRE_HTTPS', group: 'Deployment', label: 'Require https', kind: 'bool', editable: false, fallback: 'on', hint: 'Off only for local http development.' },
  { key: 'ZOLLIFY_TRUST_PROXY', group: 'Deployment', label: 'Behind a reverse proxy', kind: 'text', editable: false, fallback: 'on', hint: 'Trust x-forwarded-* headers (or the number of proxy hops).' },
  { key: 'ZOLLIFY_ALLOWED_ORIGINS', group: 'Deployment', label: 'Allowed origins', kind: 'text', editable: false, fallback: 'same origin only', hint: 'Comma-separated exact origins for cross-origin requests.' },
  { key: 'ZOLLIFY_WEB_DIST', group: 'Deployment', label: 'Built web app', kind: 'text', editable: false, fallback: 'not served (development)', hint: '' },
  { key: 'ZOLLIFY_MODULE_STORE', group: 'Deployment', label: 'Module store', kind: 'text', editable: false, fallback: './modules-store', hint: '' },
  { key: 'ZOLLIFY_APK_DIR', group: 'Deployment', label: 'Android app folder', kind: 'text', editable: false, fallback: './apk', hint: 'Where npm run android:pack puts the APKs the app updates itself from.' },
  { key: 'ZOLLIFY_SHELL_STORE', group: 'Deployment', label: 'Shell update store', kind: 'text', editable: false, fallback: './shell-store', hint: '' },
  { key: 'ZOLLIFY_DEPLOY_DIR', group: 'Deployment', label: 'Deploy request folder', kind: 'text', editable: false, fallback: 'off', hint: 'Watched by the host for Update server.' },
  { key: 'LOG_LEVEL', group: 'Deployment', label: 'Log level', kind: 'text', editable: false, fallback: 'info', hint: '' },
  { key: 'OWNER_EMAIL', group: 'Deployment', label: 'First owner email', kind: 'text', editable: false, hint: 'With OWNER_PASSWORD, creates the server owner on first start.' },
  { key: 'OWNER_PASSWORD', group: 'Deployment', label: 'First owner password', kind: 'secret', editable: false, hint: 'Only used once, on first start.' },

  // ── Security tuning, read once at start-up ──────────────────────────────
  { key: 'REQUIRE_CAPTCHA', group: 'Security tuning', label: 'Captcha on sign-in and sign-up', kind: 'bool', editable: false, fallback: 'on', hint: 'Off only in tests.' },
  { key: 'CAPTCHA_BITS', group: 'Security tuning', label: 'Captcha strength (bits)', kind: 'number', editable: false, fallback: '18', hint: '' },
  { key: 'SIGNUP_CAPTCHA_BITS', group: 'Security tuning', label: 'Workshop sign-up captcha (bits)', kind: 'number', editable: false, fallback: '15', hint: '' },
  { key: 'RECEIPT_CAPTCHA_BITS', group: 'Security tuning', label: 'Online receipt captcha (bits)', kind: 'number', editable: false, fallback: '15', hint: '' },
  { key: 'RECEIPT_LOOKUPS_PER_MIN', group: 'Security tuning', label: 'Receipt lookups per minute', kind: 'number', editable: false, fallback: '20', hint: '' },
  { key: 'RECEIPT_TTL_DAYS', group: 'Security tuning', label: 'Online receipts kept (days)', kind: 'number', editable: false, fallback: '400', hint: '' },
  { key: 'AUTH_RATE_LIMIT_MAX', group: 'Security tuning', label: 'Sign-in attempts per minute', kind: 'number', editable: false, fallback: '20', hint: '' },
  { key: 'REFRESH_RATE_LIMIT_MAX', group: 'Security tuning', label: 'Session renewals per minute', kind: 'number', editable: false, fallback: '60', hint: '' },
  { key: 'PIN_RATE_LIMIT_MAX', group: 'Security tuning', label: 'Till PIN attempts per minute', kind: 'number', editable: false, fallback: '30', hint: '' },
  { key: 'REFRESH_TTL_DAYS', group: 'Security tuning', label: 'Sign-in lasts (days)', kind: 'number', editable: false, fallback: '30', hint: '' },
  { key: 'REFRESH_TTL_DAYS_CARBON', group: 'Security tuning', label: 'Sign-in on a Carbon lasts (days)', kind: 'number', editable: false, fallback: '90', hint: '' },
  { key: 'DEVICE_TRUST_DAYS', group: 'Security tuning', label: 'Trusted device for 2FA (days)', kind: 'number', editable: false, fallback: '60', hint: '' },
  { key: 'GEO_LOOKUP', group: 'Security tuning', label: 'Look up the city of each sign-in', kind: 'bool', editable: false, fallback: 'off', hint: 'Sends sign-in IP addresses to a geolocation service.' },
  { key: 'ZOLLIFY_MAX_BODY_MB', group: 'Security tuning', label: 'Request size limit (MB)', kind: 'number', editable: false, fallback: '8', hint: '' },
];

const BY_KEY = new Map(SERVER_SETTINGS.map((s) => [s.key, s]));
const isSecret = (s: SettingDef): boolean => s.kind === 'secret' || !!s.secret;

export interface SettingView {
  key: string;
  group: string;
  label: string;
  hint: string;
  kind: SettingKind;
  secret: boolean;
  editable: boolean;
  restart: boolean;
  options?: string[];
  fallback?: string;
  /** Where the value in force comes from. */
  source: 'environment' | 'panel' | 'default';
  /** The value, for a setting that is not secret; null otherwise. */
  value: string | null;
}

const PatchSchema = z.object({
  set: z.record(z.string(), z.string().max(20_000)).default({}),
  clear: z.array(z.string()).default([]),
});

/**
 * The server's stored settings. `apply()` runs once at start-up, before
 * anything reads them, and copies stored values into `process.env` for every
 * key the real environment leaves unset.
 */
export function createServerSettings(db: Database.Database, jwtSecret: string) {
  const box = makeSecretBox(jwtSecret, 'zollify-server-settings-v1');
  // Captured before anything is applied: these came from the deployment, and stay its.
  const fromEnv = new Set(SERVER_SETTINGS.map((s) => s.key).filter((k) => (process.env[k] ?? '') !== ''));
  const stored = (): Map<string, string> => {
    const rows = db.prepare('SELECT key, value FROM server_settings').all() as { key: string; value: string }[];
    const out = new Map<string, string>();
    for (const r of rows) {
      const def = BY_KEY.get(r.key);
      if (!def?.editable) continue;
      try {
        out.set(r.key, box.decrypt<string>(r.value));
      } catch {
        /* unreadable after a signing-secret change: treated as unset */
      }
    }
    return out;
  };

  function apply(): void {
    for (const [k, v] of stored()) if (!fromEnv.has(k)) process.env[k] = v;
  }

  function list(): SettingView[] {
    const saved = stored();
    return SERVER_SETTINGS.map((s) => {
      const source: SettingView['source'] = fromEnv.has(s.key) ? 'environment' : saved.has(s.key) ? 'panel' : 'default';
      const current = source === 'default' ? null : (process.env[s.key] ?? null);
      const secret = isSecret(s);
      return {
        key: s.key,
        group: s.group,
        label: s.label,
        hint: s.hint,
        kind: s.kind,
        secret,
        editable: s.editable && !fromEnv.has(s.key),
        restart: !!s.restart,
        ...(s.options ? { options: s.options } : {}),
        ...(s.fallback ? { fallback: s.fallback } : {}),
        source,
        value: secret ? null : current,
      };
    });
  }

  /** Saves and applies at once. A blank secret keeps what is stored; `clear` removes. */
  function save(patch: unknown): { problems: Record<string, string> } {
    const parsed = PatchSchema.safeParse(patch);
    if (!parsed.success) return { problems: { _: 'Check the settings.' } };
    const problems: Record<string, string> = {};
    const writes: [string, string | null][] = [];
    for (const [key, raw] of Object.entries(parsed.data.set)) {
      const def = BY_KEY.get(key);
      if (!def?.editable || fromEnv.has(key)) {
        problems[key] = 'Set in the server environment - change it there.';
        continue;
      }
      const value = def.kind === 'multiline' ? raw.trim() : raw.trim().replace(/\s+/g, ' ');
      if (def.kind === 'bool') {
        writes.push([key, value === '1' ? '1' : null]);
        continue;
      }
      if (!value) {
        // An empty secret field means "keep what is saved"; an empty plain field clears it.
        if (!isSecret(def)) writes.push([key, null]);
        continue;
      }
      if (def.kind === 'select' && !def.options?.includes(value)) {
        problems[key] = 'Pick one of the options.';
        continue;
      }
      const problem = def.check?.(value) ?? null;
      if (problem) problems[key] = problem;
      else writes.push([key, value]);
    }
    for (const key of parsed.data.clear) {
      const def = BY_KEY.get(key);
      if (def?.editable && !fromEnv.has(key)) writes.push([key, null]);
    }
    if (Object.keys(problems).length) return { problems };
    const put = db.prepare('INSERT INTO server_settings (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt');
    const del = db.prepare('DELETE FROM server_settings WHERE key = ?');
    db.transaction(() => {
      for (const [key, value] of writes) {
        if (value === null) {
          del.run(key);
          delete process.env[key];
        } else {
          put.run(key, box.encrypt(value), Date.now());
          process.env[key] = value;
        }
      }
    })();
    return { problems };
  }

  return { apply, list, save };
}
export type ServerSettings = ReturnType<typeof createServerSettings>;

export function registerServerSettingsRoutes(app: FastifyInstance, settings: ServerSettings): void {
  const requireOwner = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if ((req.user as JwtClaims).role !== 'owner') reply.code(403).send({ error: 'Owner only' });
  };
  const guard = { preHandler: [app.authenticate, requireOwner] };
  app.get('/api/admin/settings', guard, async () => ({ settings: settings.list() }));
  app.put('/api/admin/settings', guard, async (req, reply) => {
    const { problems } = settings.save(req.body);
    if (Object.keys(problems).length) return reply.code(400).send({ error: 'invalid_request', message: Object.values(problems)[0], problems });
    return { settings: settings.list() };
  });
}
