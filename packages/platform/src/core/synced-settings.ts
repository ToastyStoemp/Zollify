import { openCoreDb } from './db';
import { getAccount } from '../session';
import { transactWithOutbox } from './outbox';
import { toPlain } from './plain';

/**
 * Generic account-wide key/value, synced via the same 'setting.upsert' op
 * sales-events.ts uses for the default active event (see DEFAULT_ACTIVE_KEY
 * there). Exposed to modules as sdk.data.settings - see createModuleHost in
 * sdk-host.ts.
 *
 * The settings table also holds rows that belong to this device alone: its
 * id and name, the sync cursor, the receipt counter, test-mode state. Those
 * must never travel - a device that took another's receipt counter or cursor
 * off the wire would number receipts twice or stop pulling. So a key is
 * checked both when it is set here and when it arrives in a pull.
 */

/** The only `core.` keys that sync; every other `core.` row is this device's own. */
const SYNCED_CORE_KEYS = new Set([
  // The account's default active event (DEFAULT_ACTIVE_KEY in sales-events.ts).
  'core.defaultActiveEventId',
  // Where the booth configurator lives (CONFIGURATOR_KEY in booth-layout.ts).
  'core.cubeConfiguratorUrl',
]);

/** Namespaces core keeps for itself: `core.` syncs by the list above, `sync.` is bookkeeping and never does. */
const CORE_PREFIX = 'core.';
const SYNC_STATE_PREFIX = 'sync.';

/**
 * Whether a settings key is one that travels between devices. Modules name
 * their own keys, so anything outside core's namespaces syncs; inside them
 * only the listed keys do, so a new device-local `core.` row is safe by
 * default.
 */
export function isSyncedSettingKey(key: unknown): key is string {
  if (typeof key !== 'string' || !key) return false;
  if (key.startsWith(SYNC_STATE_PREFIX)) return false;
  if (key.startsWith(CORE_PREFIX)) return SYNCED_CORE_KEYS.has(key);
  return true;
}

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Synced settings were used while signed out.');
  return account.accountId;
}

export async function getSyncedSetting<T>(key: string): Promise<T | undefined> {
  const db = openCoreDb(requireAccountId());
  const row = await db.settings.get(key);
  return row?.value as T | undefined;
}

export async function setSyncedSetting(key: string, value: unknown): Promise<void> {
  if (!isSyncedSettingKey(key)) throw new Error(`"${key}" is a device-local setting and cannot be synced.`);
  const db = openCoreDb(requireAccountId());
  const updatedAt = Date.now();
  // A module's caller almost always hands over a live Vue reactive
  // object/array (a ref's .value) - the structured clone algorithm IndexedDB
  // uses cannot clone a Proxy, so this throws DataCloneError without it.
  const plain = toPlain(value);
  await transactWithOutbox(db, [db.settings], async (enqueue) => {
    await db.settings.put({ key, value: plain, updatedAt });
    await enqueue({ type: 'setting.upsert', payload: { key, value: plain, updatedAt } });
  });
}

/**
 * Every setting whose key starts with `prefix`, keyed by the full key. Lets a
 * module keep one key per row - so two devices editing different rows never
 * overwrite each other - and still read the lot back in one go.
 */
export async function listSyncedSettings<T>(prefix: string): Promise<Record<string, T>> {
  if (!prefix) throw new Error('Listing settings needs a key prefix.');
  const db = openCoreDb(requireAccountId());
  const rows = await db.settings.where('key').startsWith(prefix).toArray();
  const out: Record<string, T> = {};
  for (const row of rows) out[row.key] = row.value as T;
  return out;
}
