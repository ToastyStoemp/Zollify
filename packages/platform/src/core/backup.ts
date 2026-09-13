import type { EventStock, Product, SalesEvent, Transaction } from '@boothly/shared';
import { openCoreDb } from './db';
import { getAccount } from '../session';
import { toPlain } from './plain';
import { loadCatalog, resetCatalogCache } from './catalog';
import { loadSalesEvents, resetSalesEventCache } from './sales-events';
import { loadTransactions, resetTransactionCache } from './transactions';
import { queueOp } from './outbox';

/**
 * Local backup and restore.
 *
 * The authoritative copy of a booth's data is the device it was entered on —
 * sync is a convenience, not a guarantee, and a booth often works a whole
 * convention offline. Without an export there is no recovery from a lost or
 * wiped device, which makes this a data-safety feature rather than a
 * convenience one.
 */

export const BACKUP_VERSION = 1;

export interface BoothlyBackup {
  format: 'boothly-backup';
  version: number;
  exportedAt: string;
  /** Recorded so a restore into the wrong account is visible, not silent. */
  accountId: string;
  accountName: string;
  products: Product[];
  events: SalesEvent[];
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
export async function createBackup(): Promise<BoothlyBackup> {
  const account = requireAccount();
  const db = openCoreDb(account.accountId);

  const [products, events, eventStock, transactions] = await Promise.all([
    db.products.toArray(),
    db.events.toArray(),
    db.eventStock.toArray(),
    db.transactions.toArray(),
  ]);

  return {
    format: 'boothly-backup',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    accountId: account.accountId,
    accountName: account.accountName,
    products,
    events,
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
    throw new RestoreError('That file is not a Boothly backup.');
  }
  const file = raw as Partial<BoothlyBackup>;

  if (file.format !== 'boothly-backup') {
    throw new RestoreError('That file is not a Boothly backup.');
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
    eventStock: file.eventStock?.length ?? 0,
    transactions: file.transactions?.length ?? 0,
  };
}

export interface RestoreResult {
  products: number;
  events: number;
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
  const file = raw as BoothlyBackup;
  const account = requireAccount();
  const db = openCoreDb(account.accountId);

  const products = (file.products ?? []).map(toPlain);
  const events = (file.events ?? []).map(toPlain);
  const stock = (file.eventStock ?? []).map((s) => toPlain({ ...s, variantId: s.variantId ?? '' }));
  const transactions = (file.transactions ?? []).map(toPlain);

  await db.transaction('rw', db.products, db.events, db.eventStock, db.transactions, async () => {
    if (products.length) await db.products.bulkPut(products);
    if (events.length) await db.events.bulkPut(events);
    if (stock.length) await db.eventStock.bulkPut(stock);
    // Sales are immutable, so an existing row always wins over the file's copy.
    for (const tx of transactions) {
      if (!(await db.transactions.get(tx.id))) await db.transactions.put(tx);
    }
  });

  // Queued after the write, so a failed restore leaves nothing half-announced.
  for (const product of products) await queueOp({ type: 'product.upsert', payload: product });
  for (const event of events) await queueOp({ type: 'event.upsert', payload: event });
  for (const entry of stock) await queueOp({ type: 'stock.set', payload: entry });
  for (const tx of transactions) await queueOp({ type: 'tx.create', payload: tx });

  // Rebuilt rather than patched — a restore touches everything, and reloading
  // from the database is both simpler and impossible to get subtly wrong.
  resetCatalogCache();
  resetSalesEventCache();
  resetTransactionCache();
  await Promise.all([loadCatalog(), loadSalesEvents(), loadTransactions()]);

  return {
    products: summary.products,
    events: summary.events,
    eventStock: summary.eventStock,
    transactions: summary.transactions,
  };
}

/** Filename that sorts chronologically and says which account it came from. */
export function backupFilename(backup: BoothlyBackup): string {
  const stamp = backup.exportedAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const account = backup.accountName.replace(/[^A-Za-z0-9-]+/g, '-').toLowerCase();
  return `boothly-${account}-${stamp}.json`;
}
