import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';
import { MyPos, hasNativePlugin } from '../native/plugins';

/** MyPOS Go2 over Bluetooth via the native MyPosPlugin.kt (com.mypos:slavesdk). */
export const myposGo2Provider: PaymentProvider = {
  id: 'mypos-go2',
  label: 'MyPOS Go2 (Bluetooth)',

  async isAvailable(): Promise<boolean> {
    return hasNativePlugin('MyPos');
  },

  async getStatus(): Promise<ProviderStatus> {
    if (!hasNativePlugin('MyPos')) return { connected: false, detail: 'Android only' };
    try {
      const { connected } = await MyPos.getStatus();
      return { connected, detail: connected ? 'Terminal ready' : 'Terminal not paired' };
    } catch (err) {
      return { connected: false, detail: String(err) };
    }
  },

  async startPayment(req: PaymentRequest): Promise<PaymentResult> {
    const result = await MyPos.startPayment({ amount: req.amount, currency: req.currency });
    return {
      approved: !!result.approved,
      provider: 'mypos-go2',
      txRef: result.transactionId,
      cardBrand: result.cardBrand,
      authCode: result.authCode,
      error: result.error,
    };
  },

  async cancel(): Promise<void> {
    // Aborts the terminal transaction (SDK cancelTransaction) and resets the
    // native pending-payment latch so the next payment can start.
    await MyPos.cancelPayment();
  },

  async configure(): Promise<void> {
    const { granted } = await MyPos.connectTerminal();
    if (!granted) {
      throw new Error('Bluetooth permission denied — allow Bluetooth (and Location) for ZollTool in Android settings');
    }
  },
};
