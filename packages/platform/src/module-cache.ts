import Dexie, { type EntityTable } from 'dexie';

/**
 * The offline store for runtime module bundles.
 *
 * Entries are keyed by `<moduleId>@<version>` and are immutable: an update
 * writes a new row rather than overwriting the running one. That is what keeps
 * a half-finished download from bricking a register mid-convention - the old
 * version stays intact and bootable until the new one is fully written and
 * verified.
 */

export interface CachedBundle {
  /** `<moduleId>@<version>` - immutable per version. */
  key: string;
  moduleId: string;
  version: string;
  /** The ESM source text of the bundle. */
  code: string;
  /** Lowercase hex SHA-256 of `code`, as published by the registry. */
  integrity: string;
  cachedAt: number;
}

const db = new Dexie('zollify_module_cache') as Dexie & {
  bundles: EntityTable<CachedBundle, 'key'>;
};
db.version(1).stores({ bundles: 'key, moduleId' });

export function bundleKey(moduleId: string, version: string): string {
  return `${moduleId}@${version}`;
}

/** Lowercase hex SHA-256, via WebCrypto - available in every target browser and the Capacitor WebView. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getCached(moduleId: string, version: string): Promise<CachedBundle | undefined> {
  return db.bundles.get(bundleKey(moduleId, version));
}

/**
 * Verifies the published hash before storing. A bundle that doesn't match what
 * the registry claims is never written and never executed - this is the one
 * integrity check standing between the registry and code running in the user's
 * session, so it fails loudly rather than falling back.
 */
export async function putCached(entry: Omit<CachedBundle, 'key' | 'cachedAt'>): Promise<CachedBundle> {
  const actual = await sha256Hex(entry.code);
  if (actual !== entry.integrity.toLowerCase()) {
    throw new Error(
      `Integrity check failed for ${entry.moduleId}@${entry.version}: ` +
        `registry published ${entry.integrity}, downloaded content hashes to ${actual}.`,
    );
  }
  const row: CachedBundle = {
    ...entry,
    key: bundleKey(entry.moduleId, entry.version),
    cachedAt: Date.now(),
  };
  await db.bundles.put(row);
  return row;
}

/**
 * Re-verifies a cached bundle before it is executed. The hash stored beside
 * the code only shows the two still agree - whoever can rewrite one can
 * rewrite the other - so when the manifest names a hash (`expected`), the code
 * must match that as well. It also catches a bundle republished under the
 * same version: the cached copy is then no longer the one the server means.
 */
export async function verifyCached(entry: CachedBundle, expected?: string): Promise<boolean> {
  const actual = await sha256Hex(entry.code);
  if (actual !== entry.integrity.toLowerCase()) return false;
  return !expected || actual === expected.toLowerCase();
}

/** Drops every cached version of a module - used on uninstall. */
export async function evictModule(moduleId: string): Promise<void> {
  await db.bundles.where('moduleId').equals(moduleId).delete();
}

/**
 * Removes superseded versions of a module, keeping the one named. Called after
 * a successful boot, never during one: pruning while a version is running is
 * how you lose the ability to roll back.
 */
export async function pruneOldVersions(moduleId: string, keepVersion: string): Promise<number> {
  const keep = bundleKey(moduleId, keepVersion);
  const stale = await db.bundles.where('moduleId').equals(moduleId).toArray();
  const doomed = stale.filter((b) => b.key !== keep).map((b) => b.key);
  if (doomed.length) await db.bundles.bulkDelete(doomed);
  return doomed.length;
}

export async function listCached(): Promise<CachedBundle[]> {
  return db.bundles.toArray();
}
