import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  PeppolDocumentInputSchema,
  PeppolPartySchema,
  PeppolSettingsSchema,
  emptyPeppolSettings,
  localDay,
  PeppolStoredSettingsSchema,
  peppolSellerFromProfile,
  peppolTotals,
  resolvePeppolSettings,
  peppolUbl,
  structuredReference,
  validatePeppol,
  type PeppolDocument,
  type PeppolLine,
  type PeppolParty,
  type PeppolSettings,
  type ArtistDetails,
  type Transaction,
} from '@zollify/shared';
import { makeSecretBox, parseProfile, reduceMerges, reduceTransactions, reportProblem, resolveProblem, type ModuleContext, type ServerModule } from '@zollify/server-core';
import { ACCESS_POINTS, AccessPointSchema, sendViaAccessPoint, type AccessPointConfig } from './peppol-access-points';

/** A Belgian invoice is dated by the Belgian calendar, whatever the server's clock zone. */
const PEPPOL_TZ = 'Europe/Brussels';

/**
 * Belgian e-invoices over Peppol - the server half.
 *
 * Documents live here rather than on devices because Belgian invoices need
 * one gap-free sequence: drafts carry no number, and issuing takes the next
 * one in a transaction, so two devices can never hand out the same number
 * and a discarded draft never leaves a hole. Once issued, an invoice is
 * frozen - its UBL is stored and served as it was - and corrections are
 * credit notes, as the law wants.
 *
 * Sending goes through a Peppol access point the business has an account
 * with; its API key is kept encrypted. Without one, the UBL downloads for
 * uploading anywhere.
 */

export const PEPPOL_MODULE_ID = 'peppol-be';

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS peppol_settings (
      accountId TEXT PRIMARY KEY,
      doc       TEXT NOT NULL,
      accessPoint TEXT
    );
    CREATE TABLE IF NOT EXISTS peppol_customers (
      accountId TEXT NOT NULL,
      id        TEXT NOT NULL,
      doc       TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE TABLE IF NOT EXISTS peppol_documents (
      accountId TEXT NOT NULL,
      id        TEXT NOT NULL,
      number    TEXT,
      doc       TEXT NOT NULL,
      xml       TEXT,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_peppol_number ON peppol_documents(accountId, number) WHERE number IS NOT NULL;
    CREATE TABLE IF NOT EXISTS peppol_counters (
      accountId TEXT NOT NULL,
      series    TEXT NOT NULL,
      next      INTEGER NOT NULL,
      PRIMARY KEY (accountId, series)
    );
  `);
}

// ── Data ────────────────────────────────────────────────────────────────────

/**
 * What the business stored here: only what differs from the business profile.
 * A blank seller field means "as on the profile" - see resolvePeppolSettings.
 */
function storedOf(db: Database.Database, accountId: string): z.infer<typeof PeppolStoredSettingsSchema> {
  const row = db.prepare('SELECT doc FROM peppol_settings WHERE accountId = ?').get(accountId) as { doc: string } | undefined;
  const parsed = PeppolStoredSettingsSchema.safeParse(row ? JSON.parse(row.doc) : {});
  return parsed.success ? parsed.data : PeppolStoredSettingsSchema.parse({});
}
function artistOf(db: Database.Database, accountId: string): ArtistDetails {
  const row = db.prepare('SELECT profile FROM accounts WHERE id = ?').get(accountId) as { profile: string | null } | undefined;
  return parseProfile(row?.profile).artist;
}
/** The settings invoices are made from: stored values over the business profile. Issued invoices keep their own stored UBL and never come back here. */
function settingsOf(db: Database.Database, accountId: string): PeppolSettings {
  return resolvePeppolSettings(storedOf(db, accountId), artistOf(db, accountId));
}
function docsOf(db: Database.Database, accountId: string): PeppolDocument[] {
  return (db.prepare('SELECT doc FROM peppol_documents WHERE accountId = ? ORDER BY createdAt DESC').all(accountId) as { doc: string }[]).map((r) => JSON.parse(r.doc) as PeppolDocument);
}
function docOf(db: Database.Database, accountId: string, id: string): { doc: PeppolDocument; xml: string | null } | null {
  const row = db.prepare('SELECT doc, xml FROM peppol_documents WHERE accountId = ? AND id = ?').get(accountId, id) as { doc: string; xml: string | null } | undefined;
  return row ? { doc: JSON.parse(row.doc) as PeppolDocument, xml: row.xml } : null;
}
function saveDoc(db: Database.Database, accountId: string, doc: PeppolDocument, xml: string | null = null): void {
  db.prepare(
    `INSERT INTO peppol_documents (accountId, id, number, doc, xml, createdAt) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (accountId, id) DO UPDATE SET number = excluded.number, doc = excluded.doc, xml = COALESCE(excluded.xml, peppol_documents.xml)`,
  ).run(accountId, doc.id, doc.number, JSON.stringify(doc), xml, doc.createdAt);
}

/** What the list shows of a document: enough to find and pay it, without every line. */
const summary = (d: PeppolDocument) => ({
  id: d.id,
  kind: d.kind,
  number: d.number,
  status: d.status,
  issueDate: d.issueDate,
  dueDate: d.dueDate ?? null,
  buyer: d.buyer.name,
  total: peppolTotals(d.lines).payable,
  currency: d.currency,
  sentVia: d.sentVia ?? null,
});

const StatusBody = z.object({ status: z.enum(['sent', 'paid', 'issued']) });
const CustomerBody = PeppolPartySchema;

export function peppolServerModule(jwtSecret: string): ServerModule {
  const box = makeSecretBox(jwtSecret, 'zollify-peppol-v1');

  return {
    id: PEPPOL_MODULE_ID,
    minRole: 'admin',
    migrate,
    onAccountDeleted: (db, accountId) => {
      for (const t of ['peppol_settings', 'peppol_customers', 'peppol_documents', 'peppol_counters']) db.prepare(`DELETE FROM ${t} WHERE accountId = ?`).run(accountId);
    },

    routes: (ctx: ModuleContext) => async (app) => {
      const { db } = ctx;
      const who = (req: Parameters<ModuleContext['identity']>[0]) => ctx.identity(req).accountId;
      const accessPointOf = (accountId: string): AccessPointConfig | null => {
        const row = db.prepare('SELECT accessPoint FROM peppol_settings WHERE accountId = ?').get(accountId) as { accessPoint: string | null } | undefined;
        return row?.accessPoint ? box.decrypt<AccessPointConfig>(row.accessPoint) : null;
      };

      // ── Settings ────────────────────────────────────────────────────────

      app.get('/settings', async (req) => {
        const ap = accessPointOf(who(req));
        // The key never leaves the server; the screen only learns one is set.
        return { settings: settingsOf(db, who(req)), overrides: storedOf(db, who(req)), fromProfile: peppolSellerFromProfile(artistOf(db, who(req))), accessPoint: ap ? { provider: ap.provider, sandbox: ap.sandbox, accountRef: ap.accountRef, hasKey: !!ap.apiKey } : null, providers: ACCESS_POINTS };
      });

      app.put('/settings', async (req, reply) => {
        const body = PeppolStoredSettingsSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message ?? 'Check your details.' });
        db.prepare('INSERT INTO peppol_settings (accountId, doc) VALUES (?, ?) ON CONFLICT (accountId) DO UPDATE SET doc = excluded.doc').run(who(req), JSON.stringify(body.data));
        return { settings: settingsOf(db, who(req)), overrides: body.data, fromProfile: peppolSellerFromProfile(artistOf(db, who(req))) };
      });

      /** The access point account: provider, key (kept encrypted), sandbox or live. Null clears it. */
      app.put('/access-point', async (req, reply) => {
        const raw = req.body as { provider?: string | null } | null;
        if (!raw || raw.provider == null) {
          db.prepare('UPDATE peppol_settings SET accessPoint = NULL WHERE accountId = ?').run(who(req));
          return { accessPoint: null };
        }
        const body = AccessPointSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message ?? 'Check the access point.' });
        // Leaving the key empty keeps the one already saved.
        const apiKey = body.data.apiKey || accessPointOf(who(req))?.apiKey || '';
        if (!apiKey) return reply.code(400).send({ error: 'invalid_request', message: 'Enter the API key.' });
        const config: AccessPointConfig = { ...body.data, apiKey };
        db.prepare('INSERT INTO peppol_settings (accountId, doc, accessPoint) VALUES (?, ?, ?) ON CONFLICT (accountId) DO UPDATE SET accessPoint = excluded.accessPoint').run(
          who(req),
          JSON.stringify(storedOf(db, who(req))),
          box.encrypt(config),
        );
        return { accessPoint: { provider: config.provider, sandbox: config.sandbox, accountRef: config.accountRef, hasKey: true } };
      });

      // ── Customers ───────────────────────────────────────────────────────

      app.get('/customers', async (req) => ({
        customers: (db.prepare('SELECT id, doc FROM peppol_customers WHERE accountId = ? ORDER BY updatedAt DESC').all(who(req)) as { id: string; doc: string }[]).map((r) => ({
          id: r.id,
          ...(JSON.parse(r.doc) as PeppolParty),
        })),
      }));

      app.put<{ Params: { id: string } }>('/customers/:id', async (req, reply) => {
        if (!/^[\w-]{1,60}$/.test(req.params.id)) return reply.code(400).send({ error: 'invalid_request' });
        const body = CustomerBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message ?? 'Check the customer.' });
        db.prepare('INSERT INTO peppol_customers (accountId, id, doc, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT (accountId, id) DO UPDATE SET doc = excluded.doc, updatedAt = excluded.updatedAt').run(
          who(req),
          req.params.id,
          JSON.stringify(body.data),
          Date.now(),
        );
        return { customer: { id: req.params.id, ...body.data } };
      });

      app.delete<{ Params: { id: string } }>('/customers/:id', async (req, reply) => {
        const info = db.prepare('DELETE FROM peppol_customers WHERE accountId = ? AND id = ?').run(who(req), req.params.id);
        return info.changes ? { ok: true } : reply.code(404).send({ error: 'not_found' });
      });

      /**
       * Is this company on Peppol? Asks the public Peppol Directory. Only that
       * fixed host is ever contacted, with the identifier as a query value.
       */
      app.get<{ Querystring: { scheme?: string; id?: string } }>('/lookup', async (req, reply) => {
        const scheme = String(req.query.scheme ?? '');
        const id = String(req.query.id ?? '').replace(/[\s.]/g, '');
        if (!/^\d{4}$/.test(scheme) || !/^[A-Za-z0-9:_-]{2,50}$/.test(id)) return reply.code(400).send({ error: 'invalid_request' });
        const url = `https://directory.peppol.eu/search/1.0/json?participant=${encodeURIComponent(`iso6523-actorid-upis::${scheme}:${id}`)}`;
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
          if (!res.ok) return { registered: null, name: null, message: 'The Peppol Directory did not answer.' };
          const body = (await res.json()) as { matches?: { entities?: { name?: { name?: string }[]; countryCode?: string }[] }[] };
          const match = body.matches?.[0];
          const name = match?.entities?.[0]?.name?.[0]?.name ?? null;
          return { registered: !!match, name };
        } catch {
          return { registered: null, name: null, message: 'The Peppol Directory could not be reached.' };
        }
      });

      // ── Documents ───────────────────────────────────────────────────────

      app.get('/documents', async (req) => ({ documents: docsOf(db, who(req)).map(summary) }));

      app.get<{ Params: { id: string } }>('/documents/:id', async (req, reply) => {
        const found = docOf(db, who(req), req.params.id);
        if (!found) return reply.code(404).send({ error: 'not_found' });
        return { document: found.doc, totals: peppolTotals(found.doc.lines), problems: found.doc.status === 'draft' ? validatePeppol(found.doc, settingsOf(db, who(req))) : [] };
      });

      app.post('/documents', async (req, reply) => {
        const body = PeppolDocumentInputSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message ?? 'Check the invoice.' });
        const now = Date.now();
        const doc: PeppolDocument = { ...body.data, id: randomUUID(), number: null, status: 'draft', paymentReference: null, createdAt: now, updatedAt: now, issuedAt: null };
        saveDoc(db, who(req), doc);
        return reply.code(201).send({ document: doc, problems: validatePeppol(doc, settingsOf(db, who(req))) });
      });

      app.put<{ Params: { id: string } }>('/documents/:id', async (req, reply) => {
        const found = docOf(db, who(req), req.params.id);
        if (!found) return reply.code(404).send({ error: 'not_found' });
        if (found.doc.status !== 'draft') return reply.code(409).send({ error: 'issued', message: 'An issued invoice cannot change - make a credit note to correct it.' });
        const body = PeppolDocumentInputSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message ?? 'Check the invoice.' });
        const doc: PeppolDocument = { ...found.doc, ...body.data, kind: found.doc.kind, updatedAt: Date.now() };
        saveDoc(db, who(req), doc);
        return { document: doc, problems: validatePeppol(doc, settingsOf(db, who(req))) };
      });

      app.delete<{ Params: { id: string } }>('/documents/:id', async (req, reply) => {
        const found = docOf(db, who(req), req.params.id);
        if (!found) return reply.code(404).send({ error: 'not_found' });
        if (found.doc.status !== 'draft') return reply.code(409).send({ error: 'issued', message: 'Issued invoices are kept - make a credit note to cancel one.' });
        db.prepare('DELETE FROM peppol_documents WHERE accountId = ? AND id = ?').run(who(req), req.params.id);
        return { ok: true };
      });

      /**
       * Issuing: the checks must pass, then the next number in the series is
       * taken and the UBL frozen, in one transaction.
       */
      app.post<{ Params: { id: string } }>('/documents/:id/issue', async (req, reply) => {
        const accountId = who(req);
        const found = docOf(db, accountId, req.params.id);
        if (!found) return reply.code(404).send({ error: 'not_found' });
        if (found.doc.status !== 'draft') return reply.code(409).send({ error: 'issued', message: 'Already issued.' });
        const settings = settingsOf(db, accountId);
        const problems = validatePeppol(found.doc, settings);
        if (problems.length) return reply.code(422).send({ error: 'invalid', message: 'Fix these first.', problems });

        const issued = db.transaction((): { doc: PeppolDocument; xml: string } | null => {
          // Checked again inside the transaction: one draft never takes two numbers.
          if (docOf(db, who(req), req.params.id)?.doc.status !== 'draft') return null;
          const year = found.doc.issueDate.slice(0, 4);
          const prefix = found.doc.kind === 'credit' ? settings.creditPrefix : settings.invoicePrefix;
          const series = `${found.doc.kind}:${prefix}:${year}`;
          const row = db.prepare('SELECT next FROM peppol_counters WHERE accountId = ? AND series = ?').get(accountId, series) as { next: number } | undefined;
          const seq = row?.next ?? 1;
          db.prepare('INSERT INTO peppol_counters (accountId, series, next) VALUES (?, ?, ?) ON CONFLICT (accountId, series) DO UPDATE SET next = excluded.next').run(accountId, series, seq + 1);
          const number = `${prefix ? `${prefix}-` : ''}${year}-${String(seq).padStart(4, '0')}`;
          // The structured reference carries the year, the kind and the sequence, so it is unique too.
          const reference = structuredReference(`${year.slice(2)}${found.doc.kind === 'credit' ? 9 : 1}${String(seq).padStart(7, '0')}`);
          const doc: PeppolDocument = { ...found.doc, number, status: 'issued', paymentReference: found.doc.kind === 'credit' ? null : reference, issuedAt: Date.now(), updatedAt: Date.now() };
          const xml = peppolUbl(doc, settings);
          saveDoc(db, accountId, doc, xml);
          return { doc, xml };
        }).immediate();
        if (!issued) return reply.code(409).send({ error: 'issued', message: 'Already issued.' });
        return { document: issued.doc };
      });

      /** The UBL: as frozen when issued, or a preview of a draft (numbered DRAFT). */
      app.get<{ Params: { id: string } }>('/documents/:id/xml', async (req, reply) => {
        const found = docOf(db, who(req), req.params.id);
        if (!found) return reply.code(404).send({ error: 'not_found' });
        const xml = found.xml ?? peppolUbl(found.doc, settingsOf(db, who(req)));
        const name = (found.doc.number ?? 'draft').replace(/[^\w-]+/g, '-');
        return reply.header('content-type', 'application/xml; charset=utf-8').header('content-disposition', `attachment; filename="${name}.xml"`).send(xml);
      });

      /** A draft credit note correcting an issued invoice, with its lines to adjust. */
      app.post<{ Params: { id: string } }>('/documents/:id/credit', async (req, reply) => {
        const found = docOf(db, who(req), req.params.id);
        if (!found) return reply.code(404).send({ error: 'not_found' });
        if (found.doc.kind !== 'invoice' || found.doc.status === 'draft' || !found.doc.number) return reply.code(409).send({ error: 'not_issued', message: 'Only an issued invoice can be credited.' });
        const now = Date.now();
        const credit: PeppolDocument = {
          ...found.doc,
          id: randomUUID(),
          kind: 'credit',
          number: null,
          status: 'draft',
          issueDate: localDay(now, PEPPOL_TZ),
          invoiceRef: { number: found.doc.number, issueDate: found.doc.issueDate },
          paymentReference: null,
          sentVia: undefined,
          createdAt: now,
          updatedAt: now,
          issuedAt: null,
        };
        delete credit.dueDate;
        saveDoc(db, who(req), credit);
        return reply.code(201).send({ document: credit });
      });

      app.post<{ Params: { id: string } }>('/documents/:id/status', async (req, reply) => {
        const found = docOf(db, who(req), req.params.id);
        if (!found) return reply.code(404).send({ error: 'not_found' });
        if (found.doc.status === 'draft') return reply.code(409).send({ error: 'draft', message: 'Issue it first.' });
        const body = StatusBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
        const doc: PeppolDocument = { ...found.doc, status: body.data.status, updatedAt: Date.now() };
        saveDoc(db, who(req), doc);
        return { document: doc };
      });

      /** Sends an issued document through the business's access point. */
      app.post<{ Params: { id: string } }>('/documents/:id/send', async (req, reply) => {
        const accountId = who(req);
        const found = docOf(db, accountId, req.params.id);
        if (!found) return reply.code(404).send({ error: 'not_found' });
        if (found.doc.status === 'draft' || !found.xml) return reply.code(409).send({ error: 'draft', message: 'Issue it first.' });
        const ap = accessPointOf(accountId);
        if (!ap) return reply.code(400).send({ error: 'no_access_point', message: 'Set up a Peppol access point in the settings, or download the XML and upload it to yours.' });
        const result = await sendViaAccessPoint(ap, found.doc, found.xml);
        if (!result.ok) {
          const status = /\((\d{3})\)/.exec(result.message)?.[1];
          reportProblem(ctx, accountId, { kind: 'peppol.send', key: ap.provider, severity: 'warning', message: 'Sending an e-invoice through your Peppol access point failed', detail: status ? `HTTP ${status}` : 'Access point not reached or setup incomplete', link: '/settings?panel=peppol-be.peppol' });
          return reply.code(502).send({ error: 'send_failed', message: result.message });
        }
        resolveProblem(ctx, accountId, 'peppol.send', ap.provider);
        const doc: PeppolDocument = { ...found.doc, status: found.doc.status === 'paid' ? 'paid' : 'sent', sentVia: { provider: ap.provider, at: Date.now(), reference: result.reference ?? null }, updatedAt: Date.now() };
        saveDoc(db, accountId, doc);
        return { document: doc, reference: result.reference ?? null };
      });

      /** A draft invoice from a sale at the till - a business customer who wants a proper invoice. */
      app.post<{ Params: { saleId: string } }>('/from-sale/:saleId', async (req, reply) => {
        const accountId = who(req);
        const ops = (
          db.prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN ('tx.create', 'tx.revert', 'product.merge') ORDER BY seq").all(accountId) as {
            opId: string;
            type: string;
            payload: string;
          }[]
        ).map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) as unknown }));
        const tx = (reduceTransactions(ops, reduceMerges(ops)) as Transaction[]).find((t) => t.id === req.params.saleId);
        if (!tx) return reply.code(404).send({ error: 'not_found', message: 'No such sale.' });
        if (tx.revertedAt || tx.revertedBy) return reply.code(409).send({ error: 'reverted', message: 'That sale was reverted.' });
        const settings = settingsOf(db, accountId);
        // Till prices include VAT; an invoice line carries the net price and the rate.
        const lines: PeppolLine[] = tx.items.map((i, n) => {
          const rate = tx.tax && !tx.tax.exempt ? (tx.tax.rates[n] ?? 0) : 0;
          const gross = i.lineTotal / i.qty;
          const category = settings.smallBusinessExempt ? 'E' : rate > 0 ? 'S' : 'Z';
          return {
            description: i.variantLabel ? `${i.title} (${i.variantLabel})` : i.title,
            quantity: i.qty,
            unitCode: 'C62',
            unitPrice: Math.round((gross / (1 + (category === 'S' ? rate : 0) / 100)) * 10000) / 10000,
            vatCategory: category,
            vatRate: category === 'S' ? rate : 0,
          };
        });
        const body = (req.body ?? {}) as { customerId?: string };
        const customer = body.customerId
          ? (db.prepare('SELECT doc FROM peppol_customers WHERE accountId = ? AND id = ?').get(accountId, body.customerId) as { doc: string } | undefined)
          : undefined;
        const now = Date.now();
        const doc: PeppolDocument = {
          kind: 'invoice',
          issueDate: localDay(now, PEPPOL_TZ),
          dueDate: localDay(now + settings.paymentDays * 86_400_000, PEPPOL_TZ),
          currency: tx.currency,
          buyer: customer ? PeppolPartySchema.parse(JSON.parse(customer.doc)) : PeppolPartySchema.parse({ name: 'Customer' }),
          buyerReference: '',
          orderReference: '',
          lines,
          note: `Sale of ${localDay(tx.timestamp, PEPPOL_TZ)}, already paid at the till.`,
          deliveryDate: localDay(tx.timestamp, PEPPOL_TZ),
          invoiceRef: null,
          saleId: tx.id,
          id: randomUUID(),
          number: null,
          status: 'draft',
          paymentReference: null,
          createdAt: now,
          updatedAt: now,
          issuedAt: null,
        };
        saveDoc(db, accountId, doc);
        return reply.code(201).send({ document: doc, problems: validatePeppol(doc, settings) });
      });
    },
  };
}
