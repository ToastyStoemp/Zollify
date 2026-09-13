import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SalesEvent, Transaction } from '@zollify/shared';
import {
  makeSecretBox,
  reduceEvents,
  reduceMerges,
  reduceTransactions,
  type ModuleContext,
  type ServerModule,
} from '@zollify/server-core';
import { CONFIG_GROUPS, applyConfigPatch, effectiveValues, emptyConfig, enabledMap, redactConfig, type TaxConfig } from './config';
import { MyposClient, loadMyposConfig, summarize } from './mypos';
import { SumupClient, loadSumupConfig } from './sumup';
import { ShopifyOrdersClient, loadShopifyConfig } from './shopify';
import { LexwareClient, buildFeeVoucher, buildRevenueVoucher, resolveCategoryId } from './lexware';
import { loadAiConfig, matchEvent, parseInvoicePdf, pingAiKey } from './invoice-ai';
import { round2, type KvCache } from './types';

/**
 * Tax — the server half (the ZollTax port).
 *
 * Holds each account's integration credentials encrypted at rest, talks to
 * myPOS / SumUp / Shopify / Lexware / Anthropic on the account's behalf, and
 * keeps the ledger of per-event expenses. Events and sales come from the
 * account's own op-log — the ZollTool read-token dance is gone.
 *
 * The clustering of payments into conventions stays in the browser, as it
 * was in ZollTax; this half only fetches rows, verifies, books and remembers
 * what was booked.
 */

const SECRET_SALT = 'zollify-module-credentials-v1';

const EXPENSE_CATEGORIES = [
  { id: 'booth', label: 'Booth / table fee' },
  { id: 'travel', label: 'Travel' },
  { id: 'accommodation', label: 'Accommodation' },
  { id: 'other', label: 'Other' },
] as const;
const CATEGORY_IDS = EXPENSE_CATEGORIES.map((c) => c.id) as unknown as [string, ...string[]];

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
  `);
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
  pdfBase64: z.string().max(20_000_000).optional(),
  filename: z.string().max(120).optional(),
});

const ExpenseBody = z.object({
  eventId: z.string().max(64).default(''),
  category: z.enum(CATEGORY_IDS).default('other'),
  amount: z.number().finite().nonnegative(),
  currency: z.string().length(3).default('EUR'),
  date: z.string().max(10).default(''),
  vendor: z.string().max(200).default(''),
  note: z.string().max(1000).default(''),
});

// ── Module ──────────────────────────────────────────────────────────────────

export function taxServerModule(jwtSecret: string): ServerModule {
  const box = makeSecretBox(jwtSecret, SECRET_SALT);

  return {
    id: 'tax',
    minRole: 'admin',
    migrate,

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
          const base = t.baseTotal != null ? Number(t.baseTotal) : (Number(t.total) || 0) / (t.exchangeRate || 1);
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
              return { ok: true, detail: `Connected${p.companyName ? ` — ${p.companyName}` : ''}.` };
            }
            case 'mypos': {
              if (c.mypos.mode !== 'live') return { ok: false, detail: 'Missing myPOS credentials.' };
              const accounts = await c.mypos.listAccounts();
              return { ok: true, detail: `Authenticated — ${accounts.length} account(s).` };
            }
            case 'shopify': {
              const st = await c.shopify.status(true);
              if (st.mode !== 'live') return { ok: false, detail: 'Missing Shopify credentials.' };
              if (!st.ready) return { ok: false, detail: st.error ?? 'Token exchange failed — check the client ID/secret.' };
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
              return p.ok ? { ok: true, detail: `API key valid — using ${c.ai.model}.` } : { ok: false, detail: p.detail ?? 'Key check failed.' };
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
        for (const t of transactionsFor(accountId)) {
          if (t.eventId !== req.params.eventId || t.revertedBy || t.revertedAt) continue;
          const legs = t.payments.filter((p) => p.kind === 'cash');
          if (!legs.length) continue;
          cash += legs.reduce((s, p) => s + (Number(p.amount) || 0), 0) / (t.exchangeRate || 1);
          currency = t.baseCurrency ?? t.currency ?? currency;
          count++;
        }
        return { eventId: req.params.eventId, cash: round2(cash), currency, count };
      });

      // ── Payment sources ─────────────────────────────────────────────────
      app.get('/mypos/accounts', async (req) => {
        const c = clientsFor(who(req).accountId);
        return { mode: c.mypos.mode, accounts: await c.mypos.listAccounts() };
      });

      app.get('/mypos/transactions', async (req, reply) => {
        const q = req.query as Record<string, string>;
        const range = Range.safeParse(q);
        if (!range.success) return reply.code(400).send({ error: 'invalid', message: 'from and to are required (YYYY-MM-DD).' });
        const c = clientsFor(who(req).accountId);
        const accounts = q.accounts ? q.accounts.split(',').filter(Boolean) : undefined;
        const transactions = await c.mypos.listTransactions({ ...range.data, accounts });
        return { mode: c.mypos.mode, count: transactions.length, ...range.data, transactions };
      });

      app.get('/mypos/verify', async (req, reply) => {
        const q = req.query as Record<string, string>;
        const range = Range.safeParse(q);
        if (!range.success) return reply.code(400).send({ error: 'invalid', message: 'from and to are required (YYYY-MM-DD).' });
        const c = clientsFor(who(req).accountId);
        const txns = await c.mypos.listTransactions({ ...range.data, account: q.account || undefined });
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
        const transactions = await c.sumup.listTransactions(range.data.from, range.data.to);
        return { mode: c.sumup.mode, count: transactions.length, ...range.data, transactions };
      });

      // ── Lexware booking ─────────────────────────────────────────────────
      app.post('/lexware/book', async (req, reply) => {
        const { accountId } = who(req);
        const parsed = BookBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid', message: parsed.error.issues[0]?.message ?? 'Malformed booking.' });
        const p = parsed.data;
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
        if (p.kind === 'revenue' && customerName && p.customer !== 'collective') {
          voucher.contactId = await client.ensureCustomerContact(customerName);
          delete voucher.useCollectiveContact;
        }
        const created = await client.createVoucher(voucher);
        if (p.pdfBase64) {
          await client.uploadVoucherFile(created.id, Buffer.from(p.pdfBase64, 'base64'), p.filename ?? `${p.voucherNumber}.pdf`);
        }
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
        createdAt: number;
        updatedAt: number;
      }
      const EXPENSE_COLS = 'id, eventId, category, amountMinor, currency, date, vendor, note, invoiceName, invoiceAt, bookedVoucherId, createdAt, updatedAt';
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

      app.post('/ledger/expenses', async (req, reply) => {
        const { accountId } = who(req);
        const parsed = ExpenseBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid', message: 'Check the expense fields.' });
        const e = parsed.data;
        const now = Date.now();
        const id = randomUUID();
        db.prepare(
          `INSERT INTO tax_expenses (accountId, id, eventId, category, amountMinor, currency, date, vendor, note, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(accountId, id, e.eventId, e.category, Math.round(e.amount * 100), e.currency.toUpperCase(), e.date.slice(0, 10), e.vendor, e.note, now, now);
        return reply.code(201).send({ expense: listExpenses(accountId).find((x) => x.id === id) });
      });

      app.put<{ Params: { id: string } }>('/ledger/expenses/:id', async (req, reply) => {
        const { accountId } = who(req);
        const parsed = ExpenseBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid', message: 'Check the expense fields.' });
        const e = parsed.data;
        const info = db
          .prepare(
            `UPDATE tax_expenses SET eventId = ?, category = ?, amountMinor = ?, currency = ?, date = ?, vendor = ?, note = ?, updatedAt = ?
             WHERE accountId = ? AND id = ?`,
          )
          .run(e.eventId, e.category, Math.round(e.amount * 100), e.currency.toUpperCase(), e.date.slice(0, 10), e.vendor, e.note, Date.now(), accountId, req.params.id);
        if (!info.changes) return reply.code(404).send({ error: 'not_found', message: 'No such expense.' });
        return { expense: listExpenses(accountId).find((x) => x.id === req.params.id) };
      });

      app.delete<{ Params: { id: string } }>('/ledger/expenses/:id', async (req, reply) => {
        const info = db.prepare('DELETE FROM tax_expenses WHERE accountId = ? AND id = ?').run(who(req).accountId, req.params.id);
        if (!info.changes) return reply.code(404).send({ error: 'not_found', message: 'No such expense.' });
        return { ok: true };
      });

      app.post<{ Params: { id: string } }>('/ledger/expenses/:id/invoice', async (req, reply) => {
        const { accountId } = who(req);
        const body = (req.body ?? {}) as { base64?: string; filename?: string };
        const bytes = Buffer.from(String(body.base64 ?? ''), 'base64');
        if (!bytes.length) return reply.code(400).send({ error: 'invalid', message: 'The file was empty.' });
        if (bytes.length > 10 * 1024 * 1024) return reply.code(413).send({ error: 'too_large', message: 'Invoices are capped at 10 MB.' });
        const name = String(body.filename ?? 'invoice.pdf').slice(0, 200);
        const info = db
          .prepare('UPDATE tax_expenses SET invoiceName = ?, invoiceBytes = ?, invoiceAt = ?, updatedAt = ? WHERE accountId = ? AND id = ?')
          .run(name, bytes, Date.now(), Date.now(), accountId, req.params.id);
        if (!info.changes) return reply.code(404).send({ error: 'not_found', message: 'No such expense.' });
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

      // ── Invoice scanning ────────────────────────────────────────────────
      const dayOf = (): string => new Date().toISOString().slice(0, 10);
      const usageFor = (accountId: string) => {
        const row = db.prepare('SELECT day, calls, tokens FROM tax_ai_usage WHERE accountId = ?').get(accountId) as { day: string; calls: number; tokens: number } | undefined;
        return row && row.day === dayOf() ? row : { day: dayOf(), calls: 0, tokens: 0 };
      };

      app.post('/ledger/parse', async (req, reply) => {
        const { accountId } = who(req);
        const ai = clientsFor(accountId).ai;
        if (!ai.apiKey) return reply.code(503).send({ error: 'not_configured', message: 'Invoice scanning is off — add an Anthropic API key under Settings → Integrations.' });
        const base64 = String((req.body as { base64?: string } | undefined)?.base64 ?? '');
        if (!base64) return reply.code(400).send({ error: 'invalid', message: 'No PDF provided.' });
        if (Math.floor((base64.length * 3) / 4) > ai.maxPdfBytes) {
          return reply.code(413).send({ error: 'too_large', message: `PDF too large (max ${Math.round(ai.maxPdfBytes / 1024 / 1024)} MB).` });
        }
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
