import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { reportProblem, resolveProblem, type ModuleContext, type PublicModuleContext, type SecretBox } from '@zollify/server-core';

/**
 * SumUp Solo over SumUp's Cloud API: the till sends the amount to the server,
 * the server sends it to the Solo, and the till asks the server for the
 * outcome until there is one. Nothing pairs with the till device, so it works
 * from a browser, a laptop or an iPad - only the Solo has to be online.
 *
 * The merchant connects their SumUp account once (OAuth, in a popup that
 * closes itself) and pairs a Solo by typing in the code it shows. The server
 * keeps the tokens encrypted and refreshes them. The server's own OAuth app
 * and affiliate key come from the environment.
 *
 *   GET  /authorize, POST /token                  OAuth 2.0 (code + refresh)
 *   GET  /v0.1/memberships?kind=merchant           → the merchant code
 *   GET  /v0.1/merchants/{m}/readers               POST same with { pairing_code, name }
 *   POST /v0.1/merchants/{m}/readers/{r}/checkout  → { data: { checkout_id, client_transaction_id } }
 *   GET  /v0.1/merchants/{m}/readers/{r}/checkout/{c}  → { data: { status: pending | successful | failed | cancelled } }
 *   POST /v0.1/merchants/{m}/readers/{r}/terminate
 *
 * The outcome is polled rather than taken from SumUp's webhook, so the server
 * does not need a public address for payments - only for the OAuth return.
 */

const API = 'https://api.sumup.com';
const SCOPES = 'readers.read readers.write user.profile_readonly';
/** The id the affiliate key was made for; the Android app's by default (capacitor.config.ts). */
const DEFAULT_APP_ID = 'com.phuongninjin.zollify';

export interface SumupCloudConfig {
  clientId: string;
  clientSecret: string;
  affiliateKey: string | null;
  appId: string;
}

/** The server's SumUp app from the environment, or null when it has none. */
export function sumupCloudConfig(env: NodeJS.ProcessEnv = process.env): SumupCloudConfig | null {
  const clientId = env.SUMUP_CLIENT_ID?.trim();
  const clientSecret = env.SUMUP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, affiliateKey: env.SUMUP_AFFILIATE_KEY?.trim() || null, appId: env.SUMUP_APP_ID?.trim() || DEFAULT_APP_ID };
}

function originOf(req: FastifyRequest): string {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.trim().replace(/\/+$/, '');
  return `${req.protocol}://${req.host}`;
}
const redirectOf = (req: FastifyRequest): string => `${originOf(req)}/p/pos/sumup/authorized`;

export function migrateSumupCloud(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sumup_links (
      accountId    TEXT PRIMARY KEY,
      merchantCode TEXT NOT NULL UNIQUE,
      merchantName TEXT NOT NULL DEFAULT '',
      tokens       TEXT NOT NULL,                -- encrypted Tokens
      linkedAt     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sumup_states (
      nonce        TEXT PRIMARY KEY,
      accountId    TEXT NOT NULL,
      redirectUri  TEXT NOT NULL,
      expiresAt    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sumup_payments (
      referenceId  TEXT PRIMARY KEY,
      accountId    TEXT NOT NULL,
      merchantCode TEXT NOT NULL,
      readerId     TEXT NOT NULL,
      checkoutId   TEXT,
      clientTxId   TEXT,
      amount       INTEGER NOT NULL,
      currency     TEXT NOT NULL,
      state        TEXT NOT NULL,
      message      TEXT,
      checkedAt    INTEGER NOT NULL,
      createdAt    INTEGER NOT NULL
    );
  `);
}

export const SUMUP_TABLES = ['sumup_links', 'sumup_states', 'sumup_payments'];

interface Tokens {
  access: string;
  refresh: string | null;
  /** When the access token stops working, in ms. */
  until: number;
}

/** A refusal SumUp gave, kept with its status so the till can say what to do. */
export class SumupError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function form(path: string, body: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, json: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
}

function tokensFrom(json: Record<string, unknown>, previous: Tokens | null): Tokens | null {
  const access = typeof json.access_token === 'string' ? json.access_token : null;
  if (!access) return null;
  const expires = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  // SumUp may leave the refresh token out of a refresh; the old one then stays good.
  const refresh = typeof json.refresh_token === 'string' ? json.refresh_token : (previous?.refresh ?? null);
  // A minute early, so a token never runs out halfway through a payment.
  return { access, refresh, until: Date.now() + Math.max(0, expires - 60) * 1000 };
}

/** SumUp's own words for a refusal: the problem detail or message, else the status. */
function refusal(status: number, json: unknown): string {
  const b = (json ?? {}) as { detail?: string; message?: string; title?: string; errors?: { detail?: string } };
  return b.detail || b.message || b.errors?.detail || b.title || `SumUp answered ${status}`;
}

// ── Accounts ────────────────────────────────────────────────────────────────

export function sumupLinks(db: Database.Database, box: SecretBox) {
  const linkOf = (accountId: string) =>
    db.prepare('SELECT merchantCode, merchantName, tokens FROM sumup_links WHERE accountId = ?').get(accountId) as { merchantCode: string; merchantName: string; tokens: string } | undefined;
  const save = (accountId: string, tokens: Tokens) => db.prepare('UPDATE sumup_links SET tokens = ? WHERE accountId = ?').run(box.encrypt(tokens), accountId);

  /** A working access token for the account, refreshed when it is about to run out. */
  async function tokenFor(cfg: SumupCloudConfig, accountId: string): Promise<{ token: string; merchantCode: string }> {
    const link = linkOf(accountId);
    if (!link) throw new SumupError(409, 'Connect your SumUp account under Settings → Payments first.');
    let tokens: Tokens;
    try {
      tokens = box.decrypt<Tokens>(link.tokens);
    } catch {
      throw new SumupError(409, 'Connect your SumUp account again under Settings → Payments.');
    }
    if (tokens.until > Date.now()) return { token: tokens.access, merchantCode: link.merchantCode };
    if (!tokens.refresh) throw new SumupError(409, 'Connect your SumUp account again under Settings → Payments.');
    const res = await form('/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: cfg.clientId, client_secret: cfg.clientSecret });
    const next = res.status < 300 ? tokensFrom(res.json, tokens) : null;
    if (!next) {
      // The merchant revoked access, or the refresh token expired: only a new sign-in helps.
      if (res.status === 400 || res.status === 401) db.prepare('DELETE FROM sumup_links WHERE accountId = ?').run(accountId);
      throw new SumupError(409, 'SumUp signed this account out - connect it again under Settings → Payments.');
    }
    save(accountId, next);
    return { token: next.access, merchantCode: link.merchantCode };
  }

  async function call(cfg: SumupCloudConfig, accountId: string, method: 'GET' | 'POST' | 'DELETE', path: (m: string) => string, body?: unknown): Promise<unknown> {
    const { token, merchantCode } = await tokenFor(cfg, accountId);
    const res = await fetch(`${API}${path(encodeURIComponent(merchantCode))}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
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
    if (!res.ok) throw new SumupError(res.status, refusal(res.status, json));
    return json;
  }

  return { linkOf, call };
}

export interface SumupReader {
  id: string;
  name: string;
  status: string;
  model: string;
}

const readerOf = (r: { id?: string; name?: string; status?: string; device?: { model?: string } }): SumupReader => ({
  id: String(r.id),
  name: r.name ?? 'Solo',
  status: r.status ?? 'unknown',
  model: r.device?.model ?? 'solo',
});

/** SumUp's checkout status, as the till's four states. */
export function stateOf(status: unknown): 'sent' | 'approved' | 'declined' | 'cancelled' {
  return status === 'successful' ? 'approved' : status === 'failed' ? 'declined' : status === 'cancelled' ? 'cancelled' : 'sent';
}

// ── Routes ──────────────────────────────────────────────────────────────────

const PairBody = z.object({
  pairingCode: z.string().trim().regex(/^[A-Za-z0-9]{4,16}$/, 'Type the code the Solo shows under Connections → API.'),
  name: z.string().trim().min(1).max(50).default('Solo'),
});
const PaymentBody = z.object({
  amount: z.number().int().positive().max(100_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reference: z.string().max(80).default(''),
  readerId: z.string().regex(/^rdr_[A-Za-z0-9]+$/),
});
/** At most one look at SumUp per payment in this window, however often tills ask. */
const CHECK_EVERY_MS = 2000;
const FINAL = new Set(['approved', 'declined', 'cancelled']);

export function registerSumupCloud(app: FastifyInstance, ctx: ModuleContext, links: ReturnType<typeof sumupLinks>, cfgOf = () => sumupCloudConfig()): void {
  const { db } = ctx;
  const admin = (role: string) => role === 'owner' || role === 'admin';
  const off = { error: 'not_configured', message: 'This server is not set up for SumUp yet.' };
  const fail = (reply: { code(n: number): { send(b: unknown): unknown } }, err: unknown) =>
    err instanceof SumupError
      ? reply.code(err.status === 409 ? 409 : 502).send({ error: err.status === 409 ? 'not_connected' : 'upstream', message: err.message })
      : reply.code(502).send({ error: 'upstream', message: 'SumUp did not answer - try again.' });

  app.get('/sumup/cloud/status', async (req) => {
    const who = ctx.identity(req);
    const link = links.linkOf(who.accountId);
    const cfg = cfgOf();
    return {
      configured: !!cfg,
      affiliate: !!cfg?.affiliateKey,
      connected: !!link,
      merchant: link ? { code: link.merchantCode, name: link.merchantName } : null,
      canManage: admin(who.role),
      redirectUrl: redirectOf(req),
    };
  });

  /** Where to send the owner to allow Zollify on their SumUp account. */
  app.post('/sumup/cloud/connect', async (req, reply) => {
    const who = ctx.identity(req);
    if (!admin(who.role)) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can connect a payment account.' });
    const cfg = cfgOf();
    if (!cfg) return reply.code(409).send(off);
    const nonce = randomBytes(24).toString('base64url');
    const redirectUri = redirectOf(req);
    db.prepare('DELETE FROM sumup_states WHERE expiresAt < ?').run(Date.now());
    db.prepare('INSERT INTO sumup_states (nonce, accountId, redirectUri, expiresAt) VALUES (?, ?, ?, ?)').run(nonce, who.accountId, redirectUri, Date.now() + 15 * 60_000);
    const q = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri, scope: SCOPES, state: nonce });
    return { url: `${API}/authorize?${q.toString()}` };
  });

  app.delete('/sumup/cloud/connection', async (req, reply) => {
    const who = ctx.identity(req);
    if (!admin(who.role)) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can disconnect SumUp.' });
    db.prepare('DELETE FROM sumup_links WHERE accountId = ?').run(who.accountId);
    return { ok: true };
  });

  app.get('/sumup/cloud/readers', async (req, reply) => {
    const cfg = cfgOf();
    if (!cfg) return reply.code(409).send(off);
    try {
      const res = (await links.call(cfg, ctx.identity(req).accountId, 'GET', (m) => `/v0.1/merchants/${m}/readers`)) as { items?: unknown[] } | null;
      return { readers: (res?.items ?? []).map((r) => readerOf(r as Parameters<typeof readerOf>[0])) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Pairs a Solo from the code it shows; the reader then belongs to the merchant's SumUp account. */
  app.post('/sumup/cloud/readers', async (req, reply) => {
    const who = ctx.identity(req);
    if (!admin(who.role)) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can pair a card reader.' });
    const cfg = cfgOf();
    if (!cfg) return reply.code(409).send(off);
    const body = PairBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message ?? 'Check the pairing code.' });
    try {
      const r = await links.call(cfg, who.accountId, 'POST', (m) => `/v0.1/merchants/${m}/readers`, { pairing_code: body.data.pairingCode.toUpperCase(), name: body.data.name });
      return reply.code(201).send({ reader: readerOf(r as Parameters<typeof readerOf>[0]) });
    } catch (err) {
      if (err instanceof SumupError && err.status >= 400 && err.status < 500 && err.status !== 409) {
        return reply.code(400).send({ error: 'invalid_request', message: `SumUp did not take that code: ${err.message}. Codes last 5 minutes - make a new one on the Solo.` });
      }
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/sumup/cloud/readers/:id', async (req, reply) => {
    const who = ctx.identity(req);
    if (!admin(who.role)) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can remove a card reader.' });
    const cfg = cfgOf();
    if (!cfg) return reply.code(409).send(off);
    if (!/^rdr_[A-Za-z0-9]+$/.test(req.params.id)) return reply.code(400).send({ error: 'invalid_request' });
    try {
      await links.call(cfg, who.accountId, 'DELETE', (m) => `/v0.1/merchants/${m}/readers/${req.params.id}`);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Sends the amount to the Solo; the till then asks for the outcome. */
  app.post('/sumup/cloud/payments', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const who = ctx.identity(req);
    const cfg = cfgOf();
    if (!cfg) return reply.code(409).send(off);
    if (!cfg.affiliateKey) return reply.code(409).send({ error: 'not_configured', message: 'This server has no SumUp affiliate key (SUMUP_AFFILIATE_KEY) - SumUp needs one for card payments.' });
    const body = PaymentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: 'That payment is not valid.' });
    const link = links.linkOf(who.accountId);
    if (!link) return reply.code(409).send({ error: 'not_connected', message: 'Connect your SumUp account under Settings → Payments first.' });
    const { amount, currency, reference, readerId } = body.data;
    const referenceId = randomUUID();
    try {
      const res = (await links.call(cfg, who.accountId, 'POST', (m) => `/v0.1/merchants/${m}/readers/${readerId}/checkout`, {
        total_amount: { value: amount, currency, minor_unit: minorUnitOf(currency) },
        description: reference ? `Zollify ${reference}`.slice(0, 120) : 'Zollify',
        affiliate: { app_id: cfg.appId, key: cfg.affiliateKey, foreign_transaction_id: referenceId },
      })) as { data?: { checkout_id?: string; client_transaction_id?: string } } | null;
      const now = Date.now();
      db.prepare(
        `INSERT INTO sumup_payments (referenceId, accountId, merchantCode, readerId, checkoutId, clientTxId, amount, currency, state, checkedAt, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)`,
      ).run(referenceId, who.accountId, link.merchantCode, readerId, res?.data?.checkout_id ?? null, res?.data?.client_transaction_id ?? null, amount, currency, now, now);
      resolveProblem(ctx, who.accountId, 'sumup', 'cloud');
      return reply.code(201).send({ referenceId });
    } catch (err) {
      // The Solo being off is the common case and the till already says so; a broken connection is worth a problem.
      if (err instanceof SumupError && (err.status === 401 || err.status === 403 || err.status === 409)) {
        reportProblem(ctx, who.accountId, { kind: 'sumup', key: 'cloud', severity: 'warning', message: 'Card payments through SumUp Solo are failing', detail: err.message, link: '/settings?panel=pos.payments' });
      }
      return fail(reply, err);
    }
  });

  app.get<{ Params: { ref: string } }>('/sumup/cloud/payments/:ref', async (req, reply) => {
    const accountId = ctx.identity(req).accountId;
    const row = db.prepare('SELECT * FROM sumup_payments WHERE referenceId = ? AND accountId = ?').get(req.params.ref, accountId) as
      | { readerId: string; checkoutId: string | null; clientTxId: string | null; amount: number; currency: string; state: string; message: string | null; checkedAt: number }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const cfg = cfgOf();
    if (!FINAL.has(row.state) && row.checkoutId && cfg && Date.now() - row.checkedAt >= CHECK_EVERY_MS) {
      db.prepare('UPDATE sumup_payments SET checkedAt = ? WHERE referenceId = ?').run(Date.now(), req.params.ref);
      try {
        const res = (await links.call(cfg, accountId, 'GET', (m) => `/v0.1/merchants/${m}/readers/${row.readerId}/checkout/${encodeURIComponent(row.checkoutId!)}`)) as {
          data?: { status?: string; payment_failure_reason?: string | null; total_amount?: { value?: number; currency?: string } };
        } | null;
        let state = stateOf(res?.data?.status);
        let message: string | null = state === 'declined' ? (res?.data?.payment_failure_reason ?? 'Declined on the reader.') : null;
        // Paid is only paid for exactly what the till asked.
        const paid = res?.data?.total_amount;
        if (state === 'approved' && paid && (paid.value !== row.amount || (paid.currency && paid.currency !== row.currency))) {
          state = 'declined';
          message = 'The reader reported a different amount - check the SumUp app before charging again.';
          reportProblem(ctx, accountId, { kind: 'sumup.amount', key: 'reader', severity: 'warning', message: 'A SumUp reader reported a payment that does not match the sale', detail: 'Amount differed', link: '/settings?panel=pos.payments' });
        }
        if (state !== row.state) {
          db.prepare('UPDATE sumup_payments SET state = ?, message = ? WHERE referenceId = ?').run(state, message, req.params.ref);
          return { state, ...(message ? { message } : {}), ...(row.clientTxId ? { transactionId: row.clientTxId } : {}) };
        }
      } catch {
        /* a missed look is retried on the next ask */
      }
    }
    return { state: row.state, ...(row.message ? { message: row.message } : {}), ...(row.clientTxId ? { transactionId: row.clientTxId } : {}) };
  });

  /** Asks the Solo to drop the payment; it only can while it waits for the card. */
  app.post<{ Params: { ref: string } }>('/sumup/cloud/payments/:ref/cancel', async (req, reply) => {
    const accountId = ctx.identity(req).accountId;
    const row = db.prepare('SELECT readerId, state FROM sumup_payments WHERE referenceId = ? AND accountId = ?').get(req.params.ref, accountId) as { readerId: string; state: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const cfg = cfgOf();
    if (!FINAL.has(row.state) && cfg) {
      try {
        await links.call(cfg, accountId, 'POST', (m) => `/v0.1/merchants/${m}/readers/${row.readerId}/terminate`);
      } catch {
        /* the reader still reports the outcome itself */
      }
    }
    return { state: row.state };
  });
}

/** Back from SumUp after the merchant allowed Zollify: a page that tells the till and closes itself. */
export function registerSumupCloudPublic(app: FastifyInstance, ctx: PublicModuleContext, box: SecretBox, cfgOf = () => sumupCloudConfig()): void {
  const { db } = ctx;
  const page = (reply: { type(t: string): { send(b: string): unknown } }, ok: boolean, text: string) =>
    reply
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SumUp</title>` +
          `<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;text-align:center;padding:1rem">` +
          `<div><p style="font-size:1.2rem;font-weight:600">${ok ? 'SumUp is connected' : 'SumUp was not connected'}</p><p>${text}</p></div>` +
          `<script>setTimeout(function(){window.close()},${ok ? 1500 : 6000})</script></body>`,
      );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/sumup/authorized', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const nonce = String(req.query.state ?? '');
    const state = db.prepare('SELECT accountId, redirectUri, expiresAt FROM sumup_states WHERE nonce = ?').get(nonce) as { accountId: string; redirectUri: string; expiresAt: number } | undefined;
    db.prepare('DELETE FROM sumup_states WHERE nonce = ?').run(nonce);
    if (!state || state.expiresAt < Date.now()) return page(reply, false, 'That link had expired. Close this window and tap Connect again.');
    if (req.query.error || !req.query.code) return page(reply, false, 'Connecting was cancelled. Close this window to go back.');
    const cfg = cfgOf();
    if (!cfg) return page(reply, false, 'This server is not set up for SumUp.');
    try {
      const res = await form('/token', { grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: state.redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret });
      const tokens = res.status < 300 ? tokensFrom(res.json, null) : null;
      if (!tokens) return page(reply, false, 'SumUp did not confirm the connection. Close this window and try again.');
      const mres = await fetch(`${API}/v0.1/memberships?kind=merchant&status=accepted`, {
        headers: { authorization: `Bearer ${tokens.access}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      const items = ((await mres.json().catch(() => ({}))) as { items?: { resource_id?: string; resource?: { id?: string; name?: string } }[] }).items ?? [];
      // ponytail: the first merchant account; a login with several would need a picker.
      const first = items[0];
      const merchantCode = first?.resource?.id ?? first?.resource_id;
      if (!mres.ok || !merchantCode) return page(reply, false, 'This SumUp login has no merchant account to take payments with.');
      const taken = db.prepare('SELECT accountId FROM sumup_links WHERE merchantCode = ?').get(merchantCode) as { accountId: string } | undefined;
      if (taken && taken.accountId !== state.accountId) return page(reply, false, 'That SumUp account is already connected to another Zollify account.');
      db.prepare(
        `INSERT INTO sumup_links (accountId, merchantCode, merchantName, tokens, linkedAt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(accountId) DO UPDATE SET merchantCode = excluded.merchantCode, merchantName = excluded.merchantName, tokens = excluded.tokens, linkedAt = excluded.linkedAt`,
      ).run(state.accountId, merchantCode, first?.resource?.name ?? '', box.encrypt(tokens), Date.now());
      return page(reply, true, 'You can close this window and go back to Zollify.');
    } catch {
      return page(reply, false, 'SumUp did not answer. Close this window and try again.');
    }
  });
}

/** Decimals of a currency (2 for DKK and EUR, 0 for HUF, CLP…). */
export function minorUnitOf(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}
