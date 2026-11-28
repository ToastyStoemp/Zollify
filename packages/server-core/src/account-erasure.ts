import type Database from 'better-sqlite3';
import { eraseAccountRows, type AccountData, type ErasureMode } from './account-data';
import { CORE_ACCOUNT_FILES, queueFileRemovals, removeQueuedFiles } from './account-files';

/**
 * Deleting an account and wiping its data are the same job with a different
 * column of the declarations (account-data.ts): one transaction for every
 * row, then the files.
 */

export interface AccountEraser {
  /** Ends the account: every declared row and file goes, unless declared `retain`. */
  deleteAccount(accountId: string): void;
  /**
   * Starts the booth over and bumps the sync epoch, so devices holding the old
   * log throw it away on their next pull. Returns how many ops went.
   */
  wipeAccount(accountId: string): number;
}

export interface EraserOptions {
  db: Database.Database;
  dataDir: string;
  data: AccountData;
  /**
   * Runs inside the transaction, before the rows go: what a module must undo
   * in other accounts' rows (a store unlinking an artist that is leaving).
   */
  beforeErase?(accountId: string, mode: ErasureMode): void;
}

function countOps(db: Database.Database, accountId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM ops WHERE accountId = ?').get(accountId) as { n: number }).n;
}

/** Best-effort: the database is already right, and whatever stays queued is removed at the next start. */
function removeFilesNow(db: Database.Database, dataDir: string): void {
  try {
    removeQueuedFiles(db, dataDir);
  } catch {
    /* the queue is still there */
  }
}

export function createAccountEraser({ db, dataDir, data, beforeErase }: EraserOptions): AccountEraser {
  // All or nothing: a throw anywhere (a module's hook included) leaves the account exactly as it was.
  const eraseRows = db.transaction((accountId: string, mode: ErasureMode): number => {
    // File paths are read from rows this same transaction is about to erase, so they are queued first.
    queueFileRemovals(db, CORE_ACCOUNT_FILES, accountId, mode);
    beforeErase?.(accountId, mode);
    const ops = countOps(db, accountId);
    eraseAccountRows(db, data.tables, accountId, mode);
    if (mode === 'wipe') db.prepare('UPDATE accounts SET syncEpoch = syncEpoch + 1 WHERE id = ?').run(accountId);
    return ops;
  });

  const erase = (accountId: string, mode: ErasureMode): number => {
    const ops = eraseRows(accountId, mode);
    removeFilesNow(db, dataDir);
    return ops;
  };

  return {
    deleteAccount: (accountId) => void erase(accountId, 'delete'),
    wipeAccount: (accountId) => erase(accountId, 'wipe'),
  };
}
