import Dexie from 'dexie';
import type { StoreSchema } from '@zollify/sdk';

/**
 * Per-module local storage.
 *
 * Each module gets its own IndexedDB database rather than sharing one with the
 * core. That solves the problem runtime modules otherwise create: IndexedDB
 * versions must increase monotonically, so a shared schema would need a
 * persisted global counter and an install/uninstall/reinstall cycle could never
 * reuse a version number. With one database per module the versioning is local,
 * an uninstall is a clean delete, and no module can read another's tables —
 * which is the isolation we want anyway.
 */

const DB_PREFIX = 'zollify';

/** `zollify_<accountId>_<moduleId>` — per account, so two logins on one device never mix. */
export function moduleDbName(accountId: string, moduleId: string): string {
  return `${DB_PREFIX}_${sanitise(accountId)}_${sanitise(moduleId)}`;
}

function sanitise(part: string): string {
  // IndexedDB names tolerate most characters, but keeping them boring makes the
  // databases readable in devtools and immune to separator collisions.
  return part.replace(/[^A-Za-z0-9_-]/g, '_');
}

const open = new Map<string, Dexie>();

export function openModuleDb(
  accountId: string,
  moduleId: string,
  schema: StoreSchema,
  version = 1,
): Dexie {
  const name = moduleDbName(accountId, moduleId);
  const existing = open.get(name);
  if (existing) return existing;

  const db = new Dexie(name);
  db.version(version).stores(schema);
  open.set(name, db);
  return db;
}

/** Closes a module's database without deleting it — used when unloading a module. */
export function closeModuleDb(accountId: string, moduleId: string): void {
  const name = moduleDbName(accountId, moduleId);
  const db = open.get(name);
  if (!db) return;
  db.close();
  open.delete(name);
}

/**
 * Deletes a module's local data outright. Called on uninstall, and the reason
 * per-module databases are worth the isolation: there is no shared schema to
 * migrate and nothing else can be caught by the delete.
 */
export async function deleteModuleDb(accountId: string, moduleId: string): Promise<void> {
  const name = moduleDbName(accountId, moduleId);
  closeModuleDb(accountId, moduleId);
  await Dexie.delete(name);
}

/** Every Zollify database currently on this device, for diagnostics and account switch cleanup. */
export async function listZollifyDbs(): Promise<string[]> {
  const names = await Dexie.getDatabaseNames();
  return names.filter((n) => n.startsWith(`${DB_PREFIX}_`));
}
