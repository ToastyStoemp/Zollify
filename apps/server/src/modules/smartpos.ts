import { createHash, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { reasonOf, reportProblem, resolveProblem, type ModuleContext, type PublicModuleContext, type SecretBox } from '@zollify/server-core';

/**
 * Nexi SmartPOS (Nets SmartPOS N950 in Denmark): card payments on the
 * terminal, started from the till over GoDaddy Poynt's Payment Bridge - the
 * platform SmartPOS runs on (docs.poynt.com, "Payment Bridge API").
 *
 * Each account brings its own Poynt cloud app (an application id and a
 * private key from the Poynt developer portal), saved under Settings →
 * Payments and kept encrypted, so every shop on a server has its own
 * terminals and settings. A server can also set one app for everybody in its
 * environment, used by accounts without their own. The owner then
 * authorises the app on their Nexi business once; Zollify lists its
 * terminals and sends a payment to the one a till picked. The terminal posts
 * the outcome back to a per-payment callback URL that only Poynt knows.
 *
 *   POST {api}/token          self-signed RS256 JWT → app access token
 *   GET  {api}/businesses/{biz}/stores   → stores and their devices
 *   POST {api}/cloudMessages  { businessId, storeId, deviceId, ttl, data }
 *        data = { callbackUrl, payment: "<json: amount (minor units), currency, referenceId, …>" }
 *        or     { action: "cancelPayment" }
 *   callback: { status: RECEIVED | STARTED | PROCESSED | CANCELED, referenceId, transactions: [...] }
 */

/** A Poynt cloud app: what the developer portal hands out. */
export interface PoyntApp {
  applicationId: string;
  privateKey: string;
  region: 'eu' | 'us';
  /** Poynt's key for the authorisation code, when known; checked if set. */
  authPublicKey: string | null;
}

export interface PoyntConfig extends PoyntApp {
  api: string;
  web: string;
  origin: string;
}

/** The server-wide app from the environment, for accounts without their own. Null when none is set. */
export function serverPoyntApp(env: NodeJS.ProcessEnv = process.env): PoyntApp | null {
  const applicationId = env.POYNT_APPLICATION_ID?.trim();
  const privateKey = env.POYNT_PRIVATE_KEY?.replace(/\\n/g, '\n') || (env.POYNT_PRIVATE_KEY_FILE ? safeRead(env.POYNT_PRIVATE_KEY_FILE) : '');
  if (!applicationId || !privateKey) return null;
  return {
    applicationId,
    privateKey,
    // Nexi's European terminals live in Poynt's EU datacenter; `us` for the rest.
    region: (env.POYNT_REGION ?? 'eu').toLowerCase() === 'us' ? 'us' : 'eu',
    authPublicKey: env.POYNT_AUTH_PUBLIC_KEY?.replace(/\\n/g, '\n') || null,
  };
}

/** Where the app talks to, and the https address Poynt calls back on. Null without a public https address. */
export function poyntConfig(app: PoyntApp, origin: string): PoyntConfig | null {
  const o = origin.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(o)) return null;
  const eu = app.region === 'eu';
  return { ...app, api: eu ? 'https://services-eu.poynt.net' : 'https://services.poynt.net', web: eu ? 'https://eu.poynt.net' : 'https://poynt.net', origin: o };
}

/** The address people reach this server at: PUBLIC_ORIGIN, else what Fastify derives (forwarded headers only from a trusted proxy). */
function originOf(req: FastifyRequest): string {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.trim().replace(/\/+$/, '');
  return `${req.protocol}://${req.host}`;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The self-signed JWT Poynt's token endpoint takes (RS256; iss = sub = the app id; aud = the API host). */
export function appAssertion(cfg: Pick<PoyntConfig, 'applicationId' | 'privateKey' | 'api'>, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: cfg.applicationId, sub: cfg.applicationId, aud: cfg.api, iat, exp: iat + 300, jti: randomUUID() }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(cfg.privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

/** The merchant's business from the authorisation code - after every check we can make (see the note in the route). */
export function businessFromCode(code: string, cfg: Pick<PoyntConfig, 'applicationId' | 'authPublicKey'>, now = Date.now()): string | null {
  const parts = code.split('.');
  if (parts.length !== 3) return null;
  let claims: { iss?: string; sub?: string; exp?: number; iat?: number; 'poynt.biz'?: string };
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (cfg.authPublicKey) {
    const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(createPublicKey(cfg.authPublicKey), Buffer.from(parts[2]!, 'base64url'));
    if (!ok) return null;
  }
  const t = Math.floor(now / 1000);
  if (!/^https:\/\/([a-z-]+\.)?poynt\.net$/.test(claims.iss ?? '')) return null;
  if (claims.sub !== cfg.applicationId) return null;
  if (!claims.exp || claims.exp < t || (claims.iat && claims.iat < t - 900)) return null;
  const biz = claims['poynt.biz'];
  return typeof biz === 'string' && /^[0-9a-f-]{36}$/i.test(biz) ? biz : null;
}

/** What a payment came to, from the terminal's callback. */
export function readCallback(body: unknown, expected: { amount: number; currency: string }): { state: 'started' | 'approved' | 'declined' | 'cancelled'; detail: PaymentDetail } {
  const b = (body ?? {}) as {
    status?: string;
    transactions?: {
      id?: string;
      status?: string;
      amounts?: { transactionAmount?: number; currency?: string };
      fundingSource?: { card?: { type?: string; numberLast4?: string } };
      processorResponse?: { approvalCode?: string; status?: string; statusMessage?: string };
    }[];
  };
  if (b.status === 'CANCELED') return { state: 'cancelled', detail: { message: 'Cancelled on the terminal.' } };
  if (b.status !== 'PROCESSED') return { state: 'started', detail: {} };
  const tx = b.transactions?.[0];
  const detail: PaymentDetail = {
    ...(tx?.id ? { transactionId: tx.id } : {}),
    ...(tx?.fundingSource?.card?.type ? { cardBrand: tx.fundingSource.card.type } : {}),
    ...(tx?.fundingSource?.card?.numberLast4 ? { last4: tx.fundingSource.card.numberLast4 } : {}),
    ...(tx?.processorResponse?.approvalCode ? { authCode: tx.processorResponse.approvalCode } : {}),
  };
  const okStatus = ['AUTHORIZED', 'CAPTURED', 'SETTLED'].includes(tx?.status ?? '');
  const okProcessor = (tx?.processorResponse?.status ?? 'Successful').toLowerCase() === 'successful';
  // Never more or less than was asked, never another currency: a sale is only paid for what it costs.
  const okAmount = tx?.amounts?.transactionAmount === expected.amount && (tx?.amounts?.currency ?? expected.currency).toUpperCase() === expected.currency;
  if (tx && okStatus && okProcessor && okAmount) return { state: 'approved', detail };
  const why = !tx ? 'No transaction came back.' : !okAmount ? 'The terminal reported a different amount.' : tx.processorResponse?.statusMessage || `Declined (${tx.status ?? 'unknown'}).`;
  return { state: 'declined', detail: { ...detail, message: why } };
}

export interface PaymentDetail {
  transactionId?: string;
  cardBrand?: string;
  last4?: string;
  authCode?: string;
  message?: string;
}

// ── Storage ─────────────────────────────────────────────────────────────────

export function migrateSmartpos(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS smartpos_links (
      accountId   TEXT PRIMARY KEY,
      businessId  TEXT NOT NULL UNIQUE,
      linkedAt    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smartpos_apps (
      accountId   TEXT PRIMARY KEY,
      app         TEXT NOT NULL,                 -- encrypted PoyntApp
      updatedAt   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smartpos_states (
      nonce       TEXT PRIMARY KEY,
      accountId   TEXT NOT NULL,
      expiresAt   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smartpos_payments (
      referenceId TEXT PRIMARY KEY,
      accountId   TEXT NOT NULL,
      businessId  TEXT NOT NULL,
      storeId     TEXT NOT NULL,
      deviceId    TEXT NOT NULL,
      amount      INTEGER NOT NULL,
      currency    TEXT NOT NULL,
      secretHash  TEXT NOT NULL,
      state       TEXT NOT NULL,
      detail      TEXT NOT NULL DEFAULT '{}',
      createdAt   INTEGER NOT NULL,
      updatedAt   INTEGER NOT NULL
    );
  `);
}

const linkOf = (db: Database.Database, accountId: string): string | null =>
  (db.prepare('SELECT businessId FROM smartpos_links WHERE accountId = ?').get(accountId) as { businessId: string } | undefined)?.businessId ?? null;

// ── Talking to Poynt ────────────────────────────────────────────────────────

export class PoyntClient {
  private token: { value: string; until: number } | null = null;
  constructor(private readonly cfg: PoyntConfig) {}

  /** Signs in as the app: proves the id and key belong together. */
  async signIn(): Promise<void> {
    await this.accessToken();
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const res = await fetch(`${this.cfg.api}/token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'api-version': '1.2', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grantType: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: appAssertion(this.cfg) }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { accessToken?: string; expiresIn?: number; message?: string };
    if (!res.ok || !body.accessToken) throw new Error(`Poynt sign-in failed (${res.status})${body.message ? `: ${body.message}` : ''}`);
    this.token = { value: body.accessToken, until: Date.now() + Math.max(60, (body.expiresIn ?? 3600) - 120) * 1000 };
    return body.accessToken;
  }

  async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${this.cfg.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        'api-version': '1.2',
        'poynt-request-id': randomUUID(),
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  /** The merchant's terminals: every device of every store of the business. */
  async terminals(businessId: string): Promise<Terminal[]> {
    const res = await this.call('GET', `/businesses/${encodeURIComponent(businessId)}/stores`);
    if (res.status >= 300) throw new Error(`Poynt refused the terminal list (${res.status}).`);
    const stores = (Array.isArray(res.json) ? res.json : ((res.json as { stores?: unknown[] } | null)?.stores ?? [])) as {
      id?: string;
      displayName?: string;
      storeDevices?: { deviceId?: string; serialNumber?: string; name?: string; status?: string; type?: string }[];
    }[];
    return stores.flatMap((s) =>
      (s.storeDevices ?? [])
        .filter((d) => d.deviceId && (!d.status || d.status === 'ACTIVATED') && (!d.type || d.type === 'TERMINAL'))
        .map((d) => ({ storeId: String(s.id), storeName: s.displayName ?? '', deviceId: String(d.deviceId), name: d.name || d.serialNumber || String(d.deviceId), serial: d.serialNumber ?? '' })),
    );
  }

  async send(msg: { businessId: string; storeId: string; deviceId: string; ttl: number; data: unknown }): Promise<void> {
    const res = await this.call('POST', '/cloudMessages', { ...msg, data: JSON.stringify(msg.data) });
    if (res.status >= 300) throw new Error(`Poynt did not take the request (${res.status}).`);
  }
}

export interface Terminal {
  storeId: string;
  storeName: string;
  deviceId: string;
  name: string;
  serial: string;
}

// ── Which app an account uses ───────────────────────────────────────────────

/** The account's own Poynt app, else the server's; and one client per app, so its token is reused. */
export function smartposApps(db: Database.Database, box: SecretBox) {
  const clients = new Map<string, PoyntClient>();
  const ownApp = (accountId: string): PoyntApp | null => {
    const row = db.prepare('SELECT app FROM smartpos_apps WHERE accountId = ?').get(accountId) as { app: string } | undefined;
    if (!row) return null;
    try {
      return box.decrypt<PoyntApp>(row.app);
    } catch {
      return null;
    }
  };
  return {
    ownApp,
    appOf: (accountId: string): PoyntApp | null => ownApp(accountId) ?? serverPoyntApp(),
    client(cfg: PoyntConfig): PoyntClient {
      const key = sha256(`${cfg.api}|${cfg.applicationId}|${cfg.privateKey}`);
      let c = clients.get(key);
      if (!c) clients.set(key, (c = new PoyntClient(cfg)));
      return c;
    },
    save(accountId: string, app: PoyntApp | null): void {
      if (app) {
        db.prepare('INSERT INTO smartpos_apps (accountId, app, updatedAt) VALUES (?, ?, ?) ON CONFLICT(accountId) DO UPDATE SET app = excluded.app, updatedAt = excluded.updatedAt').run(
          accountId,
          box.encrypt(app),
          Date.now(),
        );
      } else {
        db.prepare('DELETE FROM smartpos_apps WHERE accountId = ?').run(accountId);
      }
    },
  };
}
export type SmartposApps = ReturnType<typeof smartposApps>;

const AppBody = z.object({
  applicationId: z.string().trim().regex(/^urn:aid:[0-9a-f-]{36}$/i, 'The application id looks like urn:aid:… - copy it from the Poynt developer portal.'),
  /** Empty keeps the key already saved. */
  privateKey: z.string().max(10_000).default(''),
  region: z.enum(['eu', 'us']).default('eu'),
  authPublicKey: z.string().max(10_000).nullable().default(null),
});

// ── Routes ──────────────────────────────────────────────────────────────────

const PaymentBody = z.object({
  amount: z.number().int().positive().max(100_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reference: z.string().max(80).default(''),
  storeId: z.string().min(1).max(80),
  deviceId: z.string().min(1).max(80),
});
const TTL_S = 120;

/** The status Poynt answered with, from our own error text; else the class of failure. Never Poynt's words. */
const poyntReason = (err: unknown): string => {
  const status = /\((\d{3})\)/.exec(err instanceof Error ? err.message : '')?.[1];
  return reasonOf(status ? Number(status) : null, err);
};

export function registerSmartpos(app: FastifyInstance, ctx: ModuleContext, apps: SmartposApps): void {
  const { db } = ctx;
  const admin = (role: string) => role === 'owner' || role === 'admin';
  const off = { error: 'not_configured', message: 'Add your Poynt app under Settings → Payments first.' };
  const noOrigin = { error: 'not_configured', message: 'Nexi needs this server on a public https address to report payments back.' };
  /** The account's app and its client, or why there is none. */
  const setupOf = (req: FastifyRequest): { cfg: PoyntConfig; client: PoyntClient } | { error: typeof off } => {
    const own = apps.appOf(ctx.identity(req).accountId);
    if (!own) return { error: off };
    const cfg = poyntConfig(own, originOf(req));
    return cfg ? { cfg, client: apps.client(cfg) } : { error: noOrigin };
  };
  // The terminal list changes rarely; asked at most once a minute per business.
  const cache = new Map<string, { at: number; list: Terminal[] }>();
  const terminalsOf = async (client: PoyntClient, biz: string): Promise<Terminal[]> => {
    const hit = cache.get(biz);
    if (hit && Date.now() - hit.at < 60_000) return hit.list;
    const list = await client.terminals(biz);
    cache.set(biz, { at: Date.now(), list });
    return list;
  };

  app.get('/smartpos/status', async (req) => {
    const who = ctx.identity(req);
    const own = apps.ownApp(who.accountId);
    const origin = originOf(req);
    const https = /^https:\/\//.test(origin);
    return {
      configured: !!apps.appOf(who.accountId) && https,
      connected: !!linkOf(db, who.accountId),
      canManage: admin(who.role),
      // The key itself never leaves the server.
      app: own ? { applicationId: own.applicationId, region: own.region, hasAuthKey: !!own.authPublicKey } : null,
      serverApp: !!serverPoyntApp(),
      redirectUrl: `${origin}/p/pos/smartpos/authorized`,
      https,
    };
  });

  /** Saves the account's own Poynt app. A different app drops the link: the business allowed the old one. */
  app.put('/smartpos/app', async (req, reply) => {
    const who = ctx.identity(req);
    if (!admin(who.role)) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can change the Poynt app.' });
    const body = AppBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message ?? 'Check the app details.' });
    const before = apps.ownApp(who.accountId);
    // Leaving the key empty keeps the one saved for the same app.
    const privateKey = body.data.privateKey.trim() ? `${body.data.privateKey.trim()}\n` : before?.applicationId === body.data.applicationId ? before.privateKey : '';
    if (!privateKey) return reply.code(400).send({ error: 'invalid_request', message: 'Add the private key you downloaded with the app.' });
    try {
      if (createPrivateKey(privateKey).asymmetricKeyType !== 'rsa') throw new Error('not rsa');
    } catch {
      return reply.code(400).send({ error: 'invalid_request', message: 'That is not an RSA private key - use the .pem file Poynt gave you for the app.' });
    }
    const authPublicKey = body.data.authPublicKey?.trim() || null;
    if (authPublicKey) {
      try {
        createPublicKey(authPublicKey);
      } catch {
        return reply.code(400).send({ error: 'invalid_request', message: 'That Poynt public key could not be read.' });
      }
    }
    const next: PoyntApp = { applicationId: body.data.applicationId, privateKey, region: body.data.region, authPublicKey };
    // Sign in as the app now, so a wrong id, key or region shows here rather than at the till.
    const cfg = poyntConfig(next, originOf(req));
    if (cfg) {
      try {
        await new PoyntClient(cfg).signIn();
      } catch (err) {
        return reply.code(400).send({ error: 'invalid_request', message: (err as Error).message });
      }
    }
    if (before?.applicationId !== next.applicationId || before?.region !== next.region) db.prepare('DELETE FROM smartpos_links WHERE accountId = ?').run(who.accountId);
    apps.save(who.accountId, next);
    return { app: { applicationId: next.applicationId, region: next.region, hasAuthKey: !!authPublicKey } };
  });

  app.delete('/smartpos/app', async (req, reply) => {
    const who = ctx.identity(req);
    if (!admin(who.role)) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can change the Poynt app.' });
    if (apps.ownApp(who.accountId)) db.prepare('DELETE FROM smartpos_links WHERE accountId = ?').run(who.accountId);
    apps.save(who.accountId, null);
    return { ok: true };
  });

  /** The address to send the owner to, to let Zollify use their terminals. */
  app.post('/smartpos/connect', async (req, reply) => {
    const who = ctx.identity(req);
    if (!admin(who.role)) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can connect a payment terminal.' });
    const setup = setupOf(req);
    if ('error' in setup) return reply.code(409).send(setup.error);
    const { cfg } = setup;
    const nonce = randomBytes(24).toString('base64url');
    db.prepare('DELETE FROM smartpos_states WHERE expiresAt < ?').run(Date.now());
    db.prepare('INSERT INTO smartpos_states (nonce, accountId, expiresAt) VALUES (?, ?, ?)').run(nonce, who.accountId, Date.now() + 15 * 60_000);
    const q = new URLSearchParams({ redirect_uri: `${cfg.origin}/p/pos/smartpos/authorized`, client_id: cfg.applicationId, context: nonce });
    return { url: `${cfg.web}/applications/authorize?${q.toString()}` };
  });

  app.delete('/smartpos/connection', async (req, reply) => {
    const who = ctx.identity(req);
    if (!admin(who.role)) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can disconnect the terminal.' });
    db.prepare('DELETE FROM smartpos_links WHERE accountId = ?').run(who.accountId);
    return { ok: true };
  });

  app.get('/smartpos/terminals', async (req, reply) => {
    const setup = setupOf(req);
    if ('error' in setup) return reply.code(409).send(setup.error);
    const biz = linkOf(db, ctx.identity(req).accountId);
    if (!biz) return reply.code(409).send({ error: 'not_connected', message: 'Connect your Nexi account under Settings → Payments first.' });
    try {
      return { terminals: await terminalsOf(setup.client, biz) };
    } catch (err) {
      return reply.code(502).send({ error: 'upstream', message: (err as Error).message });
    }
  });

  /** Sends the amount to the terminal; the till then asks for the outcome. */
  app.post('/smartpos/payments', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const setup = setupOf(req);
    if ('error' in setup) return reply.code(409).send(setup.error);
    const { cfg, client } = setup;
    const who = ctx.identity(req);
    const biz = linkOf(db, who.accountId);
    if (!biz) return reply.code(409).send({ error: 'not_connected', message: 'Connect your Nexi account under Settings → Payments first.' });
    const body = PaymentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: 'That payment is not valid.' });
    const { amount, currency, reference, storeId, deviceId } = body.data;
    try {
      // Only this merchant's own terminals.
      if (!(await terminalsOf(client, biz)).some((t) => t.storeId === storeId && t.deviceId === deviceId)) {
        return reply.code(404).send({ error: 'unknown_terminal', message: 'That terminal is not on your Nexi account - pick it again under Settings → Payments.' });
      }
      const referenceId = randomUUID();
      const secret = randomBytes(24).toString('base64url');
      const now = Date.now();
      db.prepare(
        `INSERT INTO smartpos_payments (referenceId, accountId, businessId, storeId, deviceId, amount, currency, secretHash, state, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)`,
      ).run(referenceId, who.accountId, biz, storeId, deviceId, amount, currency, sha256(secret), now, now);
      await client.send({
        businessId: biz,
        storeId,
        deviceId,
        ttl: TTL_S,
        data: {
          callbackUrl: `${cfg.origin}/p/pos/smartpos/callback/${referenceId}/${secret}`,
          payment: JSON.stringify({
            amount,
            currency,
            referenceId,
            disableTip: true,
            ...(reference ? { notes: `Zollify ${reference}`.slice(0, 120) } : {}),
          }),
        },
      });
      resolveProblem(ctx, who.accountId, 'poynt', 'cloud');
      return reply.code(201).send({ referenceId });
    } catch (err) {
      reportProblem(ctx, who.accountId, { kind: 'poynt', key: 'cloud', severity: 'warning', message: 'Card payments through Nexi SmartPOS are failing to reach the terminal', detail: poyntReason(err), link: '/settings?panel=pos.payments' });
      return reply.code(502).send({ error: 'upstream', message: (err as Error).message });
    }
  });

  app.get<{ Params: { ref: string } }>('/smartpos/payments/:ref', async (req, reply) => {
    const row = db.prepare('SELECT state, detail, createdAt FROM smartpos_payments WHERE referenceId = ? AND accountId = ?').get(req.params.ref, ctx.identity(req).accountId) as
      | { state: string; detail: string; createdAt: number }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { state: row.state, ...(JSON.parse(row.detail) as PaymentDetail) };
  });

  app.post<{ Params: { ref: string } }>('/smartpos/payments/:ref/cancel', async (req, reply) => {
    const setup = setupOf(req);
    if ('error' in setup) return reply.code(409).send(setup.error);
    const row = db.prepare('SELECT * FROM smartpos_payments WHERE referenceId = ? AND accountId = ?').get(req.params.ref, ctx.identity(req).accountId) as
      | { businessId: string; storeId: string; deviceId: string; state: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.state === 'approved' || row.state === 'declined' || row.state === 'cancelled') return { state: row.state };
    try {
      await setup.client.send({ businessId: row.businessId, storeId: row.storeId, deviceId: row.deviceId, ttl: 30, data: { action: 'cancelPayment' } });
    } catch {
      /* the terminal still reports CANCELED or the result itself */
    }
    return { state: row.state };
  });
}

export function registerSmartposPublic(app: FastifyInstance, ctx: PublicModuleContext, apps: SmartposApps): void {
  const { db } = ctx;

  /**
   * Back from Poynt after the merchant allowed Zollify. The code's signature
   * is checked when Poynt's public key is known; either way the
   * nonce must be one we issued (and is used once), the code must be fresh
   * and made out to this app, Poynt must confirm the app can see that
   * business, and a business links to one Zollify account only.
   */
  app.get<{ Querystring: { code?: string; status?: string; context?: string } }>('/smartpos/authorized', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const origin = originOf(req);
    const back = (outcome: string) => reply.redirect(`${origin}/#/settings?panel=pos.payments&smartpos=${outcome}`);
    const nonce = String(req.query.context ?? '');
    const state = db.prepare('SELECT accountId, expiresAt FROM smartpos_states WHERE nonce = ?').get(nonce) as { accountId: string; expiresAt: number } | undefined;
    db.prepare('DELETE FROM smartpos_states WHERE nonce = ?').run(nonce);
    if (!state || state.expiresAt < Date.now()) return back('expired');
    // The app of the account that started connecting: each account may have its own.
    const own = apps.appOf(state.accountId);
    const cfg = own ? poyntConfig(own, origin) : null;
    if (!cfg) return back('not_configured');
    const client = apps.client(cfg);
    if (String(req.query.status ?? '').toLowerCase() === 'denied' || !req.query.code) return back('declined');
    const biz = businessFromCode(String(req.query.code), cfg);
    if (!biz) return back('failed');
    try {
      const check = await client.call('GET', `/businesses/${encodeURIComponent(biz)}`);
      if (check.status >= 300) return back('failed');
    } catch {
      return back('failed');
    }
    const taken = db.prepare('SELECT accountId FROM smartpos_links WHERE businessId = ?').get(biz) as { accountId: string } | undefined;
    if (taken && taken.accountId !== state.accountId) return back('in_use');
    db.prepare('INSERT INTO smartpos_links (accountId, businessId, linkedAt) VALUES (?, ?, ?) ON CONFLICT(accountId) DO UPDATE SET businessId = excluded.businessId, linkedAt = excluded.linkedAt').run(
      state.accountId,
      biz,
      Date.now(),
    );
    return back('connected');
  });

  /** The terminal reporting on a payment. Only the URL Poynt was given (with its secret) gets in. */
  app.post<{ Params: { ref: string; secret: string } }>('/smartpos/callback/:ref/:secret', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const row = db.prepare('SELECT accountId, secretHash, amount, currency, state FROM smartpos_payments WHERE referenceId = ?').get(req.params.ref) as
      | { accountId: string; secretHash: string; amount: number; currency: string; state: string }
      | undefined;
    const given = Buffer.from(sha256(req.params.secret));
    if (!row || !timingSafeEqual(given, Buffer.from(row.secretHash))) return reply.code(404).send({ error: 'not_found' });
    // A final outcome stands; a late RECEIVED or a retry does not undo it.
    if (row.state === 'approved' || row.state === 'declined' || row.state === 'cancelled') return { ok: true };
    const { state, detail } = readCallback(req.body, { amount: row.amount, currency: row.currency });
    db.prepare('UPDATE smartpos_payments SET state = ?, detail = ?, updatedAt = ? WHERE referenceId = ?').run(state, JSON.stringify(detail), Date.now(), req.params.ref);
    // A card terminal that answers with the wrong amount or nothing is not an ordinary decline: someone should look.
    if (state === 'declined' && /different amount|No transaction/.test(detail.message ?? '')) {
      reportProblem(ctx, row.accountId, { kind: 'poynt.callback', key: 'terminal', severity: 'warning', message: 'A card terminal reported a payment that does not match the sale', detail: /different amount/.test(detail.message ?? '') ? 'Amount differed' : 'No transaction in the answer', link: '/settings?panel=pos.payments' });
    }
    return { ok: true };
  });
}
