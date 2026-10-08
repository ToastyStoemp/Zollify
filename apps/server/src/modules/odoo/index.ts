import type Database from 'better-sqlite3';
import { z } from 'zod';
import { isEnabled, makeSecretBox, reduceEvents, type ModuleContext, type ModuleServices, type ServerModule } from '@zollify/server-core';
import type { ProductMatch, SavedMatches, Transaction, WireOp, ZtProduct } from '@zollify/shared';
import type { ShopProduct } from '../shopify-sync/types';
import { matchCatalogs } from '../shopify-sync/match';
import { OdooClient, OdooError, m2oName } from './odoo';
import { MODULE_ID, creditSale, importWebSales, invoiceSale, itemKey, logLine, odooCatalogue, pullStock, pushStock, stockState, tracked, unitsOf, type OdooSettings } from './sync';

/**
 * Odoo sync - the server half. Keeps stock level with an Odoo warehouse
 * location and, if wanted, invoices every till sale in Odoo. See sync.ts for
 * the rules; this file is the plumbing: credentials, matching, routes, the
 * op-log hook that pushes as sales happen, and the hourly pull.
 *
 * The API key is encrypted at rest and never leaves this process, like the
 * Shopify token. Matching reuses the Shopify catalogue matcher: Odoo's
 * products are read into the same shape, so SKU hits, fuzzy suggestions and
 * confirmed overrides work the same way.
 */

const SECRET_SALT = 'zollify-module-credentials-v1';
const PULL_EVERY_MS = 60 * 60_000;

const ConnectBody = z.object({
  url: z.string().trim().url().max(300).refine((u) => /^https?:\/\//.test(u), 'Expected an http(s) address.'),
  db: z.string().trim().min(1).max(120),
  login: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(8).max(500).optional(),
  locationId: z.number().int().positive().nullable().default(null),
  syncStock: z.boolean().default(true),
  invoiceSales: z.boolean().default(false),
  journalId: z.number().int().positive().nullable().default(null),
  partnerId: z.number().int().positive().nullable().default(null),
  salesEventId: z.string().min(1).max(80).nullable().default(null),
});

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS odoo_connections (
      accountId TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      blob      TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS odoo_matches (
      accountId TEXT NOT NULL,
      productId TEXT NOT NULL,
      payload   TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, productId)
    );
    CREATE TABLE IF NOT EXISTS odoo_stock (
      accountId TEXT NOT NULL,
      productId TEXT NOT NULL,
      variantId TEXT NOT NULL,
      qty       REAL NOT NULL,
      source    TEXT NOT NULL,
      syncedAt  INTEGER NOT NULL,
      PRIMARY KEY (accountId, productId, variantId)
    );
    CREATE TABLE IF NOT EXISTS odoo_invoices (
      accountId  TEXT NOT NULL,
      txId       TEXT NOT NULL,
      moveId     INTEGER NOT NULL,
      reversalId INTEGER,
      createdAt  INTEGER NOT NULL,
      PRIMARY KEY (accountId, txId)
    );
    CREATE TABLE IF NOT EXISTS odoo_imports (
      accountId  TEXT NOT NULL,
      moveId     INTEGER NOT NULL,
      txId       TEXT NOT NULL,
      importedAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, moveId)
    );
    CREATE TABLE IF NOT EXISTS odoo_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      accountId TEXT NOT NULL,
      at        INTEGER NOT NULL,
      kind      TEXT NOT NULL,
      message   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_odoo_log ON odoo_log(accountId, id);
  `);
}

const TABLES = ['odoo_connections', 'odoo_matches', 'odoo_stock', 'odoo_invoices', 'odoo_imports', 'odoo_log'];

export function odooServerModule(jwtSecret: string): ServerModule {
  const box = makeSecretBox(jwtSecret, SECRET_SALT);

  const settingsOf = (db: Database.Database, accountId: string): OdooSettings | null => {
    const row = db.prepare('SELECT blob FROM odoo_connections WHERE accountId = ?').get(accountId) as { blob: string } | undefined;
    return row ? box.decrypt<OdooSettings>(row.blob) : null;
  };
  const save = (db: Database.Database, accountId: string, s: OdooSettings): void => {
    db.prepare('INSERT INTO odoo_connections (accountId, blob, updatedAt) VALUES (?, ?, ?) ON CONFLICT (accountId) DO UPDATE SET blob = excluded.blob, updatedAt = excluded.updatedAt').run(accountId, box.encrypt(s), Date.now());
  };
  const clientFor = (s: OdooSettings): OdooClient => new OdooClient({ url: s.url.replace(/\/+$/, ''), db: s.db, login: s.login, apiKey: s.apiKey });

  /** Everything the account's Odoo wants done for a batch of ops: stock for what moved, invoices for sales, credit notes for reverts. */
  const follow = async (svc: ModuleServices, accountId: string, ops: WireOp[]): Promise<void> => {
    const s = settingsOf(svc.db, accountId);
    if (!s) return;
    const client = clientFor(s);
    const touched = new Set<string>();
    const sales: Transaction[] = [];
    const reverts: string[] = [];
    for (const op of ops) {
      if (op.type === 'tx.create') {
        const tx = op.payload as Transaction;
        for (const i of tx.items) touched.add(itemKey(i.pid, i.vid ?? ''));
        sales.push(tx);
      } else if (op.type === 'tx.revert') {
        const p = op.payload as { txId?: string; id?: string; items?: { pid: string; vid: string | null }[] };
        reverts.push(p.txId ?? p.id ?? '');
        // The items come back: the levels concerned are whatever the sale had.
        const tx = stockState(svc.db, accountId).transactions.find((t) => t.id === (p.txId ?? p.id));
        for (const i of tx?.items ?? []) touched.add(itemKey(i.pid, i.vid ?? ''));
      } else if (op.type === 'inventory.set') {
        const p = op.payload as { productId: string; variantId?: string };
        touched.add(itemKey(p.productId, p.variantId ?? ''));
      }
    }
    if (s.syncStock && touched.size) {
      const n = await tracked(svc, accountId, 'stock update', () => pushStock(svc, client, accountId, s, touched));
      if (n) logLine(svc.db, accountId, 'push', `${n} level${n === 1 ? '' : 's'} sent to Odoo`);
    }
    if (s.invoiceSales) {
      const { products } = stockState(svc.db, accountId);
      const titles = new Map(products.flatMap((p) => unitsOf(p).map((u) => [itemKey(p.id, u.variantId), u.title] as const)));
      for (const tx of sales) {
        // A web sale is already invoiced in Odoo - it came from there.
        if (tx.revertedAt || tx.revertedBy || tx.deviceId === 'odoo') continue;
        const id = await tracked(svc, accountId, `invoice for sale ${tx.id.slice(0, 8)}`, () => invoiceSale(svc, client, accountId, s, (next) => save(svc.db, accountId, next), tx, (pid, vid) => titles.get(itemKey(pid, vid)) ?? 'Item'));
        if (id) logLine(svc.db, accountId, 'invoice', `Invoice ${id} posted for sale ${tx.id.slice(0, 8)}`);
      }
      for (const txId of reverts) {
        if (!txId) continue;
        const id = await tracked(svc, accountId, `credit note for sale ${txId.slice(0, 8)}`, () => creditSale(svc, client, accountId, txId));
        if (id) logLine(svc.db, accountId, 'invoice', `Credit note ${id} for reverted sale ${txId.slice(0, 8)}`);
      }
    }
  };

  /**
   * Every matched item brought level on both sides: Odoo's changes in, then
   * Zollify's out. Pull first, so an item the two have never agreed on takes
   * Odoo's figure (the web shop's book of record) rather than overwriting it,
   * and a push that failed earlier is retried once Odoo is back.
   */
  const reconcile = async (svc: ModuleServices, accountId: string, s: OdooSettings): Promise<{ sales: number; pushed: number; pulled: number }> => {
    const client = clientFor(s);
    const sales = (await tracked(svc, accountId, 'web sales import', () => importWebSales(svc, client, accountId, s))) ?? 0;
    const pulled = (await tracked(svc, accountId, 'stock pull', () => pullStock(svc, client, accountId, s))) ?? 0;
    const pushed = (await tracked(svc, accountId, 'stock update', () => pushStock(svc, client, accountId, s))) ?? 0;
    if (pushed || pulled || sales) logLine(svc.db, accountId, 'sync', `${sales ? `${sales} web sale${sales === 1 ? '' : 's'} brought over, ` : ''}${pushed} level${pushed === 1 ? '' : 's'} sent to Odoo, ${pulled} taken from it`);
    return { sales, pushed, pulled };
  };

  const pullAll = async (svc: ModuleServices): Promise<void> => {
    const rows = svc.db.prepare('SELECT accountId FROM odoo_connections').all() as { accountId: string }[];
    for (const { accountId } of rows) {
      if (!isEnabled(svc.db, accountId, MODULE_ID)) continue;
      const s = settingsOf(svc.db, accountId);
      if (s && (s.syncStock || s.salesEventId)) await reconcile(svc, accountId, s);
    }
  };

  return {
    id: MODULE_ID,
    // Connecting a warehouse and writing its books is an owner's decision.
    minRole: 'owner',
    migrate,
    onAccountDeleted: (db, accountId) => {
      for (const t of TABLES) db.prepare(`DELETE FROM ${t} WHERE accountId = ?`).run(accountId);
    },
    onOps: (svc, accountId, ops) => {
      if (!ops.some((o) => o.type === 'tx.create' || o.type === 'tx.revert' || o.type === 'inventory.set')) return;
      void follow(svc, accountId, ops).catch(() => undefined);
    },

    routes: (ctx: ModuleContext) => async (app) => {
      const timer = setInterval(() => void pullAll(ctx).catch(() => undefined), PULL_EVERY_MS);
      timer.unref();
      app.addHook('onClose', async () => clearInterval(timer));

      const need = (accountId: string, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): OdooSettings | null => {
        const s = settingsOf(ctx.db, accountId);
        if (!s) reply.code(409).send({ error: 'not_connected', message: 'Connect Odoo first.' });
        return s;
      };
      const odooFailed = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) => {
        const e = err as OdooError;
        return reply.code(e.status === 401 ? 401 : 502).send({ error: 'odoo_unavailable', message: e instanceof Error ? e.message : 'Odoo did not respond as expected.' });
      };

      /** The connection, without the key. */
      app.get('/connection', async (req) => {
        const s = settingsOf(ctx.db, ctx.identity(req).accountId);
        if (!s) return { connected: false };
        const { apiKey: _k, ...rest } = s;
        return { connected: true, ...rest };
      });

      app.post('/connection', async (req, reply) => {
        const who = ctx.identity(req);
        const parsed = ConnectBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'Address, database, login and API key are required.' });
        const before = settingsOf(ctx.db, who.accountId);
        const apiKey = parsed.data.apiKey ?? before?.apiKey;
        if (!apiKey) return reply.code(400).send({ error: 'invalid_request', message: 'An API key is required.' });
        // Web sales count from the moment the event is first picked, never from before the store had Zollify.
        const salesSince = parsed.data.salesEventId ? (before?.salesSince ?? Date.now()) : null;
        const next: OdooSettings = { ...parsed.data, url: parsed.data.url.replace(/\/+$/, ''), apiKey, salesSince };
        try {
          await clientFor(next).authenticate();
        } catch (err) {
          return odooFailed(reply, err);
        }
        save(ctx.db, who.accountId, next);
        logLine(ctx.db, who.accountId, 'connect', `Connected to ${next.url} (${next.db})`);
        const { apiKey: _k, ...rest } = next;
        return { connected: true, ...rest };
      });

      app.delete('/connection', async (req) => {
        const who = ctx.identity(req);
        for (const t of TABLES) ctx.db.prepare(`DELETE FROM ${t} WHERE accountId = ?`).run(who.accountId);
        return { connected: false };
      });

      /** Locations and sales journals, for the pickers; also proves the key works. */
      app.get('/choices', async (req, reply) => {
        const who = ctx.identity(req);
        const s = need(who.accountId, reply);
        if (!s) return;
        try {
          const client = clientFor(s);
          const [version, locations, journals] = await Promise.all([
            client.version(),
            client.searchRead<{ id: number; complete_name: string; warehouse_id: [number, string] | false }>('stock.location', [['usage', '=', 'internal']], ['complete_name', 'warehouse_id'], { order: 'complete_name' }),
            client.searchRead<{ id: number; name: string }>('account.journal', [['type', '=', 'sale']], ['name'], { order: 'name' }).catch(() => []),
          ]);
          const ops = (ctx.db.prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN ('event.upsert', 'event.close') ORDER BY seq").all(who.accountId) as { opId: string; type: string; payload: string }[]).map((o) => ({ ...o, payload: JSON.parse(o.payload) as unknown }));
          const events = reduceEvents(ops)
            .filter((e) => !e.deletedAt)
            .sort((a, b) => Number(b.kind === 'store') - Number(a.kind === 'store') || a.name.localeCompare(b.name))
            .map((e) => ({ id: e.id, name: e.name, store: e.kind === 'store' }));
          return {
            version: version.server_version ?? null,
            events,
            locations: locations.map((l) => ({ id: l.id, name: l.complete_name, warehouse: m2oName(l.warehouse_id) })),
            journals: journals.map((j) => ({ id: j.id, name: j.name })),
          };
        } catch (err) {
          return odooFailed(reply, err);
        }
      });

      app.get('/products', async (req, reply) => {
        const s = need(ctx.identity(req).accountId, reply);
        if (!s) return;
        try {
          return { products: await odooCatalogue(clientFor(s)) };
        } catch (err) {
          return odooFailed(reply, err);
        }
      });

      /** Proposes matches; nothing is written anywhere until a person confirms. */
      app.post('/match', async (req, reply) => {
        const who = ctx.identity(req);
        const s = need(who.accountId, reply);
        if (!s) return;
        let odoo: ShopProduct[];
        try {
          odoo = await odooCatalogue(clientFor(s));
        } catch (err) {
          return odooFailed(reply, err);
        }
        const body = (req.body ?? {}) as { products?: ZtProduct[]; saved?: SavedMatches };
        const matches: ProductMatch[] = matchCatalogs(body.products ?? [], odoo, body.saved ?? savedMatches(who.accountId));
        return { matches };
      });

      const savedMatches = (accountId: string): SavedMatches => {
        const rows = ctx.db.prepare('SELECT productId, payload FROM odoo_matches WHERE accountId = ?').all(accountId) as { productId: string; payload: string }[];
        return Object.fromEntries(rows.map((r) => [r.productId, JSON.parse(r.payload)]));
      };

      app.get('/matches', async (req) => ({ saved: savedMatches(ctx.identity(req).accountId) }));

      app.post('/matches/save', async (req, reply) => {
        const who = ctx.identity(req);
        const body = req.body as { matches?: Record<string, unknown> } | undefined;
        if (!body?.matches || typeof body.matches !== 'object') return reply.code(400).send({ error: 'invalid_request', message: 'No matches supplied.' });
        const stmt = ctx.db.prepare('INSERT INTO odoo_matches (accountId, productId, payload, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT (accountId, productId) DO UPDATE SET payload = excluded.payload, updatedAt = excluded.updatedAt');
        const now = Date.now();
        ctx.db.transaction(() => {
          for (const [productId, payload] of Object.entries(body.matches!)) stmt.run(who.accountId, productId, JSON.stringify(payload), now);
        })();
        return { saved: Object.keys(body.matches).length };
      });

      /** Sync now: Zollify's changes out, Odoo's in. */
      app.post('/sync', async (req, reply) => {
        const who = ctx.identity(req);
        const s = need(who.accountId, reply);
        if (!s) return;
        if (!s.locationId && !s.salesEventId) return reply.code(409).send({ error: 'nothing_to_sync', message: 'Pick the Odoo location the shelf is, or the event web sales go under, first.' });
        return reconcile(ctx, who.accountId, s);
      });

      app.get('/status', async (req) => {
        const who = ctx.identity(req);
        const levels = (ctx.db.prepare('SELECT COUNT(*) AS n, MAX(syncedAt) AS at FROM odoo_stock WHERE accountId = ?').get(who.accountId) as { n: number; at: number | null });
        const invoices = (ctx.db.prepare('SELECT COUNT(*) AS n, SUM(reversalId IS NOT NULL) AS credited FROM odoo_invoices WHERE accountId = ?').get(who.accountId) as { n: number; credited: number | null });
        const matched = (ctx.db.prepare('SELECT COUNT(*) AS n FROM odoo_matches WHERE accountId = ?').get(who.accountId) as { n: number }).n;
        const webSales = (ctx.db.prepare('SELECT COUNT(DISTINCT txId) AS n FROM odoo_imports WHERE accountId = ?').get(who.accountId) as { n: number }).n;
        const log = ctx.db.prepare('SELECT at, kind, message FROM odoo_log WHERE accountId = ? ORDER BY id DESC LIMIT 30').all(who.accountId);
        return { matched, levels: levels.n, lastSyncAt: levels.at, webSales, invoices: invoices.n, creditNotes: invoices.credited ?? 0, log };
      });
    },
  };
}
