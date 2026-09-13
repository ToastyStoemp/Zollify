import type Database from 'better-sqlite3';
import { z } from 'zod';
import { makeSecretBox, type ModuleContext, type ServerModule } from '@zollify/server-core';
import { ShopifyClient } from './shopify';
import { matchCatalogs } from './match';
import type { SavedMatches, ShopProduct, ZtProduct } from './types';

/**
 * Shopify sync — the server half.
 *
 * Ported from zolltool-shopify-sync: the catalogue matcher and Admin API client
 * come across unchanged, along with their tests. What is new is per-account
 * credentials and storage, because one deployment now serves many accounts
 * where the original served one.
 *
 * The access token never leaves this process and is encrypted at rest
 * (SECURITY.md §5) — a Shopify admin token is exactly the kind of credential
 * that must not sit in a browser or in plain SQLite.
 */

/** Domain-separated from the TOTP key, so one compromise is not both. */
const SECRET_SALT = 'zollify-module-credentials-v1';

const ConnectBody = z.object({
  shop: z
    .string()
    .min(3)
    .max(255)
    // Shopify domains only — this string is interpolated into the API URL, so
    // anything looser would let a caller point the client at another host.
    .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i, 'Expected a *.myshopify.com domain.'),
  accessToken: z.string().min(10).max(500),
  apiVersion: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});

const MatchBody = z.object({
  saved: z.record(z.string(), z.unknown()).optional(),
});

const DEFAULT_API_VERSION = '2024-10';

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shopify_connections (
      accountId   TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      shop        TEXT NOT NULL,
      apiVersion  TEXT NOT NULL,
      tokenBlob   TEXT NOT NULL,
      updatedAt   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shopify_matches (
      accountId TEXT NOT NULL,
      productId TEXT NOT NULL,
      payload   TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, productId)
    );
  `);
}

interface ConnectionRow {
  shop: string;
  apiVersion: string;
  tokenBlob: string;
}

export function shopifyServerModule(jwtSecret: string): ServerModule {
  const box = makeSecretBox(jwtSecret, SECRET_SALT);

  return {
    id: 'shopify-sync',
    // Connecting a storefront and rewriting its prices is an owner's decision.
    minRole: 'owner',
    migrate,

    routes: (ctx: ModuleContext) => async (app) => {
      const connectionFor = (accountId: string): { client: ShopifyClient; shop: string } | null => {
        const row = ctx.db
          .prepare('SELECT shop, apiVersion, tokenBlob FROM shopify_connections WHERE accountId = ?')
          .get(accountId) as ConnectionRow | undefined;
        if (!row) return null;
        const token = box.decrypt<string>(row.tokenBlob);
        return { client: new ShopifyClient(row.shop, row.apiVersion, token), shop: row.shop };
      };

      /** Connection status. The token itself is never echoed back. */
      app.get('/connection', async (req) => {
        const who = ctx.identity(req);
        const row = ctx.db
          .prepare('SELECT shop, apiVersion, updatedAt FROM shopify_connections WHERE accountId = ?')
          .get(who.accountId) as { shop: string; apiVersion: string; updatedAt: number } | undefined;
        return { connected: Boolean(row), shop: row?.shop ?? null, apiVersion: row?.apiVersion ?? null };
      });

      app.post('/connection', async (req, reply) => {
        const who = ctx.identity(req);
        const parsed = ConnectBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: 'invalid_request',
            message: parsed.error.issues[0]?.message ?? 'Shop domain and access token are required.',
          });
        }

        const { shop, accessToken, apiVersion } = parsed.data;
        ctx.db
          .prepare(
            `INSERT INTO shopify_connections (accountId, shop, apiVersion, tokenBlob, updatedAt)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(accountId) DO UPDATE SET
               shop = excluded.shop,
               apiVersion = excluded.apiVersion,
               tokenBlob = excluded.tokenBlob,
               updatedAt = excluded.updatedAt`,
          )
          .run(
            who.accountId,
            shop.toLowerCase(),
            apiVersion ?? DEFAULT_API_VERSION,
            box.encrypt(accessToken),
            Date.now(),
          );

        return { connected: true, shop: shop.toLowerCase() };
      });

      app.delete('/connection', async (req) => {
        const who = ctx.identity(req);
        ctx.db.prepare('DELETE FROM shopify_connections WHERE accountId = ?').run(who.accountId);
        return { connected: false };
      });

      /** The storefront's catalogue, for review before anything is written back. */
      app.get('/products', async (req, reply) => {
        const who = ctx.identity(req);
        const conn = connectionFor(who.accountId);
        if (!conn) {
          return reply.code(409).send({ error: 'not_connected', message: 'Connect a Shopify store first.' });
        }
        try {
          const products = await conn.client.products();
          return { shop: conn.shop, products };
        } catch (err) {
          // Shopify's message can carry shop details; log it, return something plain.
          app.log.error({ err, accountId: who.accountId }, 'shopify fetch failed');
          return reply.code(502).send({ error: 'shopify_unavailable', message: 'Shopify did not respond as expected.' });
        }
      });

      /**
       * Proposes matches between the Zollify catalogue and the storefront.
       *
       * Read-only by design: matching suggests, a person confirms, and only then
       * does anything get written to the shop. Auto-applying a fuzzy match would
       * rewrite live storefront prices on a guess.
       */
      app.post('/match', async (req, reply) => {
        const who = ctx.identity(req);
        const conn = connectionFor(who.accountId);
        if (!conn) {
          return reply.code(409).send({ error: 'not_connected', message: 'Connect a Shopify store first.' });
        }

        const parsed = MatchBody.safeParse(req.body ?? {});
        const saved = (parsed.success ? parsed.data.saved : {}) as SavedMatches;

        let shopProducts: ShopProduct[];
        try {
          shopProducts = await conn.client.products();
        } catch (err) {
          app.log.error({ err, accountId: who.accountId }, 'shopify fetch failed');
          return reply.code(502).send({ error: 'shopify_unavailable', message: 'Shopify did not respond as expected.' });
        }

        // The Zollify catalogue lives on the client (it is synced, not
        // server-authoritative), so it is supplied with the request.
        const ztProducts = ((req.body as { products?: ZtProduct[] })?.products ?? []) as ZtProduct[];

        return { matches: matchCatalogs(ztProducts, shopProducts, saved) };
      });

      /** Persists confirmed matches so the next run starts from them. */
      app.post('/matches/save', async (req, reply) => {
        const who = ctx.identity(req);
        const body = req.body as { matches?: Record<string, unknown> } | undefined;
        if (!body?.matches || typeof body.matches !== 'object') {
          return reply.code(400).send({ error: 'invalid_request', message: 'No matches supplied.' });
        }

        const stmt = ctx.db.prepare(
          `INSERT INTO shopify_matches (accountId, productId, payload, updatedAt)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(accountId, productId) DO UPDATE SET
             payload = excluded.payload, updatedAt = excluded.updatedAt`,
        );
        const now = Date.now();
        const tx = ctx.db.transaction(() => {
          for (const [productId, payload] of Object.entries(body.matches ?? {})) {
            stmt.run(who.accountId, productId, JSON.stringify(payload), now);
          }
        });
        tx();

        return { saved: Object.keys(body.matches).length };
      });

      app.get('/matches', async (req) => {
        const who = ctx.identity(req);
        const rows = ctx.db
          .prepare('SELECT productId, payload FROM shopify_matches WHERE accountId = ?')
          .all(who.accountId) as { productId: string; payload: string }[];

        const saved: Record<string, unknown> = {};
        for (const row of rows) saved[row.productId] = JSON.parse(row.payload);
        return { saved };
      });
    },
  };
}
