import type Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { actionFor, type DataAction, type ErasureMode, type Retain } from './account-data';

/**
 * The files the server keeps per account, and removing them safely.
 *
 * A database transaction cannot reach the disk, so an erasure is done in two
 * steps: inside the transaction the paths are written to `file_removals`,
 * and once it has committed the files are removed and the queue emptied. A
 * crash in between leaves the rows gone and the paths still queued - the next
 * start finishes the job. Only paths a committed erasure queued are ever
 * removed; nothing is swept by guessing.
 */

export interface AccountFiles {
  what: string;
  /** The account's files or directories, relative to the data directory. Read before its rows are erased. */
  paths(db: Database.Database, accountId: string): string[];
  onDelete: DataAction;
  onWipe: DataAction;
}

const LOGS_STAY_ON_WIPE: Retain = {
  retain: { reason: 'A wipe leaves the logs table alone (diagnostics are not booth data), so its files stay with their rows', period: 'until the account is deleted; newest 30 per account' },
};

function logFiles(db: Database.Database, accountId: string): string[] {
  const rows = db.prepare('SELECT id FROM logs WHERE accountId = ?').all(accountId) as { id: string }[];
  return rows.map((r) => `logs/${r.id}.log`);
}

/** Every place under the data directory that holds an account's files. */
export const CORE_ACCOUNT_FILES: AccountFiles[] = [
  { what: 'Files attached to events', paths: (_db, accountId) => [`event-files/${accountId}`], onDelete: 'erase', onWipe: 'erase' },
  { what: 'Full-size product images (written by older versions)', paths: (_db, accountId) => [`images/${accountId}`], onDelete: 'erase', onWipe: 'erase' },
  { what: 'Diagnostic logs a device uploaded', paths: logFiles, onDelete: 'erase', onWipe: LOGS_STAY_ON_WIPE },
];

/** Notes, inside the erasing transaction, which of the account's files must go once it commits. */
export function queueFileRemovals(db: Database.Database, files: AccountFiles[], accountId: string, mode: ErasureMode): void {
  const queue = db.prepare('INSERT OR IGNORE INTO file_removals (path, queuedAt) VALUES (?, ?)');
  for (const f of files) {
    if (actionFor(f, mode) !== 'erase') continue;
    for (const path of f.paths(db, accountId)) queue.run(path, Date.now());
  }
}

/** The absolute path of a queued removal, or null when it would leave the data directory. */
function insideDataDir(dataDir: string, relative: string): string | null {
  const root = resolve(dataDir);
  const target = resolve(root, relative);
  return target.startsWith(root + sep) ? target : null;
}

/**
 * Removes every queued file and directory and clears it from the queue.
 * Run after an erasure commits and at every start. A path that cannot be
 * removed right now stays queued for the next run. Returns how many went.
 */
export function removeQueuedFiles(db: Database.Database, dataDir: string): number {
  const queued = db.prepare('SELECT path FROM file_removals').all() as { path: string }[];
  const done = db.prepare('DELETE FROM file_removals WHERE path = ?');
  let removed = 0;
  for (const { path } of queued) {
    const target = insideDataDir(dataDir, path);
    try {
      if (target) rmSync(target, { recursive: true, force: true });
      done.run(path);
      removed++;
    } catch {
      /* still queued: tried again after the next erasure or at the next start */
    }
  }
  return removed;
}
