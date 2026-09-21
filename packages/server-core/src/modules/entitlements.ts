import type Database from 'better-sqlite3';

/**
 * Which modules an account has switched on.
 *
 * Today this is a plain per-account list the owner edits. When billing arrives
 * it writes this same table and nothing else in the system changes - that is
 * the seam the architecture was built around.
 */

export interface AccountModule {
  moduleId: string;
  enabled: boolean;
  updatedAt: number;
}

export function migrateEntitlements(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_modules (
      accountId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      moduleId  TEXT NOT NULL,
      enabled   INTEGER NOT NULL DEFAULT 1,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, moduleId)
    );
    CREATE INDEX IF NOT EXISTS idx_account_modules_account ON account_modules(accountId);
  `);

  // The customs module split into customs-ch/customs-de; accounts that
  // switched on the old "customs" id need it renamed so it keeps running.
  // Safe to run every boot: a no-op once no "customs" rows are left.
  db.exec(`
    UPDATE account_modules SET moduleId = 'customs-ch'
    WHERE moduleId = 'customs'
      AND NOT EXISTS (
        SELECT 1 FROM account_modules a2
        WHERE a2.accountId = account_modules.accountId AND a2.moduleId = 'customs-ch'
      );
    DELETE FROM account_modules WHERE moduleId = 'customs';
  `);
}

export function listForAccount(db: Database.Database, accountId: string): AccountModule[] {
  const rows = db
    .prepare('SELECT moduleId, enabled, updatedAt FROM account_modules WHERE accountId = ?')
    .all(accountId) as { moduleId: string; enabled: number; updatedAt: number }[];
  return rows.map((r) => ({ moduleId: r.moduleId, enabled: r.enabled === 1, updatedAt: r.updatedAt }));
}

export function enabledIds(db: Database.Database, accountId: string): Set<string> {
  return new Set(
    listForAccount(db, accountId)
      .filter((m) => m.enabled)
      .map((m) => m.moduleId),
  );
}

export function isEnabled(db: Database.Database, accountId: string, moduleId: string): boolean {
  const row = db
    .prepare('SELECT enabled FROM account_modules WHERE accountId = ? AND moduleId = ?')
    .get(accountId, moduleId) as { enabled: number } | undefined;
  return row?.enabled === 1;
}

export function setEnabled(
  db: Database.Database,
  accountId: string,
  moduleId: string,
  enabled: boolean,
): void {
  db.prepare(
    `INSERT INTO account_modules (accountId, moduleId, enabled, updatedAt)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(accountId, moduleId) DO UPDATE SET enabled = excluded.enabled, updatedAt = excluded.updatedAt`,
  ).run(accountId, moduleId, enabled ? 1 : 0, Date.now());
}

/**
 * Turns on the modules a brand-new account should start with. Called once at
 * registration so a fresh account isn't an empty shell with no way in.
 */
export function seedDefaults(db: Database.Database, accountId: string, defaults: string[]): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO account_modules (accountId, moduleId, enabled, updatedAt) VALUES (?, ?, 1, ?)`,
  );
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const moduleId of defaults) stmt.run(accountId, moduleId, now);
  });
  tx();
}
