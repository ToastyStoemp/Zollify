import type { EventStock, InventoryItem, Product, SalesEvent, Transaction } from '@zollify/shared';
import { deleteCoreDb, openCoreDb } from './db';
import { listZollifyDbs } from '../module-db';
import Dexie from 'dexie';
import { authFetch } from '../session';
import { getAccount } from '../session';
import { toPlain } from './plain';
import { loadCatalog, resetCatalogCache } from './catalog';
import { loadSalesEvents, resetSalesEventCache } from './sales-events';
import { loadTransactions, resetTransactionCache } from './transactions';
import { loadInventory, resetInventoryCache } from './inventory';
import { queueOp } from './outbox';
import { base64ToBlob, blobToBase64, importProductImage } from './images';

/**
 * Local backup and restore.
 *
 * The authoritative copy of a booth's data is the device it was entered on -
 * sync is a convenience, not a guarantee, and a booth often works a whole
 * convention offline. Without an export there is no recovery from a lost or
 * wiped device, which makes this a data-safety feature rather than a
 * convenience one.
 */

export const BACKUP_VERSION = 1;

/** An image, blobs base64-encoded so the whole backup is one JSON file. */
export interface BackupImage {
  id: string;
  productId: string;
  updatedAt: number;
  fullB64: string;
  fullType: string;
  thumbB64: string;
  thumbType: string;
}

export interface ZollifyBackup {
  format: 'zollify-backup';
  version: number;
  exportedAt: string;
  /** Recorded so a restore into the wrong account is visible, not silent. */
  accountId: string;
  accountName: string;
  products: Product[];
  events: SalesEvent[];
  /** The one inventory: what the booth owns. */
  inventory: InventoryItem[];
  /** Per-event claims against it. */
  eventStock: EventStock[];
  transactions: Transaction[];
  /** Product photos - optional so a version-1 backup from before they were added still restores. */
  images?: BackupImage[];
}

export class RestoreError extends Error {}

/** Which categories to pull into an export - unset means "all of them", same as before this existed. */
export interface BackupOptions {
  products?: boolean;
  events?: boolean;
  inventory?: boolean;
  eventStock?: boolean;
  transactions?: boolean;
  images?: boolean;
  /**
   * Restrict to one or more events instead of the whole booth - undefined or
   * empty means every event, same as before this existed. Events, event
   * stock and transactions filter directly (they carry an id/eventId);
   * inventory has no eventId of its own (it's the one booth-wide "what we
   * own" list, not per event), so it's narrowed to just the product/variant
   * rows that were actually claimed for the selected events instead.
   */
  eventIds?: string[];
}

const ALL_INCLUDED: Required<Omit<BackupOptions, 'eventIds'>> = {
  products: true,
  events: true,
  inventory: true,
  eventStock: true,
  transactions: true,
  images: true,
};

function requireAccount() {
  const account = getAccount();
  if (!account) throw new Error('Backup was used while signed out.');
  return account;
}

/**
 * Everything core owns, including soft-deleted rows.
 *
 * Tombstones are kept deliberately: dropping them would make a restore
 * resurrect every product ever deleted, because last-write-wins sync has no
 * other way to know they are gone. A category left out of `options` is left
 * out of the file entirely, not written as an empty array vs. omitted - a
 * restore already treats a missing field as "nothing to restore here"
 * (`file.products ?? []` etc.), so an old, pre-options backup restores the
 * same way it always did.
 */
export async function createBackup(options?: BackupOptions): Promise<ZollifyBackup> {
  const include = { ...ALL_INCLUDED, ...options };
  const account = requireAccount();
  const db = openCoreDb(account.accountId);

  let [products, events, inventory, eventStock, transactions, imageRecs] = await Promise.all([
    include.products ? db.products.toArray() : Promise.resolve([]),
    include.events ? db.events.toArray() : Promise.resolve([]),
    include.inventory ? db.inventory.toArray() : Promise.resolve([]),
    include.eventStock ? db.eventStock.toArray() : Promise.resolve([]),
    include.transactions ? db.transactions.toArray() : Promise.resolve([]),
    include.images ? db.images.toArray() : Promise.resolve([]),
  ]);

  if (include.eventIds && include.eventIds.length) {
    const wanted = new Set(include.eventIds);
    events = events.filter((e) => wanted.has(e.id));
    eventStock = eventStock.filter((s) => wanted.has(s.eventId));
    transactions = transactions.filter((t) => wanted.has(t.eventId));
    // Only the stock actually claimed for these events, not the whole booth.
    const claimed = new Set(eventStock.map((s) => `${s.productId}\x00${s.variantId}`));
    inventory = inventory.filter((i) => claimed.has(`${i.productId}\x00${i.variantId}`));
  }

  const images: BackupImage[] = await Promise.all(
    imageRecs.map(async (rec) => ({
      id: rec.id,
      productId: rec.productId,
      updatedAt: rec.updatedAt,
      fullB64: await blobToBase64(rec.full),
      fullType: rec.full.type,
      thumbB64: await blobToBase64(rec.thumb),
      thumbType: rec.thumb.type,
    })),
  );

  return {
    format: 'zollify-backup',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    accountId: account.accountId,
    accountName: account.accountName,
    products,
    events,
    inventory,
    eventStock,
    transactions,
    images,
  };
}

export interface BackupSummary {
  exportedAt: string;
  accountName: string;
  sameAccount: boolean;
  products: number;
  events: number;
  inventory: number;
  eventStock: number;
  transactions: number;
  images: number;
}

/**
 * Validates a backup and describes it, without writing anything.
 *
 * Restores overwrite live data, so the caller shows this first. Discovering the
 * wrong file after the fact is not recoverable.
 */
export function inspectBackup(raw: unknown): BackupSummary {
  if (typeof raw !== 'object' || raw === null) {
    throw new RestoreError('That file is not a Zollify backup.');
  }
  const file = raw as Partial<ZollifyBackup>;

  if (file.format !== 'zollify-backup') {
    throw new RestoreError('That file is not a Zollify backup.');
  }
  if (file.version !== BACKUP_VERSION) {
    throw new RestoreError(
      `This app reads backup version ${BACKUP_VERSION}; the file is version ${String(file.version)}.`,
    );
  }

  const account = requireAccount();

  return {
    exportedAt: String(file.exportedAt ?? 'unknown'),
    accountName: String(file.accountName ?? 'unknown'),
    sameAccount: file.accountId === account.accountId,
    products: file.products?.length ?? 0,
    events: file.events?.length ?? 0,
    inventory: file.inventory?.length ?? 0,
    eventStock: file.eventStock?.length ?? 0,
    transactions: file.transactions?.length ?? 0,
    images: file.images?.length ?? 0,
  };
}

export interface RestoreResult {
  products: number;
  events: number;
  inventory: number;
  eventStock: number;
  transactions: number;
  images: number;
}

/**
 * Writes a backup back into core.
 *
 * Rows are merged rather than the database being cleared first: a restore is
 * usually recovering a device, and wiping anything that happened since the
 * export would turn a partial loss into a total one. Ops are recorded so the
 * restored rows reach the other devices too.
 */
export async function restoreBackup(raw: unknown): Promise<RestoreResult> {
  const summary = inspectBackup(raw);
  const file = raw as ZollifyBackup;
  const account = requireAccount();
  const db = openCoreDb(account.accountId);

  const products = (file.products ?? []).map(toPlain);
  const events = (file.events ?? []).map(toPlain);
  const stock = (file.eventStock ?? []).map((s) => toPlain({ ...s, variantId: s.variantId ?? '' }));
  const inventory = (file.inventory ?? []).map((i) => toPlain({ ...i, variantId: i.variantId ?? '' }));
  const transactions = (file.transactions ?? []).map(toPlain);

  await db.transaction('rw', [db.products, db.events, db.eventStock, db.transactions, db.inventory], async () => {
    if (products.length) await db.products.bulkPut(products);
    if (events.length) await db.events.bulkPut(events);
    if (inventory.length) await db.inventory.bulkPut(inventory);
    if (stock.length) await db.eventStock.bulkPut(stock);
    // Sales are immutable, so an existing row always wins over the file's copy.
    for (const tx of transactions) {
      if (!(await db.transactions.get(tx.id))) await db.transactions.put(tx);
    }
  });

  // Queued after the write, so a failed restore leaves nothing half-announced.
  for (const product of products) await queueOp({ type: 'product.upsert', payload: product });
  for (const event of events) await queueOp({ type: 'event.upsert', payload: event });
  for (const item of inventory) await queueOp({ type: 'inventory.set', payload: item });
  for (const entry of stock) await queueOp({ type: 'stock.set', payload: entry });
  for (const tx of transactions) await queueOp({ type: 'tx.create', payload: tx });

  // Images go through the same path a fresh photo does, one at a time - each
  // one queues its own thumbnail op, and there is no bulk equivalent worth
  // building for something that runs once per restore.
  for (const image of file.images ?? []) {
    await importProductImage({
      id: image.id,
      productId: image.productId,
      updatedAt: image.updatedAt,
      full: base64ToBlob(image.fullB64, image.fullType),
      thumb: base64ToBlob(image.thumbB64, image.thumbType),
    });
  }

  // Rebuilt rather than patched - a restore touches everything, and reloading
  // from the database is both simpler and impossible to get subtly wrong.
  resetCatalogCache();
  resetSalesEventCache();
  resetTransactionCache();
  resetInventoryCache();
  await Promise.all([loadCatalog(), loadSalesEvents(), loadTransactions(), loadInventory()]);

  return {
    products: summary.products,
    events: summary.events,
    inventory: summary.inventory,
    eventStock: summary.eventStock,
    transactions: summary.transactions,
    images: summary.images,
  };
}

/** Filename that sorts chronologically and says which account it came from. */
export function backupFilename(backup: ZollifyBackup): string {
  const stamp = backup.exportedAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const account = backup.accountName.replace(/[^A-Za-z0-9-]+/g, '-').toLowerCase();
  return `zollify-${account}-${stamp}.json`;
}

/**
 * Erases the booth's data everywhere and starts over: the server drops the
 * account's op log, then every local Zollify database for the account on this
 * device is deleted and the app reloads to an empty booth. Other devices
 * discard their copy on their next sync (the server's epoch changed); their
 * unpushed sales are kept locally, as with any epoch change.
 */
export async function wipeAccountData(): Promise<void> {
  const account = getAccount();
  if (!account) throw new Error('Not signed in.');
  // The device identity lives in the same database; keep it so this stays the
  // same registered device (and its refresh token) after the reload.
  const keep = await openCoreDb(account.accountId).settings.where('key').startsWith('core.device').toArray();
  await authFetch('/account/wipe', { method: 'POST' });
  await deleteCoreDb(account.accountId);
  const mine = (await listZollifyDbs()).filter((n) => n.includes(account.accountId.replace(/[^A-Za-z0-9_-]/g, '_')));
  for (const name of mine) await Dexie.delete(name);
  await openCoreDb(account.accountId).settings.bulkPut(keep);
  window.location.reload();
}
