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
}

export class RestoreError extends Error {}

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
 * other way to know they are gone.
 */
export async function createBackup(): Promise<ZollifyBackup> {
  const account = requireAccount();
  const db = openCoreDb(account.accountId);

  const [products, events, inventory, eventStock, transactions] = await Promise.all([
    db.products.toArray(),
    db.events.toArray(),
    db.inventory.toArray(),
    db.eventStock.toArray(),
    db.transactions.toArray(),
  ]);

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
  };
}

export interface RestoreResult {
  products: number;
  events: number;
  inventory: number;
  eventStock: number;
  transactions: number;
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
