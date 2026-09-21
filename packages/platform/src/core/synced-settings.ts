import { openCoreDb } from './db';
import { getAccount } from '../session';
import { queueOp } from './outbox';
import { toPlain } from './plain';

/**
 * Generic account-wide key/value, synced via the same 'setting.upsert' op
 * sales-events.ts uses for the default active event (see DEFAULT_ACTIVE_KEY
 * there). Exposed to modules as sdk.data.settings - see createModuleHost in
 * sdk-host.ts for the per-module key scoping.
 */

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
  const db = openCoreDb(requireAccountId());
  const updatedAt = Date.now();
  // A module's caller almost always hands over a live Vue reactive
  // object/array (a ref's .value) - the structured clone algorithm IndexedDB
  // uses cannot clone a Proxy, so this throws DataCloneError without it.
  const plain = toPlain(value);
  await db.settings.put({ key, value: plain, updatedAt });
  await queueOp({ type: 'setting.upsert', payload: { key, value: plain, updatedAt } });
}
