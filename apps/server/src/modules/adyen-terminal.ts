import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { reasonOf, reportProblem, resolveProblem, type ModuleContext, type SecretBox } from '@zollify/server-core';

/**
 * Adyen payment terminals (a Verifone V400m, P400, S1 and the rest of
 * Adyen's fleet): card payments on the terminal, started from the till over
 * Adyen's cloud Terminal API. The terminal only needs internet; nothing pairs
 * locally, so any device can be the till.
 *
 * Each account saves its own Adyen API credential (an API key with the
 * "Cloud Device API" role, plus the merchant account) under Settings →
 * Payments, kept encrypted. A till picks its terminal by Adyen's terminal id,
 * model-serial as printed on the back: V400m-347395464.
 *
 *   POST {terminal-api}/sync    SaleToPOIRequest / PaymentRequest → the call
 *                               holds until the customer has paid (or not)
 *   POST {terminal-api}/sync    AbortRequest        → cancel a payment in progress
 *   POST {terminal-api}/sync    TransactionStatusRequest → what became of one we lost
 *   GET  {management}/v3/merchants/{account}/terminals → the merchant's terminals,
 *                               when the key also has the Management API terminal role
 *
 * The sync call blocks for as long as the customer takes, so it runs in the
 * background here and the till polls, the same shape as Nexi SmartPOS. The
 * outcome is only ever read from Adyen's answer, never assumed: a payment
 * Adyen approves for a different amount or currency is a decline here.
 */

export interface AdyenApp {
  apiKey: string;
  merchantAccount: string;
  environment: 'test' | 'live';
}

const hosts = (env: AdyenApp['environment']) => ({
  terminal: `https://terminal-api-${env}.adyen.com`,
  management: `https://management-${env}.adyen.com`,
});

/** Adyen wants 1-10 alphanumerics, unique per terminal for 48 hours. */
const serviceId = (): string => randomBytes(5).toString('hex');
const SALE_ID = 'Zollify';
/** How long the customer gets at the terminal before the sync call is given up on. */
const SHOPPER_TIMEOUT_MS = 180_000;

export interface PaymentDetail {
  transactionId?: string;
  pspReference?: string;
  cardBrand?: string;
  last4?: string;
  authCode?: string;
  message?: string;
}

// ── Reading Adyen's answers ─────────────────────────────────────────────────

/** AdditionalResponse is URL-encoded key=value pairs, or base64 of a JSON object, depending on the merchant's setup. */
export function additional(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (decoded.trim().startsWith('{')) {
      const obj = JSON.parse(decoded) as Record<string, unknown>;
      const flat = (obj.additionalData as Record<string, unknown> | undefined) ?? obj;
      return Object.fromEntries(Object.entries(flat).map(([k, v]) => [k, String(v)]));
    }
  } catch {
    /* not base64 JSON */
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

interface PaymentResponse {
  Response?: { Result?: string; ErrorCondition?: string; AdditionalResponse?: string };
  POIData?: { POITransactionID?: { TransactionID?: string } };
  PaymentResult?: {
    AmountsResp?: { Currency?: string; AuthorizedAmount?: number };
    PaymentInstrumentData?: { CardData?: { PaymentBrand?: string; MaskedPan?: string } };
    PaymentAcquirerData?: { AcquirerTransactionID?: { TransactionID?: string }; ApprovalCode?: string };
  };
}

/** What a payment came to, from the PaymentResponse. */
export function readPayment(resp: PaymentResponse | undefined, expected: { amount: number; currency: string }): { state: 'approved' | 'declined' | 'cancelled'; detail: PaymentDetail } {
  const r = resp?.Response;
  const extra = additional(r?.AdditionalResponse);
  const pr = resp?.PaymentResult;
  const detail: PaymentDetail = {
    ...(resp?.POIData?.POITransactionID?.TransactionID ? { transactionId: resp.POIData.POITransactionID.TransactionID } : {}),
    ...(extra.pspReference ? { pspReference: extra.pspReference } : {}),
    ...(pr?.PaymentInstrumentData?.CardData?.PaymentBrand ? { cardBrand: pr.PaymentInstrumentData.CardData.PaymentBrand } : extra.paymentMethod ? { cardBrand: extra.paymentMethod } : {}),
    ...(pr?.PaymentInstrumentData?.CardData?.MaskedPan ? { last4: pr.PaymentInstrumentData.CardData.MaskedPan.slice(-4) } : extra.cardSummary ? { last4: extra.cardSummary } : {}),
    ...(pr?.PaymentAcquirerData?.ApprovalCode ? { authCode: pr.PaymentAcquirerData.ApprovalCode } : extra.authCode ? { authCode: extra.authCode } : {}),
  };
  if (!r) return { state: 'declined', detail: { message: 'No answer from the terminal.' } };
  if (r.Result !== 'Success') {
    const cond = r.ErrorCondition ?? '';
    if (cond === 'Aborted' || cond === 'Cancel') return { state: 'cancelled', detail: { ...detail, message: extra.message || 'Cancelled on the terminal.' } };
    const why = extra.refusalReason || extra.message || (cond === 'Busy' ? 'The terminal is busy.' : cond === 'UnreachableHost' ? 'The terminal is offline.' : cond ? `Declined (${cond}).` : 'Declined.');
    return { state: 'declined', detail: { ...detail, message: why } };
  }
  // Never more or less than was asked, never another currency: a sale is only paid for what it costs.
  const paid = pr?.AmountsResp?.AuthorizedAmount;
  const okAmount = paid === undefined || Math.round(paid * 100) === Math.round(expected.amount * 100);
  const okCurrency = (pr?.AmountsResp?.Currency ?? expected.currency).toUpperCase() === expected.currency;
  if (!okAmount || !okCurrency) return { state: 'declined', detail: { ...detail, message: 'The terminal reported a different amount.' } };
  return { state: 'approved', detail };
}

// ── Storage ─────────────────────────────────────────────────────────────────

export function migrateAdyen(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adyen_apps (
      accountId TEXT PRIMARY KEY,
      app       TEXT NOT NULL,                 -- encrypted AdyenApp
      canList   INTEGER NOT NULL DEFAULT 0,    -- the key may list terminals (Management API role)
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS adyen_payments (
      referenceId TEXT PRIMARY KEY,
      accountId   TEXT NOT NULL,
      poiId       TEXT NOT NULL,
      serviceId   TEXT NOT NULL,
      amount      REAL NOT NULL,
      currency    TEXT NOT NULL,
      state       TEXT NOT NULL,
      detail      TEXT NOT NULL DEFAULT '{}',
      createdAt   INTEGER NOT NULL,
      updatedAt   INTEGER NOT NULL
    );
  `);
}

export const ADYEN_TABLES = ['adyen_apps', 'adyen_payments'];

// ── Talking to Adyen ────────────────────────────────────────────────────────

export class AdyenError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'AdyenError';
  }
}

export class AdyenClient {
  private readonly h: { terminal: string; management: string };
  constructor(private readonly app: AdyenApp) {
    this.h = hosts(app.environment);
  }

  private async post(url: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: unknown }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-API-key': this.app.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
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

  private header(category: string, poiId: string, id = serviceId()) {
    return { ProtocolVersion: '3.0', MessageClass: 'Service', MessageCategory: category, MessageType: 'Request', SaleID: SALE_ID, ServiceID: id, POIID: poiId };
  }

  /** Sends the amount and waits for the customer. Returns the PaymentResponse, however it came out. */
  async pay(poiId: string, id: string, reference: string, amount: number, currency: string): Promise<PaymentResponse | undefined> {
    const body = {
      SaleToPOIRequest: {
        MessageHeader: this.header('Payment', poiId, id),
        PaymentRequest: {
          SaleData: { SaleTransactionID: { TransactionID: reference, TimeStamp: new Date().toISOString() } },
          PaymentTransaction: { AmountsReq: { Currency: currency, RequestedAmount: amount } },
        },
      },
    };
    const res = await this.post(`${this.h.terminal}/sync`, body, SHOPPER_TIMEOUT_MS + 15_000);
    if (res.status === 401 || res.status === 403) throw new AdyenError('Adyen did not accept the API key.', res.status);
    if (res.status >= 300) throw new AdyenError(`Adyen answered ${res.status}.`, res.status);
    return (res.json as { SaleToPOIResponse?: { PaymentResponse?: PaymentResponse } } | null)?.SaleToPOIResponse?.PaymentResponse;
  }

  async abort(poiId: string, originalId: string): Promise<void> {
    const body = {
      SaleToPOIRequest: {
        MessageHeader: this.header('Abort', poiId),
        AbortRequest: { MessageReference: { MessageCategory: 'Payment', SaleID: SALE_ID, ServiceID: originalId, POIID: poiId }, AbortReason: 'MerchantAbort' },
      },
    };
    const res = await this.post(`${this.h.terminal}/sync`, body, 15_000);
    if (res.status >= 300) throw new AdyenError(`Adyen did not take the cancellation (${res.status}).`, res.status);
  }

  /** What became of a payment whose answer was lost: its PaymentResponse, or null while still in progress or unknown. */
  async status(poiId: string, originalId: string): Promise<PaymentResponse | null> {
    const body = {
      SaleToPOIRequest: {
        MessageHeader: this.header('TransactionStatus', poiId),
        TransactionStatusRequest: { ReceiptReprintFlag: false, DocumentQualifier: ['CashierReceipt'], MessageReference: { MessageCategory: 'Payment', SaleID: SALE_ID, ServiceID: originalId } },
      },
    };
    const res = await this.post(`${this.h.terminal}/sync`, body, 20_000);
    const tsr = (res.json as { SaleToPOIResponse?: { TransactionStatusResponse?: { Response?: { Result?: string; ErrorCondition?: string }; RepeatedMessageResponse?: { RepeatedResponseMessageBody?: { PaymentResponse?: PaymentResponse } } } } } | null)?.SaleToPOIResponse?.TransactionStatusResponse;
    if (!tsr || tsr.Response?.Result !== 'Success') return null;
    return tsr.RepeatedMessageResponse?.RepeatedResponseMessageBody?.PaymentResponse ?? null;
  }

  /**
   * The merchant's terminals, when the key may list them. 401 means the key
   * is wrong; 403 that it lacks the Management API role, which is fine for
   * paying - the till then types the terminal id instead.
   */
  async terminals(): Promise<{ id: string; model: string; serial: string; name: string }[] | 'forbidden'> {
    const res = await fetch(`${this.h.management}/v3/merchants/${encodeURIComponent(this.app.merchantAccount)}/terminals?pageSize=100`, {
      headers: { 'x-API-key': this.app.apiKey, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) throw new AdyenError('Adyen did not accept the API key.', 401);
    if (res.status === 403) return 'forbidden';
    if (res.status === 422 || res.status === 404) throw new AdyenError('Adyen does not know that merchant account for this key.', res.status);
    if (res.status >= 300) throw new AdyenError(`Adyen answered ${res.status}.`, res.status);
    const body = (await res.json()) as { data?: { id?: string; model?: string; serialNumber?: string; displayName?: string; assignment?: { status?: string } }[] };
    return (body.data ?? []).filter((t) => t.id).map((t) => ({ id: t.id!, model: t.model ?? '', serial: t.serialNumber ?? '', name: t.displayName || t.id! }));
  }
}

// ── Which app an account uses ───────────────────────────────────────────────

export function adyenApps(db: Database.Database, box: SecretBox) {
  return {
    appOf(accountId: string): (AdyenApp & { canList: boolean }) | null {
      const row = db.prepare('SELECT app, canList FROM adyen_apps WHERE accountId = ?').get(accountId) as { app: string; canList: number } | undefined;
      if (!row) return null;
      try {
        return { ...box.decrypt<AdyenApp>(row.app), canList: !!row.canList };
      } catch {
        return null;
      }
    },
    save(accountId: string, app: AdyenApp | null, canList = false): void {
      if (app) {
        db.prepare('INSERT INTO adyen_apps (accountId, app, canList, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(accountId) DO UPDATE SET app = excluded.app, canList = excluded.canList, updatedAt = excluded.updatedAt').run(accountId, box.encrypt(app), canList ? 1 : 0, Date.now());
      } else {
        db.prepare('DELETE FROM adyen_apps WHERE accountId = ?').run(accountId);
      }
    },
  };
}
export type AdyenApps = ReturnType<typeof adyenApps>;

// ── Routes ──────────────────────────────────────────────────────────────────

const AppBody = z.object({
  /** Empty keeps the key already saved. */
  apiKey: z.string().max(400).default(''),
  merchantAccount: z.string().trim().min(1).max(120),
  environment: z.enum(['test', 'live']).default('live'),
});
/** Adyen's terminal id: the model, a dash, the serial without dashes. */
const POI_ID = /^[A-Za-z0-9]{2,20}-[0-9]{6,20}$/;
const PaymentBody = z.object({
  amount: z.number().positive().max(1_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reference: z.string().max(80).default(''),
  poiId: z.string().regex(POI_ID, 'A terminal id looks like V400m-123456789.'),
});

const adyenReason = (err: unknown): string => reasonOf(err instanceof AdyenError ? err.status : null, err);

export function registerAdyen(app: FastifyInstance, ctx: ModuleContext, apps: AdyenApps): void {
  const { db } = ctx;
  const admin = (role: string) => role === 'owner' || role === 'admin';
  const off = { error: 'not_configured', message: 'Add your Adyen API key under Settings → Payments first.' };
  const setupOf = (req: FastifyRequest) => {
    const own = apps.appOf(ctx.identity(req).accountId);
    return own ? { app: own, client: new AdyenClient(own) } : null;
  };
  const finish = (referenceId: string, state: string, detail: PaymentDetail): void => {
    db.prepare("UPDATE adyen_payments SET state = ?, detail = ?, updatedAt = ? WHERE referenceId = ? AND state NOT IN ('approved','declined','cancelled')").run(state, JSON.stringify(detail), Date.now(), referenceId);
  };

  app.get('/adyen/status', async (req) => {
    const who = ctx.identity(req);
    const own = apps.appOf(who.accountId);
    return {
      configured: !!own,
      canManage: admin(who.role),
      canList: !!own?.canList,
      app: own ? { merchantAccount: own.merchantAccount, environment: own.environment, keyHint: own.apiKey.slice(-4) } : null,
    };
  });

  /** Saves the account's Adyen credential, after proving it with Adyen. */
  app.put('/adyen/app', async (req, reply) => {
    const who = ctx.identity(req);
    if (!admin(who.role)) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can change the Adyen credential.' });
    const body = AppBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message ?? 'Check the details.' });
    const before = apps.appOf(who.accountId);
    const apiKey = body.data.apiKey.trim() || before?.apiKey || '';
    if (!apiKey) return reply.code(400).send({ error: 'invalid_request', message: 'Add the API key from your Adyen Customer Area.' });
    const next: AdyenApp = { apiKey, merchantAccount: body.data.merchantAccount, environment: body.data.environment };
    let canList = false;
    try {
      canList = (await new AdyenClient(next).terminals()) !== 'forbidden';
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_request', message: (err as Error).message });
    }
    apps.save(who.accountId, next, canList);
    return { app: { merchantAccount: next.merchantAccount, environment: next.environment, keyHint: apiKey.slice(-4) }, canList };
  });

  app.delete('/adyen/app', async (req, reply) => {
    const who = ctx.identity(req);
    if (!admin(who.role)) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can change the Adyen credential.' });
    apps.save(who.accountId, null);
    return { ok: true };
  });

  app.get('/adyen/terminals', async (req, reply) => {
    const setup = setupOf(req);
    if (!setup) return reply.code(409).send(off);
    try {
      const list = await setup.client.terminals();
      return { terminals: list === 'forbidden' ? [] : list, canList: list !== 'forbidden' };
    } catch (err) {
      return reply.code(502).send({ error: 'upstream', message: (err as Error).message });
    }
  });

  /** Sends the amount to the terminal and waits for the customer in the background; the till asks for the outcome. */
  app.post('/adyen/payments', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const setup = setupOf(req);
    if (!setup) return reply.code(409).send(off);
    const who = ctx.identity(req);
    const body = PaymentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: body.error.issues[0]?.message ?? 'That payment is not valid.' });
    const { amount, currency, reference, poiId } = body.data;
    const referenceId = randomUUID();
    const id = serviceId();
    const now = Date.now();
    db.prepare(`INSERT INTO adyen_payments (referenceId, accountId, poiId, serviceId, amount, currency, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, ?)`).run(referenceId, who.accountId, poiId, id, amount, currency, now, now);
    const expected = { amount, currency };
    void (async () => {
      try {
        const resp = await setup.client.pay(poiId, id, reference ? `${reference}`.slice(0, 40) : referenceId, amount, currency);
        const { state, detail } = readPayment(resp, expected);
        finish(referenceId, state, detail);
        resolveProblem(ctx, who.accountId, 'adyen', 'cloud');
        if (state === 'declined' && /different amount/.test(detail.message ?? '')) {
          reportProblem(ctx, who.accountId, { kind: 'adyen.terminal', key: 'terminal', severity: 'warning', message: 'A card terminal reported a payment that does not match the sale', detail: 'Amount or currency differed', link: '/settings?panel=pos.payments' });
        }
      } catch (err) {
        // The answer was lost (timeout, network): ask Adyen what became of it before giving up on it.
        let recovered = false;
        if (!(err instanceof AdyenError && (err.status === 401 || err.status === 403))) {
          try {
            const resp = await setup.client.status(poiId, id);
            if (resp) {
              const { state, detail } = readPayment(resp, expected);
              finish(referenceId, state, detail);
              recovered = true;
            }
          } catch {
            /* still unknown */
          }
        }
        if (!recovered) finish(referenceId, 'declined', { message: err instanceof AdyenError && err.status ? err.message : 'No answer from the terminal. Check it before charging again - the payment may have gone through.' });
        reportProblem(ctx, who.accountId, { kind: 'adyen', key: 'cloud', severity: 'warning', message: 'Card payments through Adyen are failing to reach the terminal', detail: adyenReason(err), link: '/settings?panel=pos.payments' });
      }
    })();
    return reply.code(201).send({ referenceId });
  });

  app.get<{ Params: { ref: string } }>('/adyen/payments/:ref', async (req, reply) => {
    const row = db.prepare('SELECT state, detail FROM adyen_payments WHERE referenceId = ? AND accountId = ?').get(req.params.ref, ctx.identity(req).accountId) as { state: string; detail: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { state: row.state, ...(JSON.parse(row.detail) as PaymentDetail) };
  });

  /** Asks the terminal to drop the payment; the outcome still comes from the sync answer. */
  app.post<{ Params: { ref: string } }>('/adyen/payments/:ref/cancel', async (req, reply) => {
    const setup = setupOf(req);
    if (!setup) return reply.code(409).send(off);
    const row = db.prepare('SELECT poiId, serviceId, state FROM adyen_payments WHERE referenceId = ? AND accountId = ?').get(req.params.ref, ctx.identity(req).accountId) as { poiId: string; serviceId: string; state: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.state !== 'sent') return { state: row.state };
    try {
      await setup.client.abort(row.poiId, row.serviceId);
    } catch {
      /* the sync answer says what happened either way */
    }
    return { state: row.state };
  });

}
