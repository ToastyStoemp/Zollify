import type { ReceiptSocials, ReceiptToggles } from '@zollify/shared';
import { sdk } from '../runtime';
import { getSetting } from './settings';

/**
 * Receipt branding shared through the server.
 *
 * The logo and footer are set per device under Receipts, which is where the
 * printer reads them. A copy goes to the server so the online receipt, the
 * customer display and a freshly set-up register show the same thing.
 *
 * The server copy only ever changes on purpose: when someone sets or clears
 * them in Receipts, or to fill a blank the server has from a device that
 * already had them. A device that simply never set a logo must not wipe the
 * one another device uploaded.
 */

export interface Branding {
  /** Base64 PNG, no data: prefix. */
  logo: string | null;
  footer: string | null;
}

const LOGO_KEY = 'receipt.logoScreenB64';
const FOOTER_KEY = 'receipt.footerText';

const canEdit = (): boolean => {
  const role = sdk().account()?.role;
  return role === 'owner' || role === 'admin';
};

let cached: Promise<Branding | null> | null = null;

/** The account's branding as the server has it; null when unreachable. Fetched once per session. */
export function serverBranding(): Promise<Branding | null> {
  cached ??= sdk()
    .http.get<Branding>('branding')
    .catch(() => {
      cached = null;
      return null;
    });
  return cached;
}

/** Send a deliberate change (Receipts settings). Fields left out stay as they are. */
export async function pushBranding(patch: Partial<Branding>): Promise<void> {
  if (!canEdit()) return;
  const next = await sdk().http.put<Branding>('branding', patch);
  cached = Promise.resolve(next);
}

/** Fill blanks on the server from what this device already has. Never overwrites. */
export async function backfillBranding(): Promise<void> {
  if (!canEdit()) return;
  const server = await serverBranding();
  if (!server) return;
  const [logo, footer] = await Promise.all([getSetting<string>(LOGO_KEY), getSetting<string>(FOOTER_KEY)]);
  const patch: Partial<Branding> = {};
  if (!server.logo && logo) patch.logo = logo;
  if (!server.footer && footer?.trim()) patch.footer = footer;
  if (Object.keys(patch).length) await pushBranding(patch).catch(() => {});
}

/** The logo for on-screen use: this device's own, else the account's. As a data: URL. */
export async function screenLogo(): Promise<string | undefined> {
  const local = await getSetting<string>(LOGO_KEY);
  const b64 = local || (await serverBranding())?.logo;
  return b64 ? `data:image/png;base64,${b64}` : undefined;
}

/** The links (from the business profile) with the receipt's switches, as the server has them; null when unreachable. Gives up quickly so a print is never held up. */
export async function serverSocials(): Promise<ReceiptSocials | null> {
  const timeout = new Promise<null>((ok) => setTimeout(() => ok(null), 2500));
  return Promise.race([sdk().http.get<ReceiptSocials>('receipt-links').catch(() => null), timeout]);
}

/** Save the receipt's own switches (owners and admins). The links themselves are edited in the business profile. */
export async function pushReceiptToggles(next: ReceiptToggles): Promise<ReceiptSocials> {
  return sdk().http.put<ReceiptSocials>('receipt-links', next);
}
