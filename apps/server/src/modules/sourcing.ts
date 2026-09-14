import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ModuleContext, ServerModule } from '@zollify/server-core';

/**
 * Sourcing — the server half, ported from ZollSource.
 *
 * Suppliers, reps, product dossiers, reorders, issues and materials are
 * small documents; they live server-side because supplier contacts must not
 * sit in a browser, and because the reorder board is shared by everyone on
 * the account. Design files are stored as bytes here so a reorder's zip can
 * be built from any device. All reasoning (specs, restock maths, costs)
 * happens in the client half against core data it reads through the SDK.
 */

const COLLECTIONS = ['suppliers', 'reps', 'dossiers', 'reorders', 'issues', 'materials'] as const;
type Coll = (typeof COLLECTIONS)[number];

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sourcing_docs (
      accountId TEXT NOT NULL,
      coll      TEXT NOT NULL,
      id        TEXT NOT NULL,
      doc       TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, coll, id)
    );
    CREATE TABLE IF NOT EXISTS sourcing_files (
      accountId TEXT NOT NULL,
      id        TEXT NOT NULL,
      dossierId TEXT NOT NULL,
      kind      TEXT NOT NULL,
      filename  TEXT NOT NULL,
      mime      TEXT NOT NULL,
      size      INTEGER NOT NULL,
      version   INTEGER NOT NULL,
      approval  TEXT,
      note      TEXT,
      bytes     BLOB NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_sourcing_files_dossier ON sourcing_files(accountId, dossierId);
  `);
}

const Doc = z.object({ id: z.string().min(1).max(80) }).passthrough();
const FileBody = z.object({
  dossierId: z.string().min(1),
  filename: z.string().min(1).max(200),
  mime: z.string().max(120).default('application/octet-stream'),
  kind: z.enum(['design', 'proof']).default('design'),
  dataB64: z.string().min(1),
});
const Approval = z.object({ approval: z.enum(['approved', 'rejected', 'pending']), note: z.string().max(500).optional() });

/** 25 MB of base64 — a PSD or a print-ready PDF, not a video. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const isColl = (s: string): s is Coll => (COLLECTIONS as readonly string[]).includes(s);

export const sourcingServerModule: ServerModule = {
  id: 'sourcing',
  minRole: 'admin',
  migrate,

  routes: (ctx: ModuleContext) => async (app) => {
    /** Everything the cockpit needs, in one shot. */
    app.get('/snapshot', async (req) => {
      const who = ctx.identity(req);
      const rows = ctx.db.prepare('SELECT coll, doc FROM sourcing_docs WHERE accountId = ?').all(who.accountId) as { coll: string; doc: string }[];
      const out: Record<string, unknown[]> = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
      for (const r of rows) out[r.coll]?.push(JSON.parse(r.doc));
      const files = ctx.db
        .prepare('SELECT id, dossierId, kind, filename, mime, size, version, approval, note, createdAt FROM sourcing_files WHERE accountId = ? ORDER BY createdAt')
        .all(who.accountId);
      return { ...out, files };
    });

    app.put<{ Params: { coll: string; id: string } }>('/:coll/:id', async (req, reply) => {
      const who = ctx.identity(req);
      if (!isColl(req.params.coll)) return reply.code(404).send({ error: 'not_found' });
      const parsed = Doc.safeParse(req.body);
      if (!parsed.success || parsed.data.id !== req.params.id) return reply.code(400).send({ error: 'invalid_request', message: 'That record is not valid.' });
      const updatedAt = Date.now();
      const doc = { ...parsed.data, updatedAt };
      ctx.db
        .prepare(
          `INSERT INTO sourcing_docs (accountId, coll, id, doc, updatedAt) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(accountId, coll, id) DO UPDATE SET doc = excluded.doc, updatedAt = excluded.updatedAt`,
        )
        .run(who.accountId, req.params.coll, req.params.id, JSON.stringify(doc), updatedAt);
      return { doc };
    });

    app.delete<{ Params: { coll: string; id: string } }>('/:coll/:id', async (req, reply) => {
      const who = ctx.identity(req);
      if (!isColl(req.params.coll)) return reply.code(404).send({ error: 'not_found' });
      ctx.db.transaction(() => {
        ctx.db.prepare('DELETE FROM sourcing_docs WHERE accountId = ? AND coll = ? AND id = ?').run(who.accountId, req.params.coll, req.params.id);
        if (req.params.coll === 'dossiers') ctx.db.prepare('DELETE FROM sourcing_files WHERE accountId = ? AND dossierId = ?').run(who.accountId, req.params.id);
        if (req.params.coll === 'suppliers') {
          ctx.db.prepare("DELETE FROM sourcing_docs WHERE accountId = ? AND coll = 'reps' AND json_extract(doc, '$.supplierId') = ?").run(who.accountId, req.params.id);
        }
      })();
      return { ok: true };
    });

    // ── Design files and proofs ───────────────────────────────────────────
    app.post('/files', async (req, reply) => {
      const who = ctx.identity(req);
      const parsed = FileBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'A file needs a dossier, a name and its bytes.' });
      const f = parsed.data;
      const bytes = Buffer.from(f.dataB64, 'base64');
      if (!bytes.length || bytes.length > MAX_FILE_BYTES) return reply.code(413).send({ error: 'too_large', message: 'Files up to 25 MB.' });
      // Re-uploading the same filename keeps a version trail.
      const prev = ctx.db
        .prepare('SELECT MAX(version) AS v FROM sourcing_files WHERE accountId = ? AND dossierId = ? AND filename = ?')
        .get(who.accountId, f.dossierId, f.filename) as { v: number | null };
      const meta = { id: crypto.randomUUID(), dossierId: f.dossierId, kind: f.kind, filename: f.filename, mime: f.mime, size: bytes.length, version: (prev.v ?? 0) + 1, approval: f.kind === 'proof' ? 'pending' : null, note: null, createdAt: Date.now() };
      ctx.db
        .prepare('INSERT INTO sourcing_files (accountId, id, dossierId, kind, filename, mime, size, version, approval, note, bytes, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(who.accountId, meta.id, meta.dossierId, meta.kind, meta.filename, meta.mime, meta.size, meta.version, meta.approval, meta.note, bytes, meta.createdAt);
      return reply.code(201).send({ file: meta });
    });

    /** The bytes, base64 in JSON — the SDK's client speaks JSON, and a design file is a few MB at most. */
    app.get<{ Params: { id: string } }>('/files/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const row = ctx.db.prepare('SELECT filename, mime, bytes FROM sourcing_files WHERE accountId = ? AND id = ?').get(who.accountId, req.params.id) as
        | { filename: string; mime: string; bytes: Buffer }
        | undefined;
      if (!row) return reply.code(404).send({ error: 'not_found' });
      return { filename: row.filename, mime: row.mime, dataB64: row.bytes.toString('base64') };
    });

    app.post<{ Params: { id: string } }>('/files/:id/approval', async (req, reply) => {
      const who = ctx.identity(req);
      const parsed = Approval.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      ctx.db.prepare('UPDATE sourcing_files SET approval = ?, note = ? WHERE accountId = ? AND id = ?').run(parsed.data.approval, parsed.data.note ?? null, who.accountId, req.params.id);
      return { ok: true };
    });

    app.delete<{ Params: { id: string } }>('/files/:id', async (req) => {
      const who = ctx.identity(req);
      ctx.db.prepare('DELETE FROM sourcing_files WHERE accountId = ? AND id = ?').run(who.accountId, req.params.id);
      return { ok: true };
    });
  },
};
