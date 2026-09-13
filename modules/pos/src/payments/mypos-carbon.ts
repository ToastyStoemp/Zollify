import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';
import { CarbonPayment, hasNativePlugin } from '../native/plugins';
import { logDiagnostic } from '../lib/diagnostics';

/** MyPOS Carbon/Smart on-device payment via intent (CarbonPaymentPlugin.kt). */
export const myposCarbonProvider: PaymentProvider = {
  id: 'mypos-carbon',
  label: 'MyPOS Carbon (on-device)',

  async isAvailable(): Promise<boolean> {
    return hasNativePlugin('CarbonPayment');
  },

  async getStatus(): Promise<ProviderStatus> {
    if (!hasNativePlugin('CarbonPayment')) return { connected: false, detail: 'MyPOS device only' };
    try {
      const { connected, detail } = await CarbonPayment.getStatus();
      let statusDetail = detail ?? (connected ? 'Terminal ready' : undefined);
      if (connected) {
        // Best-effort — the terminal's settlement currency, shown up front so a
        // mismatch (event in SEK, terminal set to EUR) is visible before the
        // seller ever taps Card, not after a confusing instant "declined".
        try {
          const { currencyName } = await CarbonPayment.getPosInfo();
          if (currencyName) statusDetail = `${statusDetail} · ${currencyName}`;
        } catch {
          /* not critical to the connected/disconnected status itself */
        }
      }
      return { connected, detail: statusDetail };
    } catch (err) {
      return { connected: false, detail: String(err) };
    }
  },

  async startPayment(req: PaymentRequest): Promise<PaymentResult> {
    // MyPOSAPI.openPaymentActivity silently refuses a currency that doesn't
    // match the terminal's own settlement currency — the activity finishes
    // instantly with no card screen shown, which we'd otherwise only see as a
    // generic "Payment cancelled". Check first and say so plainly.
    try {
      const posInfo = await CarbonPayment.getPosInfo();
      if (posInfo.currencyName && posInfo.currencyName.toUpperCase() !== req.currency.toUpperCase()) {
        const error = `Terminal is set to ${posInfo.currencyName}, this sale is ${req.currency}. Switch the event's currency or the terminal's settlement currency to match.`;
        logDiagnostic(`CarbonPayment currency mismatch: terminal=${posInfo.currencyName} requested=${req.currency}`);
        return { approved: false, provider: 'mypos-carbon', error };
      }
    } catch {
      // POS info unavailable — fall through and let the SDK's own validation handle it.
    }

    logDiagnostic(`CarbonPayment.startPayment amount=${req.amount} currency=${req.currency}`);
    const result = await CarbonPayment.startPayment({ amount: req.amount, currency: req.currency });
    logDiagnostic(
      `CarbonPayment.startPayment result approved=${!!result.approved}` +
        (result.error ? ` error=${result.error}` : ''),
    );
    return {
      approved: !!result.approved,
      provider: 'mypos-carbon',
      txRef: result.transactionId,
      cardBrand: result.cardBrand,
      authCode: result.authCode,
      error: result.error,
    };
  },

  async cancel(): Promise<void> {
    // Intent-based flow — cancellation happens on the terminal UI itself.
  },
};
