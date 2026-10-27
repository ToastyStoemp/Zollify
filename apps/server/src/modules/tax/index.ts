import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ExpenseDetailSchema, TRAVEL_RATE_DEFAULTS, TravelRatesSchema, base64BodyLimit, defaultTravelRates, describeDetail, eventDays, maxBytesFor, splitShared, toBaseFactor, type SalesEvent, type Transaction, type TravelRates } from '@zollify/shared';
import {
  checkQuota,
  decodeUpload,
  makeSecretBox,
  reduceEvents,
  reduceMerges,
  reduceTransactions,
  reasonOf,
  reportProblem,
  resolveProblem,
  sendRefusal,
  type ModuleContext,
  type ServerModule,
} from '@zollify/server-core';
import { CONFIG_GROUPS, applyConfigPatch, endpointProblem, effectiveValues, emptyConfig, enabledMap, redactConfig, type TaxConfig } from './config';
import { MyposClient, loadMyposConfig, summarize } from './mypos';
import { SumupClient, loadSumupConfig } from './sumup';
import { ShopifyOrdersClient, loadShopifyConfig } from './shopify';
import { LexwareClient, buildFeeVoucher, buildRevenueVoucher, resolveCategoryId } from './lexware';
import { loadAiConfig, matchEvent, parseInvoicePdf, pingAiKey } from './invoice-ai';
import { round2, type KvCache } from './types';
import { buildBooksZip } from './export';
import { yearMaterials } from './year-materials';

/**
 * Tax - the server half (the ZollTax port).
 *
 * Holds each account's integration credentials encrypted at rest, talks to
 * myPOS / SumUp / Shopify / Lexware / Anthropic on the account's behalf, and
 * keeps the ledger of per-event expenses. Events and sales come from the
 * account's own op-log - the ZollTool read-token dance is gone.
 *
 * The clustering of payments into conventions stays in the browser, as it
 * was in ZollTax; this half only fetches rows, verifies, books and remembers
 * what was booked.
 */

const SECRET_SALT = 'zollify-module-credentials-v1';

/**
 * Ledger cost categories. Ids are stable: Lexware and e-conomic bookings
 * and every stored expense refer to them, so a category is added, never
 * renamed. `perdiem`, `mileage` and shared costs are worked out from the
 * event rather than typed in - see @zollify/shared travel-costs.
 */
const EXPENSE_CATEGORIES = [
  { id: 'booth', label: 'Booth / table fee' },
  { id: 'travel', label: 'Travel (tickets, fuel, tolls)' },
  { id: 'mileage', label: 'Mileage (own car)' },
  { id: 'accommodation', label: 'Accommodation' },
  { id: 'perdiem', label: 'Per diems (meals)' },
  // What was actually bought to eat and drink at the event (snacks, lunch), as opposed to the per diem allowance.
  { id: 'food', label: 'Food and drinks' },
  { id: 'shipping', label: 'Shipping and freight' },
  { id: 'customs', label: 'Customs and duties' },
  { id: 'marketing', label: 'Marketing and printing' },
  { id: 'furniture', label: 'Booth furniture and rental' },
  { id: 'staff', label: 'Staff and helpers' },
  { id: 'insurance', label: 'Insurance' },
  { id: 'fees', label: 'Fees (payment, platform)' },
  { id: 'stock', label: 'Stock bought for the event' },
  { id: 'other', label: 'Other' },
] as const;
const CATEGORY_IDS = EXPENSE_CATEGORIES.map((c) => c.id) as unknown as [string, ...string[]];
/** All a staff member may call: add an expense, with its receipt, and know the categories. */
const STAFF_ROUTES = new Set([
  'GET /ledger/categories',
  'POST /ledger/expenses',
  'POST /ledger/expenses/:id/invoice',
  'GET /cards',
  'GET /ledger/cash-spent',
  'GET /card-payments',
  'POST /card-payments',
  'POST /card-payments/:id/add',
  'DELETE /card-payments/:id',
]);

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tax_config (
      accountId TEXT PRIMARY KEY,
      blob      TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tax_cache (
      accountId TEXT NOT NULL,
      key       TEXT NOT NULL,
      value     TEXT NOT NULL,
      PRIMARY KEY (accountId, key)
    );
    CREATE TABLE IF NOT EXISTS tax_expenses (
      accountId       TEXT NOT NULL,
      id              TEXT NOT NULL,
      eventId         TEXT NOT NULL,
      category        TEXT NOT NULL,
      amountMinor     INTEGER NOT NULL,
      currency        TEXT NOT NULL,
      date            TEXT NOT NULL,
      vendor          TEXT NOT NULL,
      note            TEXT NOT NULL,
      invoiceName     TEXT,
      invoiceBytes    BLOB,
      invoiceAt       INTEGER,
      bookedVoucherId TEXT,
      createdAt       INTEGER NOT NULL,
      updatedAt       INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE TABLE IF NOT EXISTS tax_bookings (
      accountId     TEXT NOT NULL,
      voucherNumber TEXT NOT NULL,
      voucherId     TEXT NOT NULL,
      kind          TEXT NOT NULL,
      totalMinor    INTEGER NOT NULL,
      bookedAt      INTEGER NOT NULL,
      PRIMARY KEY (accountId, voucherNumber)
    );
    CREATE TABLE IF NOT EXISTS tax_ai_usage (
      accountId TEXT PRIMARY KEY,
      day       TEXT NOT NULL,
      calls     INTEGER NOT NULL,
      tokens    INTEGER NOT NULL
    );
    -- Card payments seen on the phone (Google Wallet notifications): the last four digits and the
    -- merchant, never the rest of the notification. A card marked personal keeps nothing here.
    CREATE TABLE IF NOT EXISTS tax_cards (
      accountId TEXT NOT NULL,
      last4     TEXT NOT NULL,
      role      TEXT,
      label     TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (accountId, last4)
    );
    CREATE TABLE IF NOT EXISTS tax_card_payments (
      accountId      TEXT NOT NULL,
      id             TEXT NOT NULL,
      at             INTEGER NOT NULL,
      amountMinor    INTEGER NOT NULL,
      currency       TEXT NOT NULL,
      merchant       TEXT NOT NULL,
      last4          TEXT NOT NULL,
      addedExpenseId TEXT,
      dismissedAt    INTEGER,
      createdBy      TEXT,
      PRIMARY KEY (accountId, id)
    );
  `);
  // How a computed expense came about (per diems, mileage, a shared cost's split), added later.
  const cols = (db.prepare('PRAGMA table_info(tax_expenses)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('detail')) db.exec('ALTER TABLE tax_expenses ADD COLUMN detail TEXT');
  // Who added it: staff add expenses too (the quick expense at an event); admins check and change them.
  if (!cols.includes('createdBy')) db.exec('ALTER TABLE tax_expenses ADD COLUMN createdBy TEXT');
  // Where the money came from: the card, the cash in the till's box, or something else. Cash up takes
  // cash out of what the box should hold; expenses from before this was asked have no answer.
  if (!cols.includes('paidFrom')) db.exec('ALTER TABLE tax_expenses ADD COLUMN paidFrom TEXT');
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const ConfigPatch = z.object({
  set: z.record(z.string(), z.string().max(2000)).optional(),
  clear: z.array(z.string()).optional(),
  enabled: z.record(z.string(), z.boolean()).optional(),
});

const Range = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

const BookBody = z.object({
  kind: z.enum(['revenue', 'fees']).default('revenue'),
  dryRun: z.boolean().default(false),
  voucherNumber: z.string().min(1).max(60),
  voucherDate: z.string().optional(),
  dueDate: z.string().optional(),
  totalGrossAmount: z.number().finite(),
  taxType: z.enum(['gross', 'net']).default('gross'),
  taxRatePercent: z.number().optional(),
  remark: z.string().max(500).optional(),
  category: z.string().optional(),
  customer: z.enum(['contact', 'collective']).default('contact'),
  customerName: z.string().max(200).optional(),
  event: z
    .object({ name: z.string(), country: z.string().optional(), startDate: z.string(), endDate: z.string(), vatRate: z.number() })
    .optional(),
  pdfBase64: z.string().max(base64BodyLimit(maxBytesFor('voucher'))).optional(),
  filename: z.string().max(120).optional(),
});

const CardPaymentBody = z.object({
  /** The phone's own id for the notification: sending it again counts once. */
  id: z.string().trim().min(8).max(80),
  at: z.number().int().positive(),
  amount: z.number().positive().max(10_000_000),
  currency: z.string().length(3),
  merchant: z.string().trim().max(120).default(''),
  /** The last four digits of the card; empty when the notification did not name one. */
  last4: z.string().regex(/^(\d{4})?$/).default(''),
});
const AddCardPaymentBody = z.object({
  eventId: z.string().min(1).max(64),
  category: z.enum(CATEGORY_IDS).default('other'),
  vendor: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).default(''),
});
const CardBody = z.object({
  role: z.enum(['business', 'personal']),
  label: z.string().trim().max(60).default(''),
});
const PaidFrom = z.enum(['card', 'cash', 'other']);
const ExpenseBody = z.object({
  paidFrom: PaidFrom.nullable().optional(),
  eventId: z.string().max(64).default(''),
  category: z.enum(CATEGORY_IDS).default('other'),
  amount: z.number().finite().nonnegative(),
  currency: z.string().length(3).default('EUR'),
  date: z.string().max(10).default(''),
  vendor: z.string().max(200).default(''),
  note: z.string().max(1000).default(''),
  /** For an expense worked out from the event: what went into the figure. */
  detail: ExpenseDetailSchema.nullable().optional(),
});

/** A cost covering several events, split across them by their days or evenly. */
const SharedBody = ExpenseBody.omit({ eventId: true, detail: true }).extend({
  eventIds: z.array(z.string().min(1).max(64)).min(1).max(500),
  method: z.enum(['days', 'even']).default('days'),
});

// ── Module ──────────────────────────────────────────────────────────────────

export function taxServerModule(jwtSecret: string): ServerModule {
  const box = makeSecretBox(jwtSecret, SECRET_SALT);

  return {
    id: 'tax',
    // Staff only get to add an expense (see STAFF_ROUTES); the books are the admins'.
    minRole: 'member',
    migrate,
    onAccountDeleted: (db, accountId) => {
      for (const t of ['tax_config', 'tax_cache', 'tax_expenses', 'tax_bookings', 'tax_ai_usage']) db.prepare(`DELETE FROM ${t} WHERE accountId = ?`).run(accountId);
    },

    routes: (ctx: ModuleContext) => async (app) => {
      const db = ctx.db;

      // ── Per-account state ───────────────────────────────────────────────
      const readConfig = (accountId: string): TaxConfig => {
        const row = db.prepare('SELECT blob FROM tax_config WHERE accountId = ?').get(accountId) as { blob: string } | undefined;
        if (!row) return emptyConfig();
        try {
          return box.decrypt<TaxConfig>(row.blob);
        } catch {
          return emptyConfig();
        }
      };
      const writeConfig = (accountId: string, cfg: TaxConfig): void => {
        db.prepare(
          `INSERT INTO tax_config (accountId, blob, updatedAt) VALUES (?, ?, ?)
           ON CONFLICT(accountId) DO UPDATE SET blob = excluded.blob, updatedAt = excluded.updatedAt`,
        ).run(accountId, box.encrypt(cfg), Date.now());
      };
      const cacheFor = (accountId: string): KvCache => ({
        get: <T>(key: string): T | null => {
          const row = db.prepare('SELECT value FROM tax_cache WHERE accountId = ? AND key = ?').get(accountId, key) as { value: string } | undefined;
          return row ? (JSON.parse(row.value) as T) : null;
        },
        set: (key, value) => {
          db.prepare('INSERT INTO tax_cache (accountId, key, value) VALUES (?, ?, ?) ON CONFLICT(accountId, key) DO UPDATE SET value = excluded.value').run(
            accountId,
            key,
            JSON.stringify(value),
          );
        },
      });

      // Clients are rebuilt per request from the stored config: cheap, and a
      // saved edit is live on the very next call without a cache to invalidate.
      // The myPOS session cache lives in tax_cache, so re-auth is not per call.
      const clientsFor = (accountId: string) => {
        const env = effectiveValues(readConfig(accountId));
        return {
          mypos: new MyposClient(loadMyposConfig(env), cacheFor(accountId)),
          sumup: new SumupClient(loadSumupConfig(env)),
          shopify: new ShopifyOrdersClient(loadShopifyConfig(env)),
          lexware: {
            apiKey: env.LEXWARE_API_KEY ?? '',
            apiUrl: (env.LEXWARE_API_URL || 'https://api.lexoffice.io/v1').replace(/\/+$/, ''),
            feeCategory: env.LEXWARE_FEE_CATEGORY ?? '',
          },
          ai: loadAiConfig(env),
        };
      };

      const opsFor = (accountId: string, types: string[]) =>
        (db
          .prepare(`SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY seq`)
          .all(accountId, ...types) as { opId: string; type: string; payload: string }[]).map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) as unknown }));

      const eventsFor = (accountId: string): SalesEvent[] =>
        reduceEvents(opsFor(accountId, ['event.upsert', 'event.close'])).filter((e) => !e.deletedAt);

      const transactionsFor = (accountId: string): Transaction[] => {
        const ops = opsFor(accountId, ['tx.create', 'tx.revert', 'product.merge']);
        return reduceTransactions(ops, reduceMerges(ops));
      };

      /** Revenue in the event's base currency, reverted sales excluded. */
      const revenueByEvent = (txns: Transaction[]): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const t of txns) {
          if (t.revertedBy || t.revertedAt) continue;
          // At the sale's day rate when the till recorded one; else as booked.
          const base = t.marketRate || t.baseTotal == null ? (Number(t.total) || 0) * toBaseFactor(t, t.baseCurrency ?? t.currency) : Number(t.baseTotal);
          out[t.eventId] = (out[t.eventId] ?? 0) + base;
        }
        return out;
      };

      const bookingsFor = (accountId: string) =>
        db.prepare('SELECT voucherNumber, voucherId, kind, totalMinor, bookedAt FROM tax_bookings WHERE accountId = ?').all(accountId) as {
          voucherNumber: string;
          voucherId: string;
          kind: string;
          totalMinor: number;
          bookedAt: number;
        }[];

      const who = (req: FastifyRequest) => ctx.identity(req);

      // Staff may log what they spent at an event - and nothing else of the books.
      app.addHook('preHandler', async (req, reply) => {
        if (ctx.identity(req).role !== 'member') return undefined;
        const route = `${req.method} ${req.routeOptions.url?.replace(/^\/api\/m\/tax/, '') ?? ''}`;
        if (STAFF_ROUTES.has(route)) return undefined;
        return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can do that.' });
      });
      /**
       * Runs a call to an outside service and tells Problems how it went: a failure opens a warning
       * (the HTTP status or error class only, never the service's words), a success closes it.
       * A missing credential is a setup gap the screen already says, not an outage.
       */
      const track = async <T>(accountId: string, source: string, label: string, run: () => Promise<T>): Promise<T> => {
        try {
          const out = await run();
          resolveProblem(ctx, accountId, `tax.${source}`);
          return out;
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status !== undefined || (err instanceof Error && err.name !== 'SourceError')) {
            reportProblem(ctx, accountId, { kind: `tax.${source}`, severity: 'warning', message: `${label} is not answering`, detail: reasonOf(status, err), link: '/settings?panel=tax.integrations' });
          }
          throw err;
        }
      };

      // ── Status + config ─────────────────────────────────────────────────
      app.get('/status', async (req) => {
        const { accountId } = who(req);
        const cfg = readConfig(accountId);
        const c = clientsFor(accountId);
        return {
          enabled: enabledMap(cfg),
          mypos: { mode: c.mypos.mode },
          shopify: await c.shopify.status(false),
          sumup: { mode: c.sumup.mode, ready: c.sumup.mode === 'mock' || c.sumup.configured },
          lexware: { configured: Boolean(c.lexware.apiKey), feeCategory: Boolean(c.lexware.feeCategory) },
          ai: { configured: Boolean(c.ai.apiKey) },
          values: redactConfig(cfg),
          bookings: bookingsFor(accountId),
        };
      });

      app.get('/config', async (req) => {
        const cfg = readConfig(who(req).accountId);
        return { groups: CONFIG_GROUPS, values: redactConfig(cfg), enabled: enabledMap(cfg) };
      });

      app.put('/config', async (req, reply) => {
        const { accountId } = who(req);
        const parsed = ConfigPatch.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid', message: 'Malformed settings.' });
        const next = applyConfigPatch(readConfig(accountId), parsed.data);
        const problem = Object.keys(parsed.data.set ?? {}).map((k) => endpointProblem(k, next.values[k] ?? '')).find(Boolean);
        if (problem) return reply.code(400).send({ error: 'invalid', message: problem });
        writeConfig(accountId, next);
        return { ok: true, values: redactConfig(next), enabled: enabledMap(next) };
      });

      app.post('/config/test', async (req) => {
        const { accountId } = who(req);
        const group = String((req.body as { group?: string } | undefined)?.group ?? '');
        const c = clientsFor(accountId);
        try {
          switch (group) {
            case 'lexware': {
              if (!c.lexware.apiKey) return { ok: false, detail: 'No API key set.' };
              const p = await new LexwareClient(c.lexware.apiKey, c.lexware.apiUrl).ping();
              return { ok: true, detail: `Connected${p.companyName ? ` - ${p.companyName}` : ''}.` };
            }
            case 'mypos': {
              if (c.mypos.mode !== 'live') return { ok: false, detail: 'Missing myPOS credentials.' };
              const accounts = await c.mypos.listAccounts();
              return { ok: true, detail: `Authenticated - ${accounts.length} account(s).` };
            }
            case 'shopify': {
              const st = await c.shopify.status(true);
              if (st.mode !== 'live') return { ok: false, detail: 'Missing Shopify credentials.' };
              if (!st.ready) return { ok: false, detail: st.error ?? 'Token exchange failed - check the client ID/secret.' };
              return { ok: true, detail: `Connected to ${st.shop ?? 'Shopify'}.` };
            }
            case 'sumup': {
              if (c.sumup.mode !== 'live') return { ok: false, detail: 'Missing SumUp credentials.' };
              const to = new Date().toISOString().slice(0, 10);
              const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
              await c.sumup.listTransactions(from, to);
              return { ok: true, detail: 'SumUp API reachable.' };
            }
            case 'ai': {
              if (!c.ai.apiKey) return { ok: false, detail: 'No API key set.' };
              const p = await pingAiKey(c.ai.apiKey);
              return p.ok ? { ok: true, detail: `API key valid - using ${c.ai.model}.` } : { ok: false, detail: p.detail ?? 'Key check failed.' };
            }
            default:
              return { ok: false, detail: 'Unknown integration.' };
          }
        } catch (e) {
          return { ok: false, detail: e instanceof Error ? e.message : String(e) };
        }
      });

      // ── Events and sales from the op-log ────────────────────────────────
      app.get('/events', async (req) => ({ events: eventsFor(who(req).accountId) }));

      app.get<{ Params: { eventId: string } }>('/events/:eventId/cash', async (req) => {
        const { accountId } = who(req);
        let cash = 0;
        let currency = 'EUR';
        let count = 0;
        // Also what was taken, in the currency it was taken in: the card side of
        // a booking is in the terminal's currency, and the two must not be mixed.
        const taken: Record<string, number> = {};
        for (const t of transactionsFor(accountId)) {
          if (t.eventId !== req.params.eventId || t.revertedBy || t.revertedAt) continue;
          const legs = t.payments.filter((p) => p.kind === 'cash');
          if (!legs.length) continue;
          const amount = legs.reduce((s, p) => s + (Number(p.amount) || 0), 0);
          cash += amount * (t.marketRate ? toBaseFactor(t, t.baseCurrency ?? t.currency) : 1 / (t.exchangeRate || 1));
          currency = t.baseCurrency ?? t.currency ?? currency;
          if (t.currency) taken[t.currency] = (taken[t.currency] ?? 0) + amount;
          count++;
        }
        for (const k of Object.keys(taken)) taken[k] = round2(taken[k]!);
        return { eventId: req.params.eventId, cash: round2(cash), currency, count, taken };
      });

      // ── Payment sources ─────────────────────────────────────────────────
      app.get('/mypos/accounts', async (req) => {
        const c = clientsFor(who(req).accountId);
        return { mode: c.mypos.mode, accounts: await track(who(req).accountId, 'mypos', 'myPOS', () => c.mypos.listAccounts()) };
      });

      app.get('/mypos/transactions', async (req, reply) => {
        const q = req.query as Record<string, string>;
        const range = Range.safeParse(q);
        if (!range.success) return reply.code(400).send({ error: 'invalid', message: 'from and to are required (YYYY-MM-DD).' });
        const c = clientsFor(who(req).accountId);
        const accounts = q.accounts ? q.accounts.split(',').filter(Boolean) : undefined;
        const transactions = await track(who(req).accountId, 'mypos', 'myPOS', () => c.mypos.listTransactions({ ...range.data, accounts }));
        return { mode: c.mypos.mode, count: transactions.length, ...range.data, transactions };
      });

      app.get('/mypos/verify', async (req, reply) => {
        const q = req.query as Record<string, string>;
        const range = Range.safeParse(q);
        if (!range.success) return reply.code(400).send({ error: 'invalid', message: 'from and to are required (YYYY-MM-DD).' });
        const c = clientsFor(who(req).accountId);
        const txns = await track(who(req).accountId, 'mypos', 'myPOS', () => c.mypos.listTransactions({ ...range.data, account: q.account || undefined }));
        return { mode: c.mypos.mode, summary: summarize(txns), ...range.data };
      });

      app.get('/shopify/orders', async (req, reply) => {
        const range = Range.safeParse(req.query);
        if (!range.success) return reply.code(400).send({ error: 'invalid', message: 'from and to are required (YYYY-MM-DD).' });
        const c = clientsFor(who(req).accountId);
        const orders = await c.shopify.listOrders(range.data.from, range.data.to);
        return { mode: c.shopify.mode, count: orders.length, ...range.data, orders };
      });

      app.get('/sumup/transactions', async (req, reply) => {
        const range = Range.safeParse(req.query);
        if (!range.success) return reply.code(400).send({ error: 'invalid', message: 'from and to are required (YYYY-MM-DD).' });
        const c = clientsFor(who(req).accountId);
        const transactions = await track(who(req).accountId, 'sumup', 'SumUp', () => c.sumup.listTransactions(range.data.from, range.data.to));
        return { mode: c.sumup.mode, count: transactions.length, ...range.data, transactions };
      });

      // ── Lexware booking ─────────────────────────────────────────────────
      app.post('/lexware/book', { bodyLimit: base64BodyLimit(maxBytesFor('voucher')) }, async (req, reply) => {
        const { accountId } = who(req);
        const parsed = BookBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid', message: parsed.error.issues[0]?.message ?? 'Malformed booking.' });
        const p = parsed.data;
        // A bad PDF is refused before anything is booked, so a voucher never exists without its document.
        let pdfBytes: Buffer | undefined;
        if (p.pdfBase64) {
          const pdf = decodeUpload('voucher', p.pdfBase64, { name: p.filename ?? 'voucher.pdf' });
          if (!pdf.ok) return sendRefusal(reply, pdf);
          pdfBytes = pdf.bytes;
        }
        const lex = clientsFor(accountId).lexware;

        let voucher;
        let customerName: string | undefined;
        try {
          if (p.kind === 'fees') {
            voucher = buildFeeVoucher({
              voucherNumber: p.voucherNumber,
              voucherDate: p.voucherDate ?? '',
              dueDate: p.dueDate,
              totalGrossAmount: p.totalGrossAmount,
              taxRatePercent: p.taxRatePercent ?? 0,
              taxType: p.taxType,
              remark: p.remark,
              categoryId: lex.feeCategory,
            });
          } else {
            customerName = p.customerName ?? (p.event?.name ? `Revenue - ${p.event.name}` : undefined);
            voucher = buildRevenueVoucher({
              voucherNumber: p.voucherNumber,
              voucherDate: p.voucherDate ?? p.event?.startDate ?? '',
              dueDate: p.dueDate ?? p.event?.endDate,
              taxType: p.taxType,
              taxRatePercent: p.taxRatePercent ?? p.event?.vatRate ?? 0,
              totalGrossAmount: p.totalGrossAmount,
              remark: p.remark,
              categoryId: resolveCategoryId(p.category),
            });
          }
        } catch (e) {
          return reply.code(400).send({ error: 'invalid', message: e instanceof Error ? e.message : String(e) });
        }

        if (p.dryRun) return { dryRun: true, kind: p.kind, voucher, customerName: customerName ?? null };

        if (!lex.apiKey) return reply.code(400).send({ error: 'not_configured', message: 'Add a Lexware API key under Settings → Integrations first.' });
        const client = new LexwareClient(lex.apiKey, lex.apiUrl);
        const created = await track(accountId, 'lexware', 'Lexware', async () => {
          if (p.kind === 'revenue' && customerName && p.customer !== 'collective') {
            voucher.contactId = await client.ensureCustomerContact(customerName);
            delete voucher.useCollectiveContact;
          }
          const made = await client.createVoucher(voucher);
          if (pdfBytes) {
            await client.uploadVoucherFile(made.id, pdfBytes, p.filename ?? `${p.voucherNumber}.pdf`);
          }
          return made;
        });
        db.prepare(
          `INSERT INTO tax_bookings (accountId, voucherNumber, voucherId, kind, totalMinor, bookedAt) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(accountId, voucherNumber) DO UPDATE SET voucherId = excluded.voucherId, totalMinor = excluded.totalMinor, bookedAt = excluded.bookedAt`,
        ).run(accountId, p.voucherNumber, created.id, p.kind, Math.round(p.totalGrossAmount * 100), Date.now());
        return { dryRun: false, kind: p.kind, voucherId: created.id, permalink: `https://app.lexware.de/permalink/vouchers/view/${created.id}` };
      });

      app.get('/bookings', async (req) => ({ bookings: bookingsFor(who(req).accountId) }));

      // ── Ledger ──────────────────────────────────────────────────────────
      interface ExpenseRow {
        id: string;
        eventId: string;
        category: string;
        amountMinor: number;
        currency: string;
        date: string;
        vendor: string;
        note: string;
        invoiceName: string | null;
        invoiceAt: number | null;
        bookedVoucherId: string | null;
        detail: string | null;
        createdBy: string | null;
        paidFrom: string | null;
        createdAt: number;
        updatedAt: number;
      }
      const EXPENSE_COLS = 'id, eventId, category, amountMinor, currency, date, vendor, note, invoiceName, invoiceAt, bookedVoucherId, detail, createdBy, paidFrom, createdAt, updatedAt';
      const emailOf = (userId: string): string | null => (db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined)?.email ?? null;
      const detailOf = (raw: string | null) => {
        if (!raw) return null;
        const parsed = ExpenseDetailSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
      };
      const toExpense = (r: ExpenseRow) => ({
        id: r.id,
        eventId: r.eventId,
        category: r.category,
        amount: r.amountMinor / 100,
        currency: r.currency,
        date: r.date,
        vendor: r.vendor,
        note: r.note,
        invoice: r.invoiceName ? { filename: r.invoiceName, uploadedAt: r.invoiceAt } : null,
        bookedVoucherId: r.bookedVoucherId,
        detail: detailOf(r.detail),
        /** Who added it; null for expenses from before this was kept. */
        createdBy: r.createdBy ? { userId: r.createdBy, email: emailOf(r.createdBy) } : null,
        /** Null for expenses from before this was asked. */
        paidFrom: r.paidFrom as 'card' | 'cash' | 'other' | null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      });
      const listExpenses = (accountId: string, eventId?: string) =>
        (db
          .prepare(`SELECT ${EXPENSE_COLS} FROM tax_expenses WHERE accountId = ?${eventId ? ' AND eventId = ?' : ''} ORDER BY date DESC, createdAt DESC`)
          .all(...(eventId ? [accountId, eventId] : [accountId])) as ExpenseRow[]).map(toExpense);

      app.get('/ledger/expenses', async (req) => {
        const eventId = (req.query as { eventId?: string }).eventId;
        return { categories: EXPENSE_CATEGORIES, expenses: listExpenses(who(req).accountId, eventId || undefined) };
      });

      /** What an expense can be filed under - all a staff member's quick expense needs, without the books. */
      app.get('/ledger/categories', async () => ({ categories: EXPENSE_CATEGORIES }));

      app.post('/ledger/expenses', async (req, reply) => {
        const me = who(req);
        const { accountId } = me;
        const parsed = ExpenseBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid', message: 'Check the expense fields.' });
        const e = parsed.data;
        // A helper limited to some events logs costs for those only.
        if (me.allowedEventIds && !me.allowedEventIds.includes(e.eventId)) return reply.code(403).send({ error: 'forbidden', message: 'That event is not one of yours.' });
        // Per diems, mileage and split costs are worked out by an admin, not typed in by staff.
        const detail = me.role === 'member' ? null : e.detail;
        const now = Date.now();
        const id = randomUUID();
        db.prepare(
          `INSERT INTO tax_expenses (accountId, id, eventId, category, amountMinor, currency, date, vendor, note, detail, createdBy, paidFrom, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(accountId, id, e.eventId, e.category, Math.round(e.amount * 100), e.currency.toUpperCase(), e.date.slice(0, 10), e.vendor, e.note, detail ? JSON.stringify(detail) : null, me.userId, e.paidFrom ?? null, now, now);
        return reply.code(201).send({ expense: listExpenses(accountId).find((x) => x.id === id) });
      });

      /**
       * One cost over several events - a year's insurance, a van for two
       * conventions - lands as one expense per event, each with its share
       * and a note saying how it was split. The shares add up to the amount.
       */
      app.post('/ledger/expenses/shared', async (req, reply) => {
        const { accountId } = who(req);
        const parsed = SharedBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid', message: 'Check the expense fields.' });
        const e = parsed.data;
        const events = new Map(eventsFor(accountId).map((ev) => [ev.id, ev]));
        const ids = [...new Set(e.eventIds)];
        const missing = ids.filter((id) => !events.has(id));
        if (missing.length) return reply.code(400).send({ error: 'invalid', message: 'One of the events no longer exists.' });
        const shares = splitShared(e.amount, ids.map((id) => ({ id, days: eventDays(events.get(id)!.dateStart, events.get(id)!.dateEnd) })), e.method);
        const groupId = randomUUID();
        const now = Date.now();
        const currency = e.currency.toUpperCase();
        const insert = db.prepare(
          `INSERT INTO tax_expenses (accountId, id, eventId, category, amountMinor, currency, date, vendor, note, detail, createdBy, paidFrom, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const made: string[] = [];
        db.transaction(() => {
          for (const s of shares) {
            const detail = { kind: 'shared' as const, groupId, method: e.method, total: e.amount, of: ids.length };
            const note = [e.note, describeDetail(detail, currency)].filter(Boolean).join(' · ');
            const id = randomUUID();
            insert.run(accountId, id, s.id, e.category, Math.round(s.amount * 100), currency, e.date.slice(0, 10), e.vendor, note, JSON.stringify(detail), who(req).userId, e.paidFrom ?? null, now, now);
            made.push(id);
          }
        })();
        const all = listExpenses(accountId);
        return reply.code(201).send({ expenses: made.map((id) => all.find((x) => x.id === id)) });
      });

      // ── Rates for per diems and mileage ─────────────────────────────────
      // The account's own table, started from the defaults for its country
      // and corrected by an admin as the yearly letters change.
      const RATES_KEY = 'ledger.rates';
      const readRates = (accountId: string): TravelRates => {
        const stored = cacheFor(accountId).get<unknown>(RATES_KEY);
        const parsed = stored ? TravelRatesSchema.safeParse(stored) : null;
        if (parsed?.success) return parsed.data;
        // The business's own country, from its profile; Germany's rules until it says.
        const row = db.prepare('SELECT profile FROM accounts WHERE id = ?').get(accountId) as { profile: string | null } | undefined;
        let home = '';
        try {
          home = String((JSON.parse(row?.profile ?? '{}') as { artist?: { countryOfOrigin?: string } }).artist?.countryOfOrigin ?? '');
        } catch {
          /* no profile yet */
        }
        return defaultTravelRates(home || 'DE');
      };
      app.get('/ledger/rates', async (req) => ({ rates: readRates(who(req).accountId), defaults: Object.keys(TRAVEL_RATE_DEFAULTS) }));
      app.put('/ledger/rates', async (req, reply) => {
        const { accountId } = who(req);
        const parsed = TravelRatesSchema.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid', message: parsed.error.issues[0]?.message ?? 'Check the rates.' });
        cacheFor(accountId).set(RATES_KEY, parsed.data);
        return { rates: parsed.data };
      });
      /** Back to the defaults for a home country. */
      app.post('/ledger/rates/reset', async (req, reply) => {
        const { accountId } = who(req);
        const home = String((req.body as { homeCountry?: string } | undefined)?.homeCountry ?? '').trim();
        if (!home) return reply.code(400).send({ error: 'invalid', message: 'Say which country.' });
        const rates = defaultTravelRates(home);
        cacheFor(accountId).set(RATES_KEY, rates);
        return { rates };
      });

      app.put<{ Params: { id: string } }>('/ledger/expenses/:id', async (req, reply) => {
        const { accountId } = who(req);
        const parsed = ExpenseBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid', message: 'Check the expense fields.' });
        const e = parsed.data;
        // Only what the body names changes: null clears a field, an absent one keeps it.
        const kept = db.prepare('SELECT detail, paidFrom FROM tax_expenses WHERE accountId = ? AND id = ?').get(accountId, req.params.id) as { detail: string | null; paidFrom: string | null } | undefined;
        if (!kept) return reply.code(404).send({ error: 'not_found', message: 'No such expense.' });
        const paidFrom = e.paidFrom === undefined ? kept.paidFrom : e.paidFrom;
        const detail = e.detail === undefined ? kept.detail : e.detail ? JSON.stringify(e.detail) : null;
        const info = db
          .prepare(
            `UPDATE tax_expenses SET eventId = ?, category = ?, amountMinor = ?, currency = ?, date = ?, vendor = ?, note = ?, detail = ?, paidFrom = ?, updatedAt = ?
             WHERE accountId = ? AND id = ?`,
          )
          .run(e.eventId, e.category, Math.round(e.amount * 100), e.currency.toUpperCase(), e.date.slice(0, 10), e.vendor, e.note, detail, paidFrom, Date.now(), accountId, req.params.id);
        if (!info.changes) return reply.code(404).send({ error: 'not_found', message: 'No such expense.' });
        return { expense: listExpenses(accountId).find((x) => x.id === req.params.id) };
      });

      app.delete<{ Params: { id: string } }>('/ledger/expenses/:id', async (req, reply) => {
        const info = db.prepare('DELETE FROM tax_expenses WHERE accountId = ? AND id = ?').run(who(req).accountId, req.params.id);
        if (!info.changes) return reply.code(404).send({ error: 'not_found', message: 'No such expense.' });
        return { ok: true };
      });

      app.post<{ Params: { id: string } }>('/ledger/expenses/:id/invoice', { bodyLimit: base64BodyLimit(maxBytesFor('invoice')) }, async (req, reply) => {
        const { accountId, role, userId } = who(req);
        // Staff attach the receipt to an expense they just added, not to anyone else's.
        if (role === 'member') {
          const own = db.prepare('SELECT createdBy, invoiceName FROM tax_expenses WHERE accountId = ? AND id = ?').get(accountId, req.params.id) as { createdBy: string | null; invoiceName: string | null } | undefined;
          if (!own || own.createdBy !== userId || own.invoiceName) return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can change that expense.' });
        }
        const body = (req.body ?? {}) as { base64?: string; filename?: string };
        const name = String(body.filename ?? 'invoice.pdf').slice(0, 200);
        const file = decodeUpload('invoice', body.base64, { name });
        if (!file.ok) return sendRefusal(reply, file);
        const prev = db.prepare('SELECT COALESCE(LENGTH(invoiceBytes), 0) AS n FROM tax_expenses WHERE accountId = ? AND id = ?').get(accountId, req.params.id) as { n: number } | undefined;
        if (!prev) return reply.code(404).send({ error: 'not_found', message: 'No such expense.' });
        const over = checkQuota(db, accountId, file.bytes.length, prev.n);
        if (over) return sendRefusal(reply, over);
        db.prepare('UPDATE tax_expenses SET invoiceName = ?, invoiceBytes = ?, invoiceAt = ?, updatedAt = ? WHERE accountId = ? AND id = ?').run(
          name,
          file.bytes,
          Date.now(),
          Date.now(),
          accountId,
          req.params.id,
        );
        return { expense: listExpenses(accountId).find((x) => x.id === req.params.id) };
      });

      app.get<{ Params: { id: string } }>('/ledger/expenses/:id/invoice', async (req, reply) => {
        const row = db.prepare('SELECT invoiceName, invoiceBytes FROM tax_expenses WHERE accountId = ? AND id = ?').get(who(req).accountId, req.params.id) as
          | { invoiceName: string | null; invoiceBytes: Buffer | null }
          | undefined;
        if (!row?.invoiceBytes) return reply.code(404).send({ error: 'not_found', message: 'No invoice attached.' });
        // JSON rather than a PDF body: the client fetches with its bearer token
        // and opens a blob, since a plain link could carry no credentials.
        return { filename: row.invoiceName ?? 'invoice.pdf', base64: Buffer.from(row.invoiceBytes).toString('base64') };
      });

      /** Per-event P&L: op-log revenue against ledger expenses. */
      /**
       * The cash paid out of an event's box for expenses, for cash up to take off what the box should
       * hold. Staff see only the cash they paid themselves; the owner and admins see all of it.
       */
      app.get('/ledger/cash-spent', async (req, reply) => {
        const me = who(req);
        const eventId = (req.query as { eventId?: string }).eventId ?? '';
        if (!eventId) return reply.code(400).send({ error: 'invalid_request', message: 'Which event?' });
        if (me.allowedEventIds && !me.allowedEventIds.includes(eventId)) return reply.code(403).send({ error: 'forbidden', message: 'That event is not one of yours.' });
        const rows = listExpenses(me.accountId, eventId).filter((x) => x.paidFrom === 'cash' && (me.role !== 'member' || x.createdBy?.userId === me.userId));
        return {
          expenses: rows.map((x) => ({ id: x.id, amount: x.amount, currency: x.currency, date: x.date, vendor: x.vendor, category: x.category, createdBy: x.createdBy?.userId ?? null })),
        };
      });

      app.get('/ledger/pnl', async (req) => {
        const { accountId } = who(req);
        const expenses = listExpenses(accountId);
        const events = eventsFor(accountId);
        const known = new Set(events.map((e) => e.id));
        for (const ex of expenses) {
          if (ex.eventId && !known.has(ex.eventId)) {
            events.push({ id: ex.eventId, name: ex.eventId, venue: {}, currency: 'EUR', status: 'closed', updatedAt: 0 });
            known.add(ex.eventId);
          }
        }
        const revenue = revenueByEvent(transactionsFor(accountId));
        const rows = events
          .map((ev) => {
            const exps = expenses.filter((e) => e.eventId === ev.id);
            const expenseTotal = round2(exps.reduce((s, e) => s + e.amount, 0));
            const rev = round2(revenue[ev.id] ?? 0);
            const byCategory: Record<string, number> = {};
            for (const c of EXPENSE_CATEGORIES) byCategory[c.id] = round2(exps.filter((e) => e.category === c.id).reduce((s, e) => s + e.amount, 0));
            return {
              eventId: ev.id,
              name: ev.name || 'Event',
              country: ev.venue?.country ?? '',
              start: ev.dateStart ?? '',
              currency: ev.currency,
              revenue: rev,
              expenses: expenseTotal,
              margin: round2(rev - expenseTotal),
              expenseCount: exps.length,
              unbooked: exps.filter((e) => !e.bookedVoucherId).length,
              currencies: [...new Set(exps.map((e) => e.currency))],
              byCategory,
            };
          })
          .sort((a, b) => b.start.localeCompare(a.start));
        return { rows };
      });

      // ── For the accountant: a period's books in one zip ────────────────
      const ExportQuery = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
      app.get('/export', async (req, reply) => {
        const q = ExportQuery.safeParse(req.query);
        if (!q.success || q.data.from > q.data.to) return reply.code(400).send({ error: 'invalid_request', message: 'Give the period as two dates, first to last.' });
        const { accountId } = who(req);
        const { from, to } = q.data;
        const out = buildBooksZip({
          from,
          to,
          events: eventsFor(accountId),
          transactions: transactionsFor(accountId),
          expenses: listExpenses(accountId).filter((e) => e.date >= from && e.date <= to),
          categories: EXPENSE_CATEGORIES,
          invoiceBytes: (id) => (db.prepare('SELECT invoiceBytes FROM tax_expenses WHERE accountId = ? AND id = ?').get(accountId, id) as { invoiceBytes: Buffer | null } | undefined)?.invoiceBytes ?? null,
        });
        return { filename: out.filename, base64: Buffer.from(out.bytes).toString('base64'), counts: out.counts };
      });

      // ── Year in review ──────────────────────────────────────────────────
      // Sales and the ledger's costs the page adds up itself; what the year's
      // materials and misprints cost lives with Sourcing, read here.
      app.get<{ Params: { year: string } }>('/year/:year', async (req, reply) => {
        const year = Number(req.params.year);
        if (!Number.isInteger(year) || year < 2000 || year > 2100) return reply.code(400).send({ error: 'invalid_request', message: 'Which year?' });
        return yearMaterials(db, who(req).accountId, year);
      });

      // ── Card payments: what the phone saw paid by card, to quick-add as expenses ──
      // A card marked personal is never stored: its unadded payments go when it is marked, and
      // a payment that arrives for one is dropped on the spot.
      const cardRole = (accountId: string, last4: string): string | null | undefined =>
        (db.prepare('SELECT role FROM tax_cards WHERE accountId = ? AND last4 = ?').get(accountId, last4) as { role: string | null } | undefined)?.role;
      const cardPaymentRow = (r: { id: string; at: number; amountMinor: number; currency: string; merchant: string; last4: string; addedExpenseId: string | null }) => ({
        id: r.id,
        at: r.at,
        amount: r.amountMinor / 100,
        currency: r.currency,
        merchant: r.merchant,
        last4: r.last4,
        addedExpenseId: r.addedExpenseId,
      });

      app.get('/cards', async (req) => {
        const { accountId } = who(req);
        const marked = db.prepare('SELECT last4, role, label FROM tax_cards WHERE accountId = ?').all(accountId) as { last4: string; role: string | null; label: string }[];
        const seen = db.prepare('SELECT DISTINCT last4 FROM tax_card_payments WHERE accountId = ? AND dismissedAt IS NULL').all(accountId) as { last4: string }[];
        const known = new Map(marked.map((c) => [c.last4, c]));
        for (const { last4 } of seen) if (!known.has(last4)) known.set(last4, { last4, role: null, label: '' });
        return { cards: [...known.values()].sort((a, b) => a.last4.localeCompare(b.last4)) };
      });

      app.put<{ Params: { last4: string } }>('/cards/:last4', async (req, reply) => {
        const { accountId } = who(req);
        const last4 = req.params.last4;
        if (!/^\d{4}$/.test(last4)) return reply.code(400).send({ error: 'invalid_request', message: 'A card is named by its last four digits.' });
        const body = CardBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Mark the card business or personal.' });
        db.prepare('INSERT INTO tax_cards (accountId, last4, role, label) VALUES (?, ?, ?, ?) ON CONFLICT (accountId, last4) DO UPDATE SET role = excluded.role, label = excluded.label').run(accountId, last4, body.data.role, body.data.label);
        if (body.data.role === 'personal') db.prepare('DELETE FROM tax_card_payments WHERE accountId = ? AND last4 = ? AND addedExpenseId IS NULL').run(accountId, last4);
        return { ok: true };
      });

      app.get('/card-payments', async (req) => {
        const { accountId } = who(req);
        const rows = db
          .prepare(
            `SELECT p.id, p.at, p.amountMinor, p.currency, p.merchant, p.last4, p.addedExpenseId
               FROM tax_card_payments p
               LEFT JOIN tax_cards c ON c.accountId = p.accountId AND c.last4 = p.last4
              WHERE p.accountId = ? AND p.dismissedAt IS NULL AND (c.role IS NULL OR c.role <> 'personal')
              ORDER BY p.at DESC LIMIT 200`,
          )
          .all(accountId) as Parameters<typeof cardPaymentRow>[0][];
        return { payments: rows.map(cardPaymentRow) };
      });

      app.post('/card-payments', async (req, reply) => {
        const { accountId, userId } = who(req);
        const body = CardPaymentBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Check the payment fields.' });
        const p = body.data;
        if (cardRole(accountId, p.last4) === 'personal') return reply.code(200).send({ stored: false, duplicate: false });
        if (p.last4) db.prepare('INSERT OR IGNORE INTO tax_cards (accountId, last4, role, label) VALUES (?, ?, NULL, ?)').run(accountId, p.last4, '');
        const res = db
          .prepare('INSERT OR IGNORE INTO tax_card_payments (accountId, id, at, amountMinor, currency, merchant, last4, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(accountId, p.id, p.at, Math.round(p.amount * 100), p.currency.toUpperCase(), p.merchant, p.last4, userId);
        return reply.code(res.changes ? 201 : 200).send({ stored: true, duplicate: !res.changes });
      });

      app.post<{ Params: { id: string } }>('/card-payments/:id/add', async (req, reply) => {
        const me = who(req);
        const row = db
          .prepare(
            `SELECT p.at, p.amountMinor, p.currency, p.merchant, p.last4, p.dismissedAt, c.role
               FROM tax_card_payments p LEFT JOIN tax_cards c ON c.accountId = p.accountId AND c.last4 = p.last4
              WHERE p.accountId = ? AND p.id = ?`,
          )
          .get(me.accountId, req.params.id) as { at: number; amountMinor: number; currency: string; merchant: string; last4: string; dismissedAt: number | null; role: string | null } | undefined;
        if (!row || row.dismissedAt || row.role === 'personal') return reply.code(404).send({ error: 'not_found', message: 'No such card payment.' });
        const body = AddCardPaymentBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid', message: 'Pick the event and the category.' });
        const e = body.data;
        if (me.allowedEventIds && !me.allowedEventIds.includes(e.eventId)) return reply.code(403).send({ error: 'forbidden', message: 'That event is not one of yours.' });
        const now = Date.now();
        const id = randomUUID();
        const date = new Date(row.at).toISOString().slice(0, 10);
        db.prepare(
          `INSERT INTO tax_expenses (accountId, id, eventId, category, amountMinor, currency, date, vendor, note, createdBy, paidFrom, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'card', ?, ?)`,
        ).run(me.accountId, id, e.eventId, e.category, row.amountMinor, row.currency, date, e.vendor || row.merchant, e.note, me.userId, now, now);
        db.prepare('UPDATE tax_card_payments SET addedExpenseId = ? WHERE accountId = ? AND id = ?').run(id, me.accountId, req.params.id);
        return reply.code(201).send({ expense: listExpenses(me.accountId).find((x) => x.id === id) });
      });

      app.delete<{ Params: { id: string } }>('/card-payments/:id', async (req) => {
        db.prepare('UPDATE tax_card_payments SET dismissedAt = ? WHERE accountId = ? AND id = ?').run(Date.now(), who(req).accountId, req.params.id);
        return { ok: true };
      });

      // ── Invoice scanning ────────────────────────────────────────────────
      const dayOf = (): string => new Date().toISOString().slice(0, 10);
      const usageFor = (accountId: string) => {
        const row = db.prepare('SELECT day, calls, tokens FROM tax_ai_usage WHERE accountId = ?').get(accountId) as { day: string; calls: number; tokens: number } | undefined;
        return row && row.day === dayOf() ? row : { day: dayOf(), calls: 0, tokens: 0 };
      };

      app.post('/ledger/parse', { bodyLimit: base64BodyLimit(maxBytesFor('invoiceScan')) }, async (req, reply) => {
        const { accountId } = who(req);
        const ai = clientsFor(accountId).ai;
        if (!ai.apiKey) return reply.code(503).send({ error: 'not_configured', message: 'Invoice scanning is off - add an Anthropic API key under Settings → Integrations.' });
        // The configured cap (ai.maxPdfBytes) can only tighten the shared one; the type is read from the bytes either way.
        const scan = decodeUpload('invoiceScan', (req.body as { base64?: string } | undefined)?.base64);
        if (!scan.ok) return sendRefusal(reply, scan);
        if (scan.bytes.length > ai.maxPdfBytes) {
          return reply.code(413).send({ error: 'too_large', message: `PDF too large (max ${Math.round(ai.maxPdfBytes / 1024 / 1024)} MB).` });
        }
        const base64 = scan.bytes.toString('base64');
        const used = usageFor(accountId);
        if (used.calls >= ai.dailyCalls || used.tokens >= ai.dailyTokens) {
          return reply.code(429).send({ error: 'quota', message: 'The daily invoice-scan limit has been reached. Try again tomorrow.' });
        }
        const { fields, usage } = await parseInvoicePdf(base64, ai);
        // Real token spend is counted after the call: the guard is the bill cap.
        db.prepare(
          `INSERT INTO tax_ai_usage (accountId, day, calls, tokens) VALUES (?, ?, ?, ?)
           ON CONFLICT(accountId) DO UPDATE SET day = excluded.day, calls = excluded.calls, tokens = excluded.tokens`,
        ).run(accountId, used.day, used.calls + 1, used.tokens + usage.inputTokens + usage.outputTokens);
        const { match, candidates } = matchEvent(fields, eventsFor(accountId));
        return { fields, match, candidates, remainingToday: Math.max(0, ai.dailyCalls - used.calls - 1) };
      });
    },
  };
}
