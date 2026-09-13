import { openCoreDb } from './db';
import { getAccount } from '../session';

/**
 * This device's stable identity on the account.
 *
 * The sync protocol needs a device id to attribute ops and to let other devices
 * find this one (a Carbon terminal being targeted for a remote payment, for
 * instance). It is generated once and kept in core's settings table rather than
 * localStorage, so it survives alongside the data it describes.
 */

const DEVICE_ID_KEY = 'core.deviceId';
const DEVICE_NAME_KEY = 'core.deviceName';

let cachedId: string | null = null;

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Device identity was used while signed out.');
  return account.accountId;
}

export async function deviceId(): Promise<string> {
  if (cachedId) return cachedId;
  const db = openCoreDb(requireAccountId());
  const row = await db.settings.get(DEVICE_ID_KEY);
  const existing = row?.value as string | undefined;
  if (existing) {
    cachedId = existing;
    return existing;
  }
  const created = crypto.randomUUID();
  await db.settings.put({ key: DEVICE_ID_KEY, value: created });
  cachedId = created;
  return created;
}

export async function deviceName(): Promise<string | undefined> {
  const db = openCoreDb(requireAccountId());
  const row = await db.settings.get(DEVICE_NAME_KEY);
  return row?.value as string | undefined;
}

export async function setDeviceName(name: string): Promise<void> {
  const db = openCoreDb(requireAccountId());
  await db.settings.put({ key: DEVICE_NAME_KEY, value: name.trim() });
}

/**
 * How this device presents itself to the account. 'web' here; the Capacitor
 * shell will report 'full', and a Carbon terminal 'carbon', which is what lets
 * a remote payment find the right register.
 */
export function deviceFlavor(): string {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return cap?.isNativePlatform?.() === true ? 'full' : 'web';
}

export function resetDeviceCache(): void {
  cachedId = null;
}
