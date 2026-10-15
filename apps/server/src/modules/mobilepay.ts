import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reportProblem, resolveProblem, type ModuleContext, type SecretBox } from '@zollify/server-core';

/**
 * MobilePay (and Vipps) by QR code, over the Vipps MobilePay ePayment API:
 * the till asks the server for a payment, the server creates it with
 * `userFlow: QR` and hands back the link the QR carries, the till shows the
 * code, the customer scans it with their phone and pays in the MobilePay
 * app, and the till asks the server for the outcome until there is one. No
 * terminal is involved and nothing pairs with the till.
 *
 * Each account enters its own API keys from portal.vippsmobilepay.com (For
 * developers → the sales unit → Show keys): client id, client secret,
 * subscription key and the Merchant Serial Number. Kept encrypted here; the
 * till never sees them. Test and production are different hosts with
 * different keys, so the account says which it is using.
 *
 *   POST /accesstoken/get                              → bearer token (24 h in production)
 *   POST /epayment/v1/payments                         → { reference, redirectUrl }   (QR target link)
 *   GET  /epayment/v1/payments/{ref}                   → { state: CREATED | AUTHORIZED | ABORTED | EXPIRED | TERMINATED, amount, aggregate }
 *   POST /epayment/v1/payments/{ref}/capture           reserve → money; done the moment the payment is authorised, the goods go over the counter
 *   POST /epayment/v1/payments/{ref}/cancel            before the customer pays
 *
 * The outcome is polled, not taken from a webhook, so the server needs no
 * public address for this. Polling the ePayment API is asked to stay at
 * every two seconds, so the server looks at most that often per payment.
 */

export const MOBILEPAY_HOSTS = { test: 'https://apitest.vipps.no', production: 'https://api.vipps.no' } as const;
export type MobilepayEnv = keyof typeof MOBILEPAY_HOSTS;

export interface MobilepayKeys {
  env: MobilepayEnv;
  /** Merchant Serial Number: the sales unit. */
  msn: string;
  clientId: string;
  clientSecret: string;
  subscriptionKey: string;
}

export function migrateMobilepay(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mobilepay_keys (
      accountId  TEXT PRIMARY KEY,
      keys       TEXT NOT NULL,                  -- encrypted MobilepayKeys
      env        TEXT NOT NULL,
      msn        TEXT NOT NULL,
      updatedAt  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mobilepay_payments (
      referenceId  TEXT PRIMARY KEY,
      accountId    TEXT NOT NULL,
      amount       INTEGER NOT NULL,
      currency     TEXT NOT NULL,
      state        TEXT NOT NULL,
      message      TEXT,
      pspReference TEXT,
      qrUrl        TEXT NOT NULL,
      checkedAt    INTEGER NOT NULL,
      createdAt    INTEGER NOT NULL
    );
  `);
}

export const MOBILEPAY_TABLES = ['mobilepay_keys', 'mobilepay_payments'];

/** A refusal MobilePay gave, kept with its status so the till can say what to do. */
export class MobilepayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Vipps MobilePay asks every integration to say who it is on each call. */
const SYSTEM_HEADERS = {
  'Vipps-System-Name': 'Zollify',
  'Vipps-System-Version': process.env.npm_package_version ?? '0',
  'Vipps-System-Plugin-Name': 'zollify-pos',
  'Vipps-System-Plugin-Version': '1',
};

/** MobilePay's own words for a refusal: the problem detail or the first extra detail, else the status. */
function refusal(status: number, json: unknown): string {
  const b = (json ?? {}) as { detail?: string; title?: string; extraDetails?: { name?: string; reason?: string }[] };
  return b.extraDetails?.[0]?.reason || b.detail || b.title || `MobilePay answered ${status}`;
}

export function mobilepayApi(db: Database.Database, box: SecretBox) {
  /** Access tokens per account, kept until a minute before they run out. */
  const tokens = new Map<string, { token: string; until: number; forKeys: string }>();

  const keysOf = (accountId: string): MobilepayKeys | null => {
    const row = db.prepare('SELECT keys FROM mobilepay_keys WHERE accountId = ?').get(accountId) as { keys: string } | undefined;
    if (!row) return null;
    try {
      return box.decrypt<MobilepayKeys>(row.keys);
    } catch {
      return null;
    }
  };

  const save = (accountId: string, keys: MobilepayKeys | null): void => {
    tokens.delete(accountId);
    if (keys) {
      db.prepare(
        `INSERT INTO mobilepay_keys (accountId, keys, env, msn, updatedAt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(accountId) DO UPDATE SET keys = excluded.keys, env = excluded.env, msn = excluded.msn, updatedAt = excluded.updatedAt`,
      ).run(accountId, box.encrypt(keys), keys.env, keys.msn, Date.now());
    } else {
      db.prepare('DELETE FROM mobilepay_keys WHERE accountId = ?').run(accountId);
    }
  };

  /** A working token for these keys - also how a new set of keys is checked before it is saved. */
  async function tokenFor(keys: MobilepayKeys, accountId: string): Promise<string> {
    const forKeys = `${keys.env}|${keys.msn}|${keys.clientId}|${keys.subscriptionKey}`;
    const have = tokens.get(accountId);
    if (have && have.forKeys === forKeys && have.until > Date.now()) return have.token;
    const res = await fetch(`${MOBILEPAY_HOSTS[keys.env]}/accesstoken/get`, {
      method: 'POST',
      headers: {
        client_id: keys.clientId,
        client_secret: keys.clientSecret,
        'Ocp-Apim-Subscription-Key': keys.subscriptionKey,
        'Merchant-Serial-Number': keys.msn,
        ...SYSTEM_HEADERS,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const json = ((await res.json().catch(() => ({}))) ?? {}) as { access_token?: unknown; expires_in?: unknown };
    if (!res.ok || typeof json.access_token !== 'string') {
      // The token endpoint answers 400 to a malformed client id or subscription key and 401 to a wrong secret: all three mean "not these keys".
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        const why = (json as { detail?: string; error_description?: string }).error_description || (json as { detail?: string }).detail;
        throw new MobilepayError(401, `MobilePay did not accept these keys${why ? ` (${why})` : ''} - check the client id, client secret, subscription key and MSN, and that they are for the right environment.`);
      }
      throw new MobilepayError(502, refusal(res.status, json));
    }
    const expires = Number(json.expires_in) || 3600;
    tokens.set(accountId, { token: json.access_token, until: Date.now() + Math.max(0, expires - 60) * 1000, forKeys });
    return json.access_token;
  }

  async function call(accountId: string, method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
    const keys = keysOf(accountId);
    if (!keys) throw new MobilepayError(409, 'Enter your MobilePay API keys under Settings → Payments first.');
    const token = await tokenFor(keys, accountId);
    const res = await fetch(`${MOBILEPAY_HOSTS[keys.env]}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'Ocp-Apim-Subscription-Key': keys.subscriptionKey,
        'Merchant-Serial-Number': keys.msn,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...SYSTEM_HEADERS,
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
    if (!res.ok) throw new MobilepayError(res.status, refusal(res.status, json));
    return json;
  }

  return { keysOf, save, tokenFor, call };
}

/** The ePayment state, as the till's view of it. */
export function stateOf(state: unknown): 'sent' | 'authorized' | 'cancelled' {
  return state === 'AUTHORIZED' ? 'authorized' : state === 'ABORTED' || state === 'EXPIRED' || state === 'TERMINATED' ? 'cancelled' : 'sent';
}

// ── Routes ──────────────────────────────────────────────────────────────────

const KeysBody = z.object({
  env: z.enum(['test', 'production']),
  msn: z.string().trim().regex(/^\d{4,10}$/, 'The Merchant Serial Number is the sales unit number: digits only.'),
  clientId: z.string().trim().min(8).max(120),
  clientSecret: z.string().trim().min(8).max(240),
  subscriptionKey: z.string().trim().regex(/^[A-Fa-f0-9]{32}$/, 'The subscription key is 32 hex characters.'),
});
const PaymentBody = z.object({
  amount: z.number().int().positive().max(100_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reference: z.string().max(80).default(''),
});
/** At most one look at MobilePay per payment in this window, however often tills ask - what Vipps MobilePay asks of pollers. */
const CHECK_EVERY_MS = 2000;
const FINAL = new Set(['approved', 'declined', 'cancelled']);

type Amount = { currency?: string; value?: number };
type PaymentInfo = { state?: string; amount?: Amount; pspReference?: string; aggregate?: { capturedAmount?: Amount } };

export function registerMobilepay(app: FastifyInstance, ctx: ModuleContext, api: ReturnType<typeof mobilepayApi>): void {
  const { db } = ctx;
  const admin = (role: string) => role === 'owner' || role === 'admin';
  const fail = (reply: { code(n: number): { send(b: unknown): unknown } }, err: unknown) =>
    err instanceof MobilepayError
      ? reply.code(err.status === 409 || err.status === 401 ? 409 : 502).send({ error: err.status === 409 || err.status === 401 ? 'not_connected' : 'upstream', message: err.message })
      : reply.code(502).send({ error: 'upstream', message: 'MobilePay did not answer - try again.' });
  const status = (accountId: string, role: string) => {
    const keys = api.keysOf(accountId);
    return { connected: !!keys, env: keys?.env ?? null, msn: keys?.msn ?? null, canManage: admin(role) };
  };

  app.get('/mobilepay/status', async (req) => {
    const who = ctx.identity(req);
    return status(who.accountId, who.role);
  });

  /** The account's keys from the MobilePay portal; checked against MobilePay before they are kept. */
  app.put('/mobilepay/keys', async (req, reply) => {
    const who = ctx.identity(req);
    if (!admin(who.role)) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can connect MobilePay.' });
    const body = KeysBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message ?? 'Check the keys.' });
    try {
      await api.tokenFor(body.data, who.accountId);
    } catch (err) {
      if (err instanceof MobilepayError && err.status === 401) return reply.code(400).send({ error: 'invalid_request', message: err.message });
      return fail(reply, err);
    }
    api.save(who.accountId, body.data);
    resolveProblem(ctx, who.accountId, 'mobilepay', 'keys');
    return status(who.accountId, who.role);
  });

  app.delete('/mobilepay/keys', async (req, reply) => {
    const who = ctx.identity(req);
    if (!admin(who.role)) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can disconnect MobilePay.' });
    api.save(who.accountId, null);
    return status(who.accountId, who.role);
  });

  /** Creates the payment and hands the till the link its QR code carries. */
  app.post('/mobilepay/payments', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const who = ctx.identity(req);
    const body = PaymentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: 'That payment is not valid.' });
    const { amount, currency, reference } = body.data;
    // A UUID fits MobilePay's reference rules (8-64 of [A-Za-z0-9-]) and is unique on its own.
    const referenceId = randomUUID();
    const description = `Zollify ${reference}`.trim().slice(0, 100);
    try {
      const res = (await api.call(
        who.accountId,
        'POST',
        '/epayment/v1/payments',
        {
          amount: { value: amount, currency },
          paymentMethod: { type: 'WALLET' },
          reference: referenceId,
          userFlow: 'QR',
          // The plain link, drawn as a QR by the till itself - on its screen and on the customer display.
          qrFormat: { format: 'TEXT/TARGETURL' },
          customerInteraction: 'CUSTOMER_PRESENT',
          paymentDescription: description.length >= 3 ? description : 'Zollify sale',
        },
        referenceId,
      )) as { redirectUrl?: unknown } | null;
      if (typeof res?.redirectUrl !== 'string' || !/^https:\/\//.test(res.redirectUrl)) throw new MobilepayError(502, 'MobilePay gave no QR link for the payment.');
      const now = Date.now();
      db.prepare(
        `INSERT INTO mobilepay_payments (referenceId, accountId, amount, currency, state, qrUrl, checkedAt, createdAt)
         VALUES (?, ?, ?, ?, 'sent', ?, ?, ?)`,
      ).run(referenceId, who.accountId, amount, currency, res.redirectUrl, now, now);
      resolveProblem(ctx, who.accountId, 'mobilepay', 'payments');
      return reply.code(201).send({ referenceId, qr: res.redirectUrl });
    } catch (err) {
      if (err instanceof MobilepayError && (err.status === 401 || err.status === 403 || err.status === 409)) {
        reportProblem(ctx, who.accountId, { kind: 'mobilepay', key: 'payments', severity: 'warning', message: 'MobilePay payments are failing', detail: err.message, link: '/settings?panel=pos.payments' });
      }
      return fail(reply, err);
    }
  });

  /**
   * The outcome so far. Once the customer has paid (AUTHORIZED) the money is
   * captured at once - the goods are over the counter - and only a capture of
   * exactly the amount asked counts as paid.
   */
  app.get<{ Params: { ref: string } }>('/mobilepay/payments/:ref', async (req, reply) => {
    const accountId = ctx.identity(req).accountId;
    const row = db.prepare('SELECT * FROM mobilepay_payments WHERE referenceId = ? AND accountId = ?').get(req.params.ref, accountId) as
      | { amount: number; currency: string; state: string; message: string | null; pspReference: string | null; checkedAt: number }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const answer = (state: string, message: string | null, psp: string | null) => ({ state, ...(message ? { message } : {}), ...(psp ? { transactionId: psp } : {}) });
    if (FINAL.has(row.state) || Date.now() - row.checkedAt < CHECK_EVERY_MS) return answer(row.state, row.message, row.pspReference);
    db.prepare('UPDATE mobilepay_payments SET checkedAt = ? WHERE referenceId = ?').run(Date.now(), req.params.ref);
    try {
      const info = (await api.call(accountId, 'GET', `/epayment/v1/payments/${encodeURIComponent(req.params.ref)}`)) as PaymentInfo | null;
      const upstream = stateOf(info?.state);
      if (upstream === 'sent') return answer(row.state, row.message, row.pspReference);
      let state: string = upstream;
      let message: string | null = null;
      const psp = typeof info?.pspReference === 'string' ? info.pspReference : null;
      if (upstream === 'authorized') {
        const paid = info?.amount;
        if (paid && (paid.value !== row.amount || (paid.currency && paid.currency !== row.currency))) {
          state = 'declined';
          message = 'MobilePay reported a different amount - check the MobilePay portal before charging again.';
          reportProblem(ctx, accountId, { kind: 'mobilepay.amount', key: 'payments', severity: 'warning', message: 'A MobilePay payment does not match the sale', detail: 'Amount differed', link: '/settings?panel=pos.payments' });
        } else {
          try {
            const cap = (await api.call(accountId, 'POST', `/epayment/v1/payments/${encodeURIComponent(req.params.ref)}/capture`, { modificationAmount: { currency: row.currency, value: row.amount } }, `${req.params.ref}-capture`)) as PaymentInfo | null;
            const captured = cap?.aggregate?.capturedAmount?.value;
            if (captured === row.amount) state = 'approved';
            else {
              state = 'declined';
              message = 'MobilePay captured a different amount - check the MobilePay portal before charging again.';
            }
          } catch (err) {
            state = 'declined';
            message = `Paid in MobilePay but not captured: ${err instanceof Error ? err.message : 'no answer'}. Capture it in the MobilePay portal or refund the customer.`;
            reportProblem(ctx, accountId, { kind: 'mobilepay.capture', key: req.params.ref, severity: 'warning', message: 'A MobilePay payment was authorised but not captured', detail: message, link: '/settings?panel=pos.payments' });
          }
        }
      }
      db.prepare('UPDATE mobilepay_payments SET state = ?, message = ?, pspReference = ? WHERE referenceId = ?').run(state, message, psp, req.params.ref);
      return answer(state, message, psp);
    } catch {
      // A missed look is retried on the next ask.
      return answer(row.state, row.message, row.pspReference);
    }
  });

  /** Drops the payment before the customer pays; afterwards MobilePay still reports what happened. */
  app.post<{ Params: { ref: string } }>('/mobilepay/payments/:ref/cancel', async (req, reply) => {
    const accountId = ctx.identity(req).accountId;
    const row = db.prepare('SELECT state FROM mobilepay_payments WHERE referenceId = ? AND accountId = ?').get(req.params.ref, accountId) as { state: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!FINAL.has(row.state)) {
      try {
        await api.call(accountId, 'POST', `/epayment/v1/payments/${encodeURIComponent(req.params.ref)}/cancel`, {}, `${req.params.ref}-cancel`);
        db.prepare(`UPDATE mobilepay_payments SET state = 'cancelled' WHERE referenceId = ? AND state = 'sent'`).run(req.params.ref);
        return { state: 'cancelled' };
      } catch {
        /* the customer may already have paid; the next poll says */
      }
    }
    return { state: row.state };
  });
}
