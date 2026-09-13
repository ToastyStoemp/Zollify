import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';
import { SumUp, hasNativePlugin } from '../native/plugins';
import { getSetting } from '../lib/settings';

export const SUMUP_KEY_SETTING = 'sumup.affiliateKey';

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
      if (loggedIn) return { connected: true, detail: 'Logged in — reader connects at checkout' };
      const hasKey = !!(await getSetting<string>(SUMUP_KEY_SETTING));
      return {
        connected: false,
        detail: hasKey ? 'Not logged in — tap Connect' : 'Enter your affiliate key below, then Connect',
      };
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

  /** Opens the SumUp login screen (needs the affiliate key from Settings). */
  async configure(): Promise<void> {
    const affiliateKey = await getSetting<string>(SUMUP_KEY_SETTING);
    if (!affiliateKey) throw new Error('Enter your SumUp affiliate key first');
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

  /** True when SumUp isn't signed in yet — checkout should offer to log in. */
  async needsLogin(): Promise<boolean> {
    if (!hasNativePlugin('SumUp')) return false;
    try {
      return !(await SumUp.isLoggedIn()).loggedIn;
    } catch {
      return true;
    }
  },
};
