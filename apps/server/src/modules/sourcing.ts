import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ModuleContext, ServerModule } from '@boothly/server-core';

/**
 * Sourcing — the server half.
 *
 * Supplier contacts and reorder drafts live here rather than in the browser, so
 * they belong to the account rather than to whichever device happened to create
 * them — and so any future Alibaba credentials have somewhere to sit that is
 * not a WebView.
 *
 * Every query is scoped by accountId. The gateway has already checked
 * authentication, this account's entitlement for the module, and the minimum
 * role before any of this runs.
 */

const SupplierBody = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  contactEmail: z.string().email().max(320).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const DraftBody = z.object({
  supplierId: z.string().min(1).max(64),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1).max(64),
        title: z.string().min(1).max(300),
        qty: z.number().int().positive().max(100_000),
      }),
    )
    .min(1)
    .max(500),
});

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sourcing_suppliers (
      accountId    TEXT NOT NULL,
      id           TEXT NOT NULL,
      name         TEXT NOT NULL,
      contactEmail TEXT,
      notes        TEXT,
      updatedAt    INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE TABLE IF NOT EXISTS sourcing_drafts (
      accountId  TEXT NOT NULL,
      id         TEXT NOT NULL,
      supplierId TEXT NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('draft','sent')),
      lines      TEXT NOT NULL,
      createdAt  INTEGER NOT NULL,
      sentAt     INTEGER,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_sourcing_drafts_account ON sourcing_drafts(accountId, createdAt);
  `);
}

interface DraftRow {
  id: string;
  supplierId: string;
  status: 'draft' | 'sent';
  lines: string;
  createdAt: number;
  sentAt: number | null;
}

export const sourcingServerModule: ServerModule = {
  id: 'sourcing',
  minRole: 'admin',
  migrate,

  routes: (ctx: ModuleContext) => async (app) => {
    app.get('/suppliers', async (req) => {
      const who = ctx.identity(req);
      const suppliers = ctx.db
        .prepare(
          `SELECT id, name, contactEmail, notes, updatedAt
           FROM sourcing_suppliers WHERE accountId = ? ORDER BY name`,
        )
        .all(who.accountId);
      return { suppliers };
    });

    app.post('/suppliers', async (req, reply) => {
      const who = ctx.identity(req);
      const parsed = SupplierBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: 'Supplier name is required.' });
      }
      const s = parsed.data;
      const updatedAt = Date.now();

      ctx.db
        .prepare(
          `INSERT INTO sourcing_suppliers (accountId, id, name, contactEmail, notes, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(accountId, id) DO UPDATE SET
             name = excluded.name,
             contactEmail = excluded.contactEmail,
             notes = excluded.notes,
             updatedAt = excluded.updatedAt`,
        )
        .run(who.accountId, s.id, s.name, s.contactEmail ?? null, s.notes ?? null, updatedAt);

      return { supplier: { ...s, contactEmail: s.contactEmail ?? null, notes: s.notes ?? null, updatedAt } };
    });

    app.delete<{ Params: { id: string } }>('/suppliers/:id', async (req) => {
      const who = ctx.identity(req);
      // Scoped by accountId in the statement itself, so an id from another
      // tenant simply matches nothing.
      ctx.db
        .prepare('DELETE FROM sourcing_suppliers WHERE accountId = ? AND id = ?')
        .run(who.accountId, req.params.id);
      return { ok: true };
    });

    app.get('/drafts', async (req) => {
      const who = ctx.identity(req);
      const rows = ctx.db
        .prepare(
          `SELECT id, supplierId, status, lines, createdAt, sentAt
           FROM sourcing_drafts WHERE accountId = ? ORDER BY createdAt DESC LIMIT 200`,
        )
        .all(who.accountId) as DraftRow[];

      return {
        drafts: rows.map((r) => ({ ...r, lines: JSON.parse(r.lines) as unknown })),
      };
    });

    app.post('/drafts', async (req, reply) => {
      const who = ctx.identity(req);
      const parsed = DraftBody.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', message: 'A draft needs a supplier and at least one line.' });
      }

      const supplierExists = ctx.db
        .prepare('SELECT 1 FROM sourcing_suppliers WHERE accountId = ? AND id = ?')
        .get(who.accountId, parsed.data.supplierId);
      if (!supplierExists) {
        return reply.code(404).send({ error: 'unknown_supplier', message: 'No such supplier.' });
      }

      const draft = {
        id: crypto.randomUUID(),
        supplierId: parsed.data.supplierId,
        status: 'draft' as const,
        lines: parsed.data.lines,
        createdAt: Date.now(),
        sentAt: null,
      };

      ctx.db
        .prepare(
          `INSERT INTO sourcing_drafts (accountId, id, supplierId, status, lines, createdAt, sentAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          who.accountId,
          draft.id,
          draft.supplierId,
          draft.status,
          JSON.stringify(draft.lines),
          draft.createdAt,
          null,
        );

      return reply.code(201).send({ draft });
    });

    app.post<{ Params: { id: string } }>('/drafts/:id/sent', async (req, reply) => {
      const who = ctx.identity(req);
      const sentAt = Date.now();
      const result = ctx.db
        .prepare(
          `UPDATE sourcing_drafts SET status = 'sent', sentAt = ?
           WHERE accountId = ? AND id = ? AND status = 'draft'`,
        )
        .run(sentAt, who.accountId, req.params.id);

      if (result.changes === 0) {
        return reply.code(404).send({ error: 'not_found', message: 'No open draft with that id.' });
      }
      return { draft: { id: req.params.id, status: 'sent', sentAt } };
    });
  },
};
