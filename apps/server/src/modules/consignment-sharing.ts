import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SharePricingSchema,
  sharedPrice,
  matchesShortBarcode,
  type Product,
  type ShareableItem,
  type SharePricing,
  type WireOp,
} from '@zollify/shared';
import { isEnabled, parseProfile, type ModuleContext, type ModuleServices } from '@zollify/server-core';
import { MODULE_ID, accountName, consignorRow, parseDoc, replay, type ConsignorRow } from './consignment';
import type { Side } from './consignment';

/**
 * Sharing - artists choose which of their own items a store sells.
 *
 * A shared item becomes a product in the store's catalogue, written by the
 * server, carrying the artist's own product id. Keeping the id is what makes
 * the artist's labels scan at the store: the short barcode is derived from
 * it. The store's copy is the artist's product, priced in the store's
 * currency, tagged with the artist and with their photo, and it follows the
 * artist's edits: whenever the artist's devices push a change to a shared
 * product, the store's copy is rewritten.
 *
 * Unsharing removes it from the store's till; sales already made keep it.
 * A barcode the store scans that belongs to a linked artist's unshared item
 * shares it on the spot, and the artist is told.
 */

export function migrateSharing(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consignment_shares (
      accountId   TEXT NOT NULL,
      consignorId TEXT NOT NULL,
      productId   TEXT NOT NULL,
      auto        INTEGER NOT NULL DEFAULT 0,
      sharedAt    INTEGER NOT NULL,
      PRIMARY KEY (accountId, consignorId, productId)
    );
    CREATE TABLE IF NOT EXISTS consignment_pricing (
      accountId   TEXT NOT NULL,
      consignorId TEXT NOT NULL,
      doc         TEXT NOT NULL,
      updatedAt   INTEGER NOT NULL,
      PRIMARY KEY (accountId, consignorId)
    );
    CREATE TABLE IF NOT EXISTS consignment_shared_images (
      accountId TEXT NOT NULL,
      imageId   TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, imageId)
    );
  `);
  // Sharing some variants of a product, not all: their ids, or NULL for every one.
  const cols = new Set((db.prepare('PRAGMA table_info(consignment_shares)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('variantIds')) db.exec('ALTER TABLE consignment_shares ADD COLUMN variantIds TEXT');
}

// ── Storage ─────────────────────────────────────────────────────────────────

const sharedIds = (db: Database.Database, storeAccountId: string, consignorId: string): Map<string, boolean> =>
  new Map(
    (db.prepare('SELECT productId, auto FROM consignment_shares WHERE accountId = ? AND consignorId = ?').all(storeAccountId, consignorId) as { productId: string; auto: number }[]).map(
      (r) => [r.productId, r.auto === 1],
    ),
  );
/** Per shared product, the variants shared: a list, or null for all of them. */
const sharedVariants = (db: Database.Database, storeAccountId: string, consignorId: string): Map<string, string[] | null> =>
  new Map(
    (db.prepare('SELECT productId, variantIds FROM consignment_shares WHERE accountId = ? AND consignorId = ?').all(storeAccountId, consignorId) as { productId: string; variantIds: string | null }[]).map(
      (r) => [r.productId, r.variantIds ? (JSON.parse(r.variantIds) as string[]) : null],
    ),
  );

export function pricingOf(db: Database.Database, storeAccountId: string, consignorId: string): SharePricing {
  const row = db.prepare('SELECT doc FROM consignment_pricing WHERE accountId = ? AND consignorId = ?').get(storeAccountId, consignorId) as { doc: string } | undefined;
  const parsed = SharePricingSchema.safeParse(row ? JSON.parse(row.doc) : {});
  return parsed.success ? parsed.data : SharePricingSchema.parse({});
}

const currencyOf = (db: Database.Database, accountId: string): string => {
  const row = db.prepare('SELECT profile FROM accounts WHERE id = ?').get(accountId) as { profile: string | null } | undefined;
  return parseProfile(row?.profile).defaultCurrency;
};

/** The linked artist account behind a consignor, if it still exists. */
const artistOf = (db: Database.Database, row: ConsignorRow): string | null =>
  row.linkedAccountId && accountName(db, row.linkedAccountId) !== null ? row.linkedAccountId : null;

// ── Writing the store's copy ────────────────────────────────────────────────

/**
 * Writes (or removes) the store's copy of shared items. `ids` limits it to
 * some products; without it, every shared item of the consignor is redone -
 * after a rate change, a rename, or a new link.
 */
export function syncShared(svc: ModuleServices, storeAccountId: string, row: ConsignorRow, ids?: Iterable<string>): number {
  const { db } = svc;
  const artist = artistOf(db, row);
  if (!artist) return 0;
  const shared = sharedIds(db, storeAccountId, row.id);
  const variantsOf = sharedVariants(db, storeAccountId, row.id);
  const wanted = ids ? [...ids] : [...shared.keys()];
  if (!wanted.length) return 0;

  const artistProducts = new Map(replay(db, artist).products.map((p) => [p.id, p]));
  const storeProducts = new Map(replay(db, storeAccountId).products.map((p) => [p.id, p]));
  const pricing = pricingOf(db, storeAccountId, row.id);
  const same = currencyOf(db, artist) === currencyOf(db, storeAccountId);
  const name = parseDoc(row.doc).name;
  const now = Date.now();

  const ops: { type: WireOp['type']; payload: unknown }[] = [];
  const imageIds = new Set<string>();
  for (const id of wanted) {
    const source = artistProducts.get(id);
    const current = storeProducts.get(id);
    // Unshared, deleted by the artist, or no longer for sale: off the store's till.
    if (!shared.has(id) || !source || source.deletedAt || !source.forSale) {
      if (current && !current.deletedAt && current.consignorId === row.id) ops.push({ type: 'product.delete', payload: { id, deletedAt: now } });
      continue;
    }
    // Only ever this artist's own copy: a store product (or another artist's) under the same id
    // is left alone - the id comes from the artist, so it must never let them overwrite the store's.
    if (current && current.consignorId !== row.id) continue;
    // Only the variants the artist picked for this store (all of them unless they picked).
    const picked = variantsOf.get(id) ?? null;
    const listed = (source.variants ?? []).filter((v) => !v.unlisted && (!picked || picked.includes(v.id)));
    if (source.variants?.some((v) => !v.unlisted) && !listed.length) {
      if (current && !current.deletedAt) ops.push({ type: 'product.delete', payload: { id, deletedAt: now } });
      continue;
    }
    const price = sharedPrice(source.price, `${id}:`, same, pricing);
    const product: Product = {
      id,
      title: source.title,
      ...(source.sku ? { sku: source.sku } : {}),
      ...(source.type ? { type: source.type } : {}),
      price: price ?? 0,
      ...(source.priceNote ? { priceNote: source.priceNote } : {}),
      ...(source.weightG != null ? { weightG: source.weightG } : {}),
      ...(source.tariffNo ? { tariffNo: source.tariffNo } : {}),
      ...(source.taxClass ? { taxClass: source.taxClass } : {}),
      ...(source.originCountry ? { originCountry: source.originCountry } : {}),
      ...(source.year != null ? { year: source.year } : {}),
      ...(source.material ? { material: source.material } : {}),
      ...(source.imageId ? { imageId: source.imageId } : {}),
      variants: listed
        .map((v) => {
          const vp = v.price != null || pricing.overrides[`${id}:${v.id}`] != null ? sharedPrice(v.price ?? source.price, `${id}:${v.id}`, same, pricing) : null;
          return {
            id: v.id,
            name: v.name,
            ...(v.sku ? { sku: v.sku } : {}),
            ...(vp != null ? { price: vp } : {}),
            ...(v.weightG != null ? { weightG: v.weightG } : {}),
            ...(v.material ? { material: v.material } : {}),
            ...(v.imageId ? { imageId: v.imageId } : {}),
          };
        }),
      // Until it has a price in the store's currency it is shared but not sold.
      forSale: price != null,
      unlisted: false,
      consignorId: row.id,
      consignorName: name,
      consignorProductId: id,
      sortOrder: current?.sortOrder ?? 10_000,
      updatedAt: now,
    };
    ops.push({ type: 'product.upsert', payload: product });
    if (source.imageId) imageIds.add(source.imageId);
    for (const v of source.variants ?? []) if (v.imageId) imageIds.add(v.imageId);
  }
  ops.push(...imageOps(db, artist, storeAccountId, imageIds));
  return svc.writeOps(storeAccountId, ops);
}

/**
 * The artist's photos, copied as the thumbnails every device already syncs.
 * Only what is newer than the store's copy travels, so re-syncing an item
 * does not resend its picture.
 */
function imageOps(db: Database.Database, artist: string, store: string, ids: Set<string>): { type: WireOp['type']; payload: unknown }[] {
  if (!ids.size) return [];
  const latest = new Map<string, { imageId: string; productId: string; updatedAt: number; thumbB64?: string }>();
  const rows = db.prepare("SELECT payload FROM ops WHERE accountId = ? AND type = 'image.meta' ORDER BY seq").all(artist) as { payload: string }[];
  for (const r of rows) {
    const p = JSON.parse(r.payload) as { imageId: string; productId: string; updatedAt: number; thumbB64?: string };
    if (!ids.has(p.imageId) || !p.thumbB64) continue;
    const seen = latest.get(p.imageId);
    if (!seen || p.updatedAt >= seen.updatedAt) latest.set(p.imageId, p);
  }
  const out: { type: WireOp['type']; payload: unknown }[] = [];
  const mark = db.prepare(
    'INSERT INTO consignment_shared_images (accountId, imageId, updatedAt) VALUES (?, ?, ?) ON CONFLICT(accountId, imageId) DO UPDATE SET updatedAt = excluded.updatedAt',
  );
  for (const img of latest.values()) {
    const had = db.prepare('SELECT updatedAt FROM consignment_shared_images WHERE accountId = ? AND imageId = ?').get(store, img.imageId) as { updatedAt: number } | undefined;
    if (had && had.updatedAt >= img.updatedAt) continue;
    mark.run(store, img.imageId, img.updatedAt);
    out.push({ type: 'image.meta', payload: img });
  }
  return out;
}

/**
 * Shares or stops sharing. A key is a product id (the whole product, every
 * variant) or `productId:variantId` (that one variant). Stopping one variant
 * of a wholly shared product keeps the others.
 */
export function setShared(svc: ModuleServices, storeAccountId: string, row: ConsignorRow, keys: string[], shared: boolean, auto = false): void {
  const { db } = svc;
  const artist = artistOf(db, row);
  const products = artist ? new Map(replay(db, artist).products.map((p) => [p.id, p])) : new Map<string, Product>();
  const allVariants = (pid: string): string[] => (products.get(pid)?.variants ?? []).filter((v) => !v.unlisted).map((v) => v.id);
  const touched = new Set<string>();
  db.transaction(() => {
    const current = sharedVariants(db, storeAccountId, row.id);
    const write = (pid: string, variants: string[] | null): void => {
      db.prepare(
        `INSERT INTO consignment_shares (accountId, consignorId, productId, auto, sharedAt, variantIds) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(accountId, consignorId, productId) DO UPDATE SET auto = MIN(auto, excluded.auto), variantIds = excluded.variantIds`,
      ).run(storeAccountId, row.id, pid, auto ? 1 : 0, Date.now(), variants ? JSON.stringify(variants) : null);
      current.set(pid, variants);
    };
    const drop = (pid: string): void => {
      db.prepare('DELETE FROM consignment_shares WHERE accountId = ? AND consignorId = ? AND productId = ?').run(storeAccountId, row.id, pid);
      current.delete(pid);
    };
    for (const key of keys) {
      const [pid, vid] = key.split(':', 2) as [string, string | undefined];
      touched.add(pid);
      const now = current.has(pid) ? current.get(pid)! : undefined; // undefined: not shared; null: all variants
      if (!vid) {
        if (shared) write(pid, null);
        else drop(pid);
      } else if (shared) {
        if (now === null) continue;
        const next = [...new Set([...(now ?? []), vid])];
        // Every variant picked is the same as the whole product: new ones follow too.
        write(pid, allVariants(pid).every((v) => next.includes(v)) ? null : next);
      } else {
        if (now === undefined) continue;
        const next = (now ?? allVariants(pid)).filter((v) => v !== vid);
        if (next.length) write(pid, next);
        else drop(pid);
      }
    }
  })();
  syncShared(svc, storeAccountId, row, [...touched]);
}

/** The artist's own items, marked with what one store may sell. */
function shareableItems(db: Database.Database, storeAccountId: string, row: ConsignorRow, artist: string): ShareableItem[] {
  const shared = sharedIds(db, storeAccountId, row.id);
  const picked = sharedVariants(db, storeAccountId, row.id);
  const pricing = pricingOf(db, storeAccountId, row.id);
  const same = currencyOf(db, artist) === currencyOf(db, storeAccountId);
  return replay(db, artist)
    .products.filter((p) => !p.deletedAt && p.forSale)
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((p) => ({
      productId: p.id,
      title: p.title,
      ...(p.sku ? { sku: p.sku } : {}),
      ...(p.type ? { type: p.type } : {}),
      price: p.price,
      variants: (p.variants ?? [])
        .filter((v) => !v.unlisted)
        .map((v) => ({ id: v.id, name: v.name, price: v.price ?? p.price, shared: shared.has(p.id) && (!picked.get(p.id) || picked.get(p.id)!.includes(v.id)) })),
      shared: shared.has(p.id),
      autoShared: shared.get(p.id) === true,
      storePrice: sharedPrice(p.price, `${p.id}:`, same, pricing),
    }));
}

// ── Routes ──────────────────────────────────────────────────────────────────

const Key = z.string().min(1).max(170);
/** Either one direction for some keys, or a whole edit at once - what to share and what to stop. */
const ShareBody = z.union([
  z.object({ productIds: z.array(Key).min(1).max(500), shared: z.boolean() }).transform((b) => (b.shared ? { share: b.productIds, unshare: [] } : { share: [], unshare: b.productIds })),
  z.object({ share: z.array(Key).max(1000).default([]), unshare: z.array(Key).max(1000).default([]) }),
]);
const ScanBody = z.object({ code: z.string().trim().min(1).max(80) });

export function registerSharing(app: FastifyInstance, ctx: ModuleContext, side: Side): void {
  const { db } = ctx;

  // ── The artist's side ───────────────────────────────────────────────────

  if (side === 'artist') {
    /** Linked artist: their own catalogue, with what this store may sell. */
    app.get<{ Params: { storeAccountId: string; consignorId: string } }>('/links/:storeAccountId/:consignorId/shares', async (req, reply) => {
      const who = ctx.identity(req);
      const row = consignorRow(db, req.params.storeAccountId, req.params.consignorId);
      if (!row || row.linkedAccountId !== who.accountId || !isEnabled(db, row.accountId, MODULE_ID)) return reply.code(404).send({ error: 'not_found' });
      return {
        artistCurrency: currencyOf(db, who.accountId),
        storeCurrency: currencyOf(db, row.accountId),
        items: shareableItems(db, row.accountId, row, who.accountId),
      };
    });

    app.put<{ Params: { storeAccountId: string; consignorId: string } }>('/links/:storeAccountId/:consignorId/shares', async (req, reply) => {
      const who = ctx.identity(req);
      const row = consignorRow(db, req.params.storeAccountId, req.params.consignorId);
      if (!row || row.linkedAccountId !== who.accountId || !isEnabled(db, row.accountId, MODULE_ID)) return reply.code(404).send({ error: 'not_found' });
      const body = ShareBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Pick the items to share.' });
      const own = new Set(replay(db, who.accountId).products.filter((p) => !p.deletedAt).map((p) => p.id));
      const mine = (keys: string[]): string[] => keys.filter((k) => own.has(k.split(':', 1)[0]!));
      const share = mine(body.data.share);
      const unshare = mine(body.data.unshare);
      if (unshare.length) setShared(ctx, row.accountId, row, unshare, false);
      if (share.length) setShared(ctx, row.accountId, row, share, true);
      const name = parseDoc(row.doc).name;
      const total = sharedIds(db, row.accountId, row.id).size;
      // One note per artist, however often they press share: it says where things stand now.
      if (share.length || unshare.length) ctx.notify(row.accountId, { kind: 'sharing', level: 'low', groupKey: `sharing:${row.id}`,
        title: `${name} updated the items they share`,
        body: `${total} item${total === 1 ? '' : 's'} shared with you now - in your catalogue and on the till. Items taken off keep the sales already made.`,
        link: '/m/consignment/items',
        minRole: 'admin',
      });
      return { items: shareableItems(db, row.accountId, row, who.accountId) };
    });
  }

  // ── The store's side ────────────────────────────────────────────────────

  if (side === 'store') {
    /** How this artist's shared items are priced here, with each item's artist and store price. */
    app.get<{ Params: { id: string } }>('/consignors/:id/pricing', async (req, reply) => {
      const who = ctx.identity(req);
      const row = consignorRow(db, who.accountId, req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const artist = artistOf(db, row);
      return {
        artistCurrency: artist ? currencyOf(db, artist) : null,
        storeCurrency: currencyOf(db, who.accountId),
        pricing: pricingOf(db, who.accountId, row.id),
        items: artist ? shareableItems(db, who.accountId, row, artist).filter((i) => i.shared) : [],
      };
    });

    app.put<{ Params: { id: string } }>('/consignors/:id/pricing', async (req, reply) => {
      const who = ctx.identity(req);
      const row = consignorRow(db, who.accountId, req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const body = SharePricingSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'That pricing is not valid.' });
      db.prepare(
        `INSERT INTO consignment_pricing (accountId, consignorId, doc, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(accountId, consignorId) DO UPDATE SET doc = excluded.doc, updatedAt = excluded.updatedAt`,
      ).run(who.accountId, row.id, JSON.stringify(body.data), Date.now());
      syncShared(ctx, who.accountId, row);
      return { pricing: body.data };
    });

    /**
     * The till scanned a code it does not know. If a linked artist's item
     * carries it, share that item here now and tell the artist - the item is
     * physically in the shop, so it should be sellable.
     */
    app.post('/scan', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
      const who = ctx.identity(req);
      const body = ScanBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const code = body.data.code.toLowerCase();
      const rows = db.prepare('SELECT * FROM consignors WHERE accountId = ? AND linkedAccountId IS NOT NULL').all(who.accountId) as ConsignorRow[];
      for (const row of rows) {
        const artist = artistOf(db, row);
        if (!artist || parseDoc(row.doc).archived) continue;
        for (const p of replay(db, artist).products) {
          if (p.deletedAt || !p.forSale) continue;
          const hit = matchCode(p, code);
          if (!hit) continue;
          const picked = sharedVariants(db, who.accountId, row.id);
          const already = picked.has(p.id) && (!hit.variantId || !picked.get(p.id) || picked.get(p.id)!.includes(hit.variantId));
          if (!already) {
            // Just what was scanned: that variant, or the product when it has none.
            setShared(ctx, who.accountId, row, [hit.variantId ? `${p.id}:${hit.variantId}` : p.id], true, true);
            ctx.notify(artist, { kind: 'sharing', level: 'low', groupKey: `scanned:${row.accountId}:${row.id}`,
              title: `${p.title} was scanned at ${accountName(db, who.accountId)} and is now shared`,
              body: 'It is on their till. Stop sharing it under Stores → My stores if that was a mistake.',
              link: '/m/consignment-artist',
              minRole: 'admin',
            });
          }
          const priced = sharedPrice(p.price, `${p.id}:`, currencyOf(db, artist) === currencyOf(db, who.accountId), pricingOf(db, who.accountId, row.id)) != null;
          return { productId: p.id, variantId: hit.variantId, consignorName: parseDoc(row.doc).name, autoShared: !already, priced };
        }
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  }
}

/** The same exact matches the till makes: SKU, or the short code printed on a label. */
function matchCode(p: Product, code: string): { variantId: string | null } | null {
  const eq = (s: string | undefined): boolean => !!s && s.trim().toLowerCase() === code;
  if (!p.variants?.length && (eq(p.sku) || matchesShortBarcode(code, p.type, p.id))) return { variantId: null };
  for (const v of p.variants ?? []) {
    if (v.unlisted) continue;
    if (eq(v.sku) || matchesShortBarcode(code, p.type, p.id, v.id)) return { variantId: v.id };
  }
  if (p.variants?.length && eq(p.sku)) return { variantId: null };
  return null;
}

/**
 * An account's devices pushed changes. If the account is an artist linked
 * to stores, and it touched items those stores share, rewrite the stores'
 * copies so prices, titles and photos follow the artist.
 */
export function followArtistChanges(svc: ModuleServices, accountId: string, ops: WireOp[]): void {
  const touched = new Set<string>();
  for (const op of ops) {
    const p = op.payload as { id?: string; productId?: string } | null;
    if (op.type === 'product.upsert' && p?.id) touched.add(p.id);
    else if (op.type === 'product.delete' && (p?.id || p?.productId)) touched.add((p.id ?? p.productId)!);
    else if (op.type === 'image.meta' && p?.productId) touched.add(p.productId);
  }
  if (!touched.size) return;
  const rows = svc.db.prepare('SELECT * FROM consignors WHERE linkedAccountId = ?').all(accountId) as ConsignorRow[];
  for (const row of rows) {
    if (!isEnabled(svc.db, row.accountId, MODULE_ID)) continue;
    const shared = sharedIds(svc.db, row.accountId, row.id);
    const ids = [...touched].filter((id) => shared.has(id));
    if (ids.length) syncShared(svc, row.accountId, row, ids);
  }
}
