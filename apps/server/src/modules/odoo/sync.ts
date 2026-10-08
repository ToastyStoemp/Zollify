import type Database from 'better-sqlite3';
import type { InventoryItem, Product, SavedMatches, Transaction } from '@zollify/shared';
import type { ShopProduct } from '../shopify-sync/types';
import { reduceMerges, reduceProducts, reduceTransactions, reportProblem, resolveProblem, type ModuleServices } from '@zollify/server-core';
import { OdooClient, m2oId, type OdooProduct } from './odoo';

/**
 * What moves between Zollify and Odoo, and the rules that keep the two from
 * fighting.
 *
 * Stock. Zollify's level for an item is the last count (`inventory.set`,
 * "total owned") less what sold since - the till's own rule. Odoo's is the
 * quantity on hand at one chosen location. The two are held equal through an
 * "agreed" level per item, the last figure both sides had:
 *
 *   - Zollify changed (a sale, a revert, a recount): Odoo is set to Zollify's
 *     level with an inventory adjustment, and that becomes agreed.
 *   - Odoo changed (a web order, a delivery): seen on the next pull as a
 *     quantity that differs from agreed; Zollify's count is set to it.
 *   - Both changed since the last agreement: Odoo wins on the pull. Sales
 *     push within seconds, so the window is narrow; a recount on either side
 *     after a long outage is the honest fix.
 *   - Never agreed yet (a match just made): the first sync takes Odoo's
 *     figure, the web shop being the book of record - unless a sale happens
 *     here first, which pushes as any sale does.
 *
 * Invoices. Every sale at the till can become a posted customer invoice in
 * Odoo, one per sale, lines on the matched products, so Odoo's books and
 * stock valuation see it. Prices go across as charged, VAT included; the
 * product's own sales taxes apply, so they must be set "included in price"
 * in Odoo - the way a shop's taxes are. A reverted sale becomes a credit
 * note. Nothing is written twice: each sale's invoice is remembered.
 */

export const MODULE_ID = 'odoo-sync';

export interface OdooSettings {
  url: string;
  db: string;
  login: string;
  apiKey: string;
  /** stock.location the shelf is, for quantities on hand. */
  locationId: number | null;
  syncStock: boolean;
  invoiceSales: boolean;
  /** account.journal (sales) for invoices; Odoo's default when null. */
  journalId: number | null;
  /** res.partner the till's sales are invoiced to; made on first use when null. */
  partnerId: number | null;
}

export interface SyncOutcome {
  pushed: number;
  pulled: number;
  skipped: string[];
}

// ── Zollify's side ───────────────────────────────────────────────────────────

export const itemKey = (productId: string, variantId: string): string => `${productId}:${variantId}`;

/** The catalogue and the level of every item, by the till's rule. */
export function stockState(db: Database.Database, accountId: string) {
  const types = ['tx.create', 'tx.revert', 'product.merge', 'product.upsert', 'product.delete', 'inventory.set'];
  const ops = (
    db.prepare(`SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY seq`).all(accountId, ...types) as { opId: string; type: string; payload: string }[]
  ).map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) as unknown }));
  const counts = new Map<string, InventoryItem>();
  for (const op of ops) {
    if (op.type !== 'inventory.set') continue;
    const row = op.payload as InventoryItem;
    const k = itemKey(row.productId, row.variantId ?? '');
    if (!counts.has(k) || row.updatedAt >= counts.get(k)!.updatedAt) counts.set(k, row);
  }
  const products = reduceProducts(ops).filter((p) => !p.deletedAt);
  const transactions = reduceTransactions(ops, reduceMerges(ops)) as Transaction[];
  const remaining = (productId: string, variantId: string): number => {
    const count = counts.get(itemKey(productId, variantId));
    const since = count?.updatedAt ?? 0;
    let sold = 0;
    for (const tx of transactions) {
      if (tx.revertedAt || tx.revertedBy || tx.timestamp <= since) continue;
      for (const i of tx.items) if (i.pid === productId && (i.vid ?? '') === variantId) sold += i.qty;
    }
    return Math.max(0, (count?.onHand ?? 0) - sold);
  };
  return { products, transactions, remaining, counted: (productId: string, variantId: string) => counts.has(itemKey(productId, variantId)) };
}

/** Every unit a product has: its variants, or itself. */
export function unitsOf(p: Product): { variantId: string; title: string }[] {
  return p.variants.length ? p.variants.map((v) => ({ variantId: v.id, title: `${p.title} - ${v.name}` })) : [{ variantId: '', title: p.title }];
}

/** Zollify item → Odoo product.product id, from the saved matches. */
export function matchedOdooIds(db: Database.Database, accountId: string): Map<string, number> {
  const rows = db.prepare('SELECT productId, payload FROM odoo_matches WHERE accountId = ?').all(accountId) as { productId: string; payload: string }[];
  const out = new Map<string, number>();
  for (const r of rows) {
    const saved = JSON.parse(r.payload) as SavedMatches[string];
    for (const [variantId, ref] of Object.entries(saved.variants ?? {})) {
      const id = Number(ref?.variantId);
      if (ref && Number.isInteger(id)) out.set(itemKey(r.productId, variantId), id);
    }
  }
  return out;
}

// ── Odoo's side ──────────────────────────────────────────────────────────────

/**
 * Odoo's products in the shape the catalogue matcher takes: a template is a
 * product, each product.product a variant. The display name carries the
 * attribute values ("T-shirt (Red, M)"); the variant's title is that tail.
 */
export async function odooCatalogue(client: OdooClient): Promise<ShopProduct[]> {
  const rows = await client.searchRead<OdooProduct>('product.product', [['sale_ok', '=', true]], ['name', 'display_name', 'default_code', 'barcode', 'lst_price', 'product_tmpl_id', 'qty_available', 'active'], { limit: 5000, order: 'product_tmpl_id, id' });
  const byTemplate = new Map<number, ShopProduct>();
  for (const r of rows) {
    const tmplId = m2oId(r.product_tmpl_id) ?? r.id;
    let p = byTemplate.get(tmplId);
    if (!p) byTemplate.set(tmplId, (p = { id: String(tmplId), title: r.name, handle: '', productType: '', images: [], variants: [] }));
    const tail = r.display_name.replace(/^\[[^\]]*\]\s*/, '').replace(r.name, '').trim().replace(/^\((.*)\)$/, '$1');
    p.variants.push({ id: String(r.id), title: tail || 'Default Title', sku: (r.default_code || r.barcode || '') as string, price: String(r.lst_price) });
  }
  return [...byTemplate.values()];
}

/** Quantity on hand per product.product id at the location. */
export async function odooLevels(client: OdooClient, ids: number[], locationId: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await client.call<{ id: number; qty_available: number }[]>('product.product', 'read', [ids.slice(i, i + 200), ['qty_available']], { context: { location: locationId } });
    for (const r of rows) out.set(r.id, r.qty_available);
  }
  return out;
}

/** An inventory adjustment: the quant at the location is set to `qty` and applied. */
export async function setOdooLevel(client: OdooClient, productId: number, locationId: number, qty: number): Promise<void> {
  const ctx = { context: { inventory_mode: true } };
  const found = await client.searchRead<{ id: number }>('stock.quant', [['product_id', '=', productId], ['location_id', '=', locationId]], ['id'], ctx);
  let ids = found.map((q) => q.id);
  if (ids.length) await client.write('stock.quant', ids, { inventory_quantity: qty }, ctx);
  else ids = [await client.create('stock.quant', { product_id: productId, location_id: locationId, inventory_quantity: qty }, ctx)];
  await client.call('stock.quant', 'action_apply_inventory', [ids], ctx);
}

// ── Keeping the two equal ────────────────────────────────────────────────────

const agreedOf = (db: Database.Database, accountId: string): Map<string, number> =>
  new Map((db.prepare('SELECT productId, variantId, qty FROM odoo_stock WHERE accountId = ?').all(accountId) as { productId: string; variantId: string; qty: number }[]).map((r) => [itemKey(r.productId, r.variantId), r.qty]));

const agree = (db: Database.Database, accountId: string, productId: string, variantId: string, qty: number, source: 'push' | 'pull'): void => {
  db.prepare('INSERT INTO odoo_stock (accountId, productId, variantId, qty, source, syncedAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (accountId, productId, variantId) DO UPDATE SET qty = excluded.qty, source = excluded.source, syncedAt = excluded.syncedAt').run(accountId, productId, variantId, qty, source, Date.now());
};

export function logLine(db: Database.Database, accountId: string, kind: string, message: string): void {
  db.prepare('INSERT INTO odoo_log (accountId, at, kind, message) VALUES (?, ?, ?, ?)').run(accountId, Date.now(), kind, message);
  db.prepare('DELETE FROM odoo_log WHERE accountId = ? AND id NOT IN (SELECT id FROM odoo_log WHERE accountId = ? ORDER BY id DESC LIMIT 100)').run(accountId, accountId);
}

/**
 * Zollify → Odoo for the items named (or every matched item): each whose
 * level differs from the agreed one is set in Odoo. Only counted items go
 * across - a product nobody has counted has no level to send.
 */
export async function pushStock(svc: ModuleServices, client: OdooClient, accountId: string, s: OdooSettings, only?: Set<string>): Promise<number> {
  if (!s.locationId) return 0;
  const { remaining, counted } = stockState(svc.db, accountId);
  const matched = matchedOdooIds(svc.db, accountId);
  const agreed = agreedOf(svc.db, accountId);
  let pushed = 0;
  for (const [key, odooId] of matched) {
    if (only && !only.has(key)) continue;
    const cut = key.indexOf(':');
    const productId = key.slice(0, cut);
    const variantId = key.slice(cut + 1);
    if (!counted(productId, variantId)) continue;
    const qty = remaining(productId, variantId);
    if (agreed.get(key) === qty) continue;
    await setOdooLevel(client, odooId, s.locationId, qty);
    agree(svc.db, accountId, productId, variantId, qty, 'push');
    pushed++;
  }
  return pushed;
}

/** Odoo → Zollify: every matched item whose Odoo quantity moved since the last agreement gets a fresh count. */
export async function pullStock(svc: ModuleServices, client: OdooClient, accountId: string, s: OdooSettings): Promise<number> {
  if (!s.locationId) return 0;
  const matched = matchedOdooIds(svc.db, accountId);
  if (!matched.size) return 0;
  const { remaining } = stockState(svc.db, accountId);
  const agreed = agreedOf(svc.db, accountId);
  const levels = await odooLevels(client, [...new Set(matched.values())], s.locationId);
  const now = Date.now();
  const ops: { type: 'inventory.set'; payload: InventoryItem }[] = [];
  for (const [key, odooId] of matched) {
    const qty = levels.get(odooId);
    if (qty === undefined) continue;
    const cut = key.indexOf(':');
    const productId = key.slice(0, cut);
    const variantId = key.slice(cut + 1);
    const known = agreed.get(key);
    // Odoo unchanged since both sides agreed: nothing to bring over. Never agreed yet and equal: now they are.
    if (known === qty) continue;
    if (known === undefined && remaining(productId, variantId) === qty) {
      agree(svc.db, accountId, productId, variantId, qty, 'pull');
      continue;
    }
    ops.push({ type: 'inventory.set', payload: { productId, variantId, onHand: Math.max(0, Math.round(qty)), updatedAt: now } });
    agree(svc.db, accountId, productId, variantId, qty, 'pull');
  }
  if (ops.length) svc.writeOps(accountId, ops);
  return ops.length;
}

// ── Invoices ─────────────────────────────────────────────────────────────────

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The partner the till's sales go to, made once. */
async function ensurePartner(client: OdooClient, s: OdooSettings, save: (s: OdooSettings) => void): Promise<number> {
  if (s.partnerId) return s.partnerId;
  const found = await client.searchRead<{ id: number }>('res.partner', [['name', '=', 'Zollify till sales']], ['id'], { limit: 1 });
  const id = found[0]?.id ?? (await client.create('res.partner', { name: 'Zollify till sales', customer_rank: 1 }));
  s.partnerId = id;
  save(s);
  return id;
}

const currencyIds = new Map<string, number>();
async function currencyId(client: OdooClient, code: string): Promise<number | null> {
  const key = `${client.host}|${code}`;
  if (currencyIds.has(key)) return currencyIds.get(key)!;
  const rows = await client.searchRead<{ id: number }>('res.currency', [['name', '=', code]], ['id'], { limit: 1, context: { active_test: false } });
  const id = rows[0]?.id ?? null;
  if (id) currencyIds.set(key, id);
  return id;
}

/** One posted customer invoice for a sale; the move id, or null when it was already invoiced. */
export async function invoiceSale(svc: ModuleServices, client: OdooClient, accountId: string, s: OdooSettings, save: (s: OdooSettings) => void, tx: Transaction, titleOf: (pid: string, vid: string) => string): Promise<number | null> {
  if (svc.db.prepare('SELECT 1 FROM odoo_invoices WHERE accountId = ? AND txId = ?').get(accountId, tx.id)) return null;
  const matched = matchedOdooIds(svc.db, accountId);
  const partnerId = await ensurePartner(client, s, save);
  const lines = tx.items.map((i) => {
    const odooId = matched.get(itemKey(i.pid, i.vid ?? ''));
    return [0, 0, { ...(odooId ? { product_id: odooId } : {}), name: titleOf(i.pid, i.vid ?? ''), quantity: i.qty, price_unit: round2(i.lineTotal / (i.qty || 1)) }];
  });
  const currency = await currencyId(client, tx.currency);
  const moveId = await client.create('account.move', {
    move_type: 'out_invoice',
    partner_id: partnerId,
    invoice_date: day(tx.timestamp),
    ref: `Zollify sale ${tx.id}`,
    ...(s.journalId ? { journal_id: s.journalId } : {}),
    ...(currency ? { currency_id: currency } : {}),
    invoice_line_ids: lines,
  });
  await client.call('account.move', 'action_post', [[moveId]]);
  svc.db.prepare('INSERT INTO odoo_invoices (accountId, txId, moveId, reversalId, createdAt) VALUES (?, ?, ?, NULL, ?)').run(accountId, tx.id, moveId, Date.now());
  return moveId;
}

/** A reverted sale: its invoice gets a posted credit note, through Odoo's own reversal wizard. */
export async function creditSale(svc: ModuleServices, client: OdooClient, accountId: string, txId: string): Promise<number | null> {
  const row = svc.db.prepare('SELECT moveId, reversalId FROM odoo_invoices WHERE accountId = ? AND txId = ?').get(accountId, txId) as { moveId: number; reversalId: number | null } | undefined;
  if (!row || row.reversalId) return null;
  const wizard = await client.create('account.move.reversal', { reason: 'Sale reverted in Zollify', date: day(Date.now()) }, { context: { active_model: 'account.move', active_ids: [row.moveId] } });
  const action = await client.call<{ res_id?: number; domain?: unknown }>('account.move.reversal', 'reverse_moves', [[wizard]], { context: { active_model: 'account.move', active_ids: [row.moveId] } });
  let reversalId = action?.res_id ?? null;
  if (!reversalId) {
    const notes = await client.searchRead<{ id: number }>('account.move', [['reversed_entry_id', '=', row.moveId]], ['id'], { limit: 1, order: 'id desc' });
    reversalId = notes[0]?.id ?? null;
  }
  if (!reversalId) throw new Error('Odoo made no credit note.');
  await client.call('account.move', 'action_post', [[reversalId]]).catch(() => undefined); // already posted on some versions
  svc.db.prepare('UPDATE odoo_invoices SET reversalId = ? WHERE accountId = ? AND txId = ?').run(reversalId, accountId, txId);
  return reversalId;
}

/** Reports a failure to the account's admins, and clears it when the next run works. */
export async function tracked<T>(svc: ModuleServices, accountId: string, what: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    const out = await run();
    resolveProblem(svc, accountId, 'odoo.sync');
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine(svc.db, accountId, 'error', `${what}: ${message}`);
    reportProblem(svc, accountId, { kind: 'odoo.sync', severity: 'warning', message: `Odoo: ${what} failed`, detail: message, link: '/m/odoo-sync' });
    return undefined;
  }
}

