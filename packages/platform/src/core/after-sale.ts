import { reactive } from 'vue';
import { receiptLink } from '@zollify/shared';
import { openCoreDb } from './db';
import { getAccount, getApiBase } from '../session';

/**
 * What this screen shows once a sale is paid: a thank-you, a QR code to the
 * customer's online receipt, both or neither.
 *
 * Kept in core's device-local settings and never synced: a register facing
 * the seller and a customer display on the same account usually want
 * different answers, and each device decides only for itself.
 */

export interface AfterSalePrefs {
  thankYou: boolean;
  receiptQr: boolean;
}

const KEY = 'core.afterSale';
const DEFAULTS: AfterSalePrefs = { thankYou: true, receiptQr: true };

export const afterSalePrefs = reactive<AfterSalePrefs>({ ...DEFAULTS });

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('After-sale settings were used while signed out.');
  return account.accountId;
}

export async function loadAfterSalePrefs(): Promise<AfterSalePrefs> {
  const row = await openCoreDb(requireAccountId()).settings.get(KEY);
  const stored = (row?.value ?? {}) as Partial<AfterSalePrefs>;
  Object.assign(afterSalePrefs, DEFAULTS, {
    ...(typeof stored.thankYou === 'boolean' ? { thankYou: stored.thankYou } : {}),
    ...(typeof stored.receiptQr === 'boolean' ? { receiptQr: stored.receiptQr } : {}),
  });
  return { ...afterSalePrefs };
}

export async function setAfterSalePrefs(patch: Partial<AfterSalePrefs>): Promise<void> {
  Object.assign(afterSalePrefs, patch);
  await openCoreDb(requireAccountId()).settings.put({ key: KEY, value: { ...afterSalePrefs } });
}

/**
 * The customer-facing link for a receipt token. Built from the server this
 * app syncs with - on the web that is the page's own origin, in the Android
 * shell the configured server - since that server is what answers it.
 */
export function receiptUrlFor(token: string): string {
  const api = new URL(getApiBase() || '/api', typeof location !== 'undefined' ? location.href : 'http://localhost/');
  const root = `${api.origin}${api.pathname.replace(/\/api\/?$/, '')}`;
  return receiptLink(root, token);
}
