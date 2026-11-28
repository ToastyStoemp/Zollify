import type { ReceiptSocials, ReceiptToggles } from '@zollify/shared';
import { sdk } from '../runtime';
import { cachedRead, freshRead, resetCachedReads, writeCached, type CacheStore } from './cached-read';
import { getSetting, setSetting } from './settings';

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
/** The account's logo and footer as the server last gave them, kept on the device so a receipt never waits for the network. */
const BRANDING_COPY_KEY = 'cache.branding';
/** The receipt's links and switches, kept the same way. */
const SOCIALS_COPY_KEY = 'cache.receiptLinks';
/** Where the account's logo alone was kept before the whole branding was; still read until the first refresh replaces it. */
const LEGACY_LOGO_COPY_KEY = 'receipt.serverLogoCache';
/** A copy this recent is not asked for again - branding changes rarely, and a booth's connection is better spent on syncing sales. */
const FRESH_FOR_MS = 10 * 60_000;
/** How long the first fetch may hold the screen up when nothing is kept yet. */
const FIRST_FETCH_MS = 1500;
/** How long Receipts settings waits for the server's switches before showing the defaults. */
const SETTINGS_WAIT_MS = 2500;

const canEdit = (): boolean => {
  const role = sdk().account()?.role;
  return role === 'owner' || role === 'admin';
};

/** The module's own device-local config: never synced, removed with the module. */
const store: CacheStore = { get: getSetting, set: setSetting };

const fetchBranding = (signal: AbortSignal): Promise<Branding> => sdk().http.get<Branding>('branding', { signal });
const fetchSocials = (signal: AbortSignal): Promise<ReceiptSocials> => sdk().http.get<ReceiptSocials>('receipt-links', { signal });

/** The logo a previous version kept, for a device that has not reached the server since updating. */
async function legacyBranding(): Promise<Branding | null> {
  const logo = await getSetting<string>(LEGACY_LOGO_COPY_KEY).catch(() => undefined);
  return logo ? { logo, footer: null } : null;
}

/**
 * The account's logo and footer for showing and printing: the copy kept on
 * the device, at once, refreshed in the background when it has aged. Only a
 * device with no copy yet waits - at most `waitMs` - for the server; null
 * when it has nothing and the server does not answer.
 */
export async function accountBranding(waitMs = FIRST_FETCH_MS): Promise<Branding | null> {
  const legacy = await legacyBranding();
  // With the older copy to show there is nothing to wait for; the refresh still runs.
  const kept = await cachedRead(BRANDING_COPY_KEY, fetchBranding, { store, maxAgeMs: FRESH_FOR_MS, firstWaitMs: legacy ? 0 : waitMs });
  return kept ?? legacy;
}

/**
 * The account's branding as the server has it now; null when unreachable.
 * For deciding what to send back (backfillBranding) - showing and printing
 * use accountBranding, which never waits once a copy is kept.
 */
export async function serverBranding(): Promise<Branding | null> {
  return (await freshRead(BRANDING_COPY_KEY, fetchBranding, { store, maxAgeMs: FRESH_FOR_MS })) ?? null;
}

/**
 * Bring the kept branding and links up to date when they have aged. Called
 * when the module starts and after every sync - the moments the device is
 * known to be online - so a logo changed on another device arrives by itself.
 */
export async function refreshReceiptCopies(): Promise<void> {
  await Promise.all([accountBranding(0), receiptSocials(0)]).catch(() => undefined);
}

/** For tests: forget refreshes under way and past failures. */
export function resetBrandingCache(): void {
  resetCachedReads();
}

/** Send a deliberate change (Receipts settings). Fields left out stay as they are. */
export async function pushBranding(patch: Partial<Branding>): Promise<void> {
  if (!canEdit()) return;
  const next = await sdk().http.put<Branding>('branding', patch);
  await writeCached(BRANDING_COPY_KEY, next, store);
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

/** The account's logo (base64 PNG) from the copy kept on the device; see accountBranding for when it waits. */
export async function accountLogo(waitMs = FIRST_FETCH_MS): Promise<string | undefined> {
  return (await accountBranding(waitMs))?.logo ?? undefined;
}

/** The logo for on-screen use: this device's own, else the account's. As a data: URL. */
export async function screenLogo(): Promise<string | undefined> {
  const own = await getSetting<string>(LOGO_KEY);
  if (own) return `data:image/png;base64,${own}`;
  const b64 = await accountLogo();
  return b64 ? `data:image/png;base64,${b64}` : undefined;
}

/**
 * The receipt's links and switches for printing: the copy kept on the device,
 * at once. Only a device with no copy yet waits - at most `waitMs` - so a
 * print is never held up; null when it has nothing and the server does not answer.
 */
export async function receiptSocials(waitMs = FIRST_FETCH_MS): Promise<ReceiptSocials | null> {
  return (await cachedRead(SOCIALS_COPY_KEY, fetchSocials, { store, maxAgeMs: FRESH_FOR_MS, firstWaitMs: waitMs })) ?? null;
}

/** The links and switches as the server has them now, for editing them in Receipts settings; null when it does not answer quickly. */
export async function serverSocials(): Promise<ReceiptSocials | null> {
  const timeout = new Promise<null>((ok) => setTimeout(() => ok(null), SETTINGS_WAIT_MS));
  return Promise.race([freshRead(SOCIALS_COPY_KEY, fetchSocials, { store }).then((s) => s ?? null), timeout]);
}

/** Save the receipt's own switches (owners and admins). The links themselves are edited in the business profile. */
export async function pushReceiptToggles(next: ReceiptToggles): Promise<ReceiptSocials> {
  const saved = await sdk().http.put<ReceiptSocials>('receipt-links', next);
  await writeCached(SOCIALS_COPY_KEY, saved, store);
  return saved;
}
