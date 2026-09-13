import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ModuleContext, ServerModule } from '@zollify/server-core';

/**
 * Tax — the server half.
 *
 * This is the reference implementation of a server module: it owns its own
 * tables, receives the caller's identity rather than deriving it, and scopes
 * every query by accountId. Authentication, the account's entitlement for this
 * module, and the minimum role are all enforced by the gateway before any of
 * this runs.
 *
 * Outbound EN16931 e-invoices (Factur-X / XRechnung / UBL / CII) belong here
 * too — `e-invoice-eu` is a TypeScript library under a permissive licence that
 * takes JSON in, which fits this module exactly. It is a server-side concern:
 * invoice generation needs the ledger and the tenant's Lexware credentials,
 * neither of which should ever reach a browser.
 */

const RecordSale = z.object({
  saleId: z.string().min(1).max(64),
  eventId: z.string().max(64).nullable().optional(),
  at: z.number().int().nonnegative(),
  currency: z.string().length(3),
  total: z.number().finite(),
  provider: z.string().max(64),
});

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tax_sales (
      accountId TEXT NOT NULL,
      saleId    TEXT NOT NULL,
      eventId   TEXT,
      at        INTEGER NOT NULL,
      currency  TEXT NOT NULL,
      totalMinor INTEGER NOT NULL,
      provider  TEXT NOT NULL,
      bookedAt  INTEGER NOT NULL,
      PRIMARY KEY (accountId, saleId)
    );
    CREATE INDEX IF NOT EXISTS idx_tax_sales_account_at ON tax_sales(accountId, at);
  `);
}

export const taxServerModule: ServerModule = {
  id: 'tax',
  // Booking revenue is not a helper's job.
  minRole: 'admin',
  migrate,

  routes: (ctx: ModuleContext) => async (app) => {
    /**
     * Books a completed sale. The client sends this after POS emits `sale`;
     * POS itself never calls Tax, and Tax never imports POS.
     */
    app.post('/sales', async (req, reply) => {
      const who = ctx.identity(req);
      const parsed = RecordSale.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: 'Malformed sale payload.' });
      }
      const sale = parsed.data;

      // Money is stored in integer minor units. Float columns in a ledger are
      // how a cash-up ends up a rappen out and nobody can say where.
      const totalMinor = Math.round(sale.total * 100);

      ctx.db
        .prepare(
          `INSERT INTO tax_sales (accountId, saleId, eventId, at, currency, totalMinor, provider, bookedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(accountId, saleId) DO NOTHING`,
        )
        .run(
          who.accountId,
          sale.saleId,
          sale.eventId ?? null,
          sale.at,
          sale.currency,
          totalMinor,
          sale.provider,
          Date.now(),
        );

      return reply.code(201).send({ ok: true, saleId: sale.saleId });
    });

    /** Revenue summary. Scoped to the caller's account by the query itself. */
    app.get<{ Querystring: { from?: string; to?: string } }>('/summary', async (req) => {
      const who = ctx.identity(req);
      const from = Number(req.query.from ?? 0);
      const to = Number(req.query.to ?? Date.now());

      const rows = ctx.db
        .prepare(
          `SELECT currency, COUNT(*) AS sales, SUM(totalMinor) AS totalMinor
           FROM tax_sales
           WHERE accountId = ? AND at >= ? AND at <= ?
           GROUP BY currency`,
        )
        .all(who.accountId, from, to) as { currency: string; sales: number; totalMinor: number }[];

      return {
        from,
        to,
        byCurrency: rows.map((r) => ({
          currency: r.currency,
          sales: r.sales,
          total: r.totalMinor / 100,
        })),
      };
    });
  },
};
