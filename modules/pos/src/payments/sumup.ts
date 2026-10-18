import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';
import { SumUp, hasNativePlugin } from '../native/plugins';
import { getSetting, setSetting } from '../lib/settings';
import { sdk } from '../runtime';

/** A key entered on this device, for a build with its own app id. Overrides the server's. */
export const SUMUP_KEY_SETTING = 'sumup.affiliateKey';
/** The server's key as last fetched, so signing in again works offline. */
const SERVER_KEY_CACHE = 'sumup.serverAffiliateKey';

/**
 * The affiliate key to sign in with: one entered on this device, else the
 * server's. It names the app, not the merchant, so the merchant never sees it.
 * Null when there is none anywhere.
 */
export async function sumupAffiliateKey(): Promise<string | null> {
  const own = (await getSetting<string>(SUMUP_KEY_SETTING))?.trim();
  if (own) return own;
  try {
    const { affiliateKey } = await sdk().http.get<{ affiliateKey: string | null }>('sumup/config');
    await setSetting(SERVER_KEY_CACHE, affiliateKey);
    return affiliateKey;
  } catch {
    return (await getSetting<string>(SERVER_KEY_CACHE)) ?? null;
  }
}

/** SumUp card readers (Solo, Air, …) via the native merchant SDK. */
export const sumupProvider: PaymentProvider = {
  id: 'sumup',
  label: 'SumUp card reader',

  async isAvailable(): Promise<boolean> {
    return hasNativePlugin('SumUp');
  },

  async getStatus(): Promise<ProviderStatus> {
    if (!hasNativePlugin('SumUp')) return { connected: false, detail: 'Android only' };
    try {
      const { loggedIn } = await SumUp.isLoggedIn();
      if (loggedIn) return { connected: true, detail: 'Logged in - reader connects at checkout' };
      return { connected: false, detail: 'Not signed in - tap Connect to sign in with your SumUp account' };
    } catch (err) {
      return { connected: false, detail: String(err) };
    }
  },

  async startPayment(req: PaymentRequest): Promise<PaymentResult> {
    const result = await SumUp.checkout({
      amount: req.amount,
      currency: req.currency,
      title: `Sale ${req.reference}`,
      foreignTxId: req.reference,
    });
    return {
      approved: result.approved,
      provider: 'sumup',
      txRef: result.txCode || undefined,
      error: result.approved ? undefined : result.message || `SumUp error ${result.resultCode}`,
    };
  },

  async cancel(): Promise<void> {
    // The SDK's checkout activity owns the flow; it is cancelled on the device.
  },

  /** Opens SumUp's own sign-in screen. */
  async configure(): Promise<void> {
    const affiliateKey = await sumupAffiliateKey();
    if (!affiliateKey) throw new Error('This server has no SumUp affiliate key - enter one under Settings → Card terminal');
    const res = await SumUp.login({ affiliateKey });
    if (!res.loggedIn) throw new Error(res.message || 'SumUp login was cancelled');
  },

  /** Opens SumUp's card-reader page to pair/connect a reader (needs login first). */
  async pairReader(): Promise<void> {
    await SumUp.openCardReaderPage();
  },

  /** Logs this device out of the SumUp account (disconnects it entirely). */
  async disconnect(): Promise<void> {
    await SumUp.logout();
  },

  /** True when SumUp isn't signed in yet - checkout should offer to log in. */
  async needsLogin(): Promise<boolean> {
    if (!hasNativePlugin('SumUp')) return false;
    try {
      return !(await SumUp.isLoggedIn()).loggedIn;
    } catch {
      return true;
    }
  },
};
