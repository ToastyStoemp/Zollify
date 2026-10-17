import { reactive } from 'vue';
import { SELL_LOCK_DEFAULTS, cleanSellLockSettings, sellLockOf, type SalesEvent, type SellLock, type SellLockSettings } from '@zollify/shared';
import { getAccount } from '../session';
import { getSyncedSetting, setSyncedSetting } from './synced-settings';
import { allSalesEvents, getSalesEvent, upsertSalesEvent } from './sales-events';
import { allClaims } from './inventory';

/**
 * Sell 🔒 (shared sell-lock.ts): an event whose leftovers an open event took
 * over stops selling at the till. Forcing it open again is for owners and
 * admins, and only when the account allows it (Events → Sell lock).
 */

const KEY = 'stock.sellLock';

export const sellLockSettings = reactive<SellLockSettings>({ ...SELL_LOCK_DEFAULTS });

export async function loadSellLockSettings(): Promise<SellLockSettings> {
  Object.assign(sellLockSettings, cleanSellLockSettings(await getSyncedSetting(KEY)));
  return { ...sellLockSettings };
}

export async function setSellLockSettings(next: Partial<SellLockSettings>): Promise<void> {
  Object.assign(sellLockSettings, next);
  await setSyncedSetting(KEY, { ...sellLockSettings });
}

/** The lock on an event, or null when it may sell. Reactive. */
export function sellLockFor(eventId: string): SellLock<SalesEvent> | null {
  return sellLockOf(eventId, allSalesEvents(), allClaims(), sellLockSettings);
}

/** Whether the till must refuse a sale at this event. */
export function sellLocked(eventId: string): boolean {
  const lock = sellLockFor(eventId);
  return !!lock && !lock.forced;
}

/** Whether the signed-in user may force sales at a locked event. */
export function canForceSell(): boolean {
  const role = getAccount()?.role;
  return sellLockSettings.allowForce && (role === 'owner' || role === 'admin');
}

/** Force a locked event open for sales, or lock it again. */
export async function forceSell(eventId: string, on: boolean): Promise<void> {
  if (on && !canForceSell()) throw new Error('Forcing sales at a locked event is not allowed on this account.');
  const e = getSalesEvent(eventId);
  if (!e) throw new Error('No such event.');
  const { sellLockForced: _drop, ...rest } = e;
  await upsertSalesEvent(on ? { ...rest, sellLockForced: true } : rest);
}
