import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';
import { GlassPayment, hasNativePlugin } from '../native/plugins';

/**
 * myPOS Glass softPOS: tap-to-pay on this phone's NFC via the installed Glass
 * app (GlassPaymentPlugin.kt, full flavor). ZollTool opens the Glass app with
 * the amount; the customer taps their card; the result returns to ZollTool.
 */
export const myposGlassProvider: PaymentProvider = {
  id: 'mypos-glass',
  label: 'MyPOS Glass (tap on this phone)',

  async isAvailable(): Promise<boolean> {
    return hasNativePlugin('GlassPayment');
  },

  async getStatus(): Promise<ProviderStatus> {
    if (!hasNativePlugin('GlassPayment')) return { connected: false, detail: 'Android phones only' };
    try {
      const { connected, detail } = await GlassPayment.getStatus();
      return { connected, detail };
    } catch (err) {
      return { connected: false, detail: String(err) };
    }
  },

  async startPayment(req: PaymentRequest): Promise<PaymentResult> {
    const result = await GlassPayment.startPayment({ amount: req.amount, currency: req.currency });
    return {
      approved: !!result.approved,
      provider: 'mypos-glass',
      txRef: result.transactionId,
      cardBrand: result.cardBrand,
      authCode: result.authCode,
      error: result.error,
    };
  },

  async cancel(): Promise<void> {
    // Intent-based flow - cancellation happens in the Glass app's own UI.
  },
};
