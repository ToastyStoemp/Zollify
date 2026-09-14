import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CURRENCIES, priceRows } from '@zollify/shared';
import { reduceDiscounts, reduceProducts, type ModuleContext, type PublicModuleContext, type ServerModule } from '@zollify/server-core';

/**
 * Price cards — the server half, ported from ZollPriceCards.
 *
 * Serves the catalogue as card-ready price rows to the Photoshop plugin at
 * `/p/price-cards/prices.json`, gated by a per-account plugin token. The
 * plugin writes the current price onto the text layers of the booth's PSD
 * templates; the designs never leave the artist's machine.
 *
 * Only a hash of the token is stored. It is shown once, when minted.
 */

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_cards_tokens (
      tokenHash TEXT PRIMARY KEY,
      accountId TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL
    );
  `);
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function accountForToken(db: Database.Database, token: string): string | null {
  if (!token) return null;
  const row = db.prepare('SELECT accountId FROM price_cards_tokens WHERE tokenHash = ?').get(sha256(token)) as { accountId: string } | undefined;
  return row?.accountId ?? null;
}

function bearer(req: { headers: Record<string, unknown>; query: unknown }): string {
  const h = String(req.headers.authorization ?? '');
  if (/^bearer\s+/i.test(h)) return h.replace(/^bearer\s+/i, '').trim();
  const q = (req.query as { token?: string } | undefined)?.token;
  return typeof q === 'string' ? q : '';
}

function catalogFor(db: Database.Database, accountId: string) {
  const ops = db
    .prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN ('product.upsert', 'product.delete', 'discount.upsert', 'discount.delete') ORDER BY seq")
    .all(accountId) as { opId: string; type: string; payload: string }[];
  const parsed = ops.map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) }));
  return { products: reduceProducts(parsed).filter((p) => !p.deletedAt), discounts: reduceDiscounts(parsed).filter((d) => !d.deletedAt) };
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' };

export const priceCardsServerModule: ServerModule = {
  id: 'price-cards',
  minRole: 'admin',
  migrate,

  routes: (ctx: ModuleContext) => async (app) => {
    /** Mints a fresh plugin token for the account, replacing any earlier one. */
    app.post('/token', async (req) => {
      const who = ctx.identity(req);
      const token = `zpc_${randomBytes(24).toString('base64url')}`;
      ctx.db.transaction(() => {
        ctx.db.prepare('DELETE FROM price_cards_tokens WHERE accountId = ?').run(who.accountId);
        ctx.db.prepare('INSERT INTO price_cards_tokens (tokenHash, accountId, createdAt) VALUES (?, ?, ?)').run(sha256(token), who.accountId, Date.now());
      })();
      return { token };
    });
    app.get('/token', async (req) => {
      const who = ctx.identity(req);
      const row = ctx.db.prepare('SELECT createdAt FROM price_cards_tokens WHERE accountId = ?').get(who.accountId) as { createdAt: number } | undefined;
      return { createdAt: row?.createdAt ?? null };
    });
    app.delete('/token', async (req, reply) => {
      const who = ctx.identity(req);
      ctx.db.prepare('DELETE FROM price_cards_tokens WHERE accountId = ?').run(who.accountId);
      return reply.code(204).send();
    });
  },

  publicRoutes: (ctx: PublicModuleContext) => async (app) => {
    app.options('/*', async (_req, reply) => reply.headers(CORS).code(204).send());

    app.get('/prices.json', async (req, reply) => {
      const accountId = accountForToken(ctx.db, bearer(req as never));
      if (!accountId || !ctx.isEnabled(accountId)) return reply.headers(CORS).code(401).send({ error: 'Bad or missing plugin token' });
      const q = req.query as { currency?: string; exchangeRate?: string; rounding?: string };
      const { products, discounts } = catalogFor(ctx.db, accountId);
      return reply.headers(CORS).send(priceRows(products, { currency: q.currency, exchangeRate: Number(q.exchangeRate), rounding: Number(q.rounding) }, discounts));
    });

    app.get('/currencies', async (req, reply) => {
      const accountId = accountForToken(ctx.db, bearer(req as never));
      if (!accountId || !ctx.isEnabled(accountId)) return reply.headers(CORS).code(401).send({ error: 'Bad or missing plugin token' });
      return reply.headers(CORS).send({ currencies: CURRENCIES.map((c) => c.code) });
    });
  },
};
