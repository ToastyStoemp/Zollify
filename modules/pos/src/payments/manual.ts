import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';

/**
 * No-terminal fallback: the seller confirms the card payment happened
 * elsewhere (or it's a cash-only setup). Always available; approves instantly.
 */
export const manualProvider: PaymentProvider = {
  id: 'manual',
  label: 'Manual (no terminal)',

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async getStatus(): Promise<ProviderStatus> {
    return { connected: true, detail: 'Confirm payments manually' };
  },

  async startPayment(req: PaymentRequest): Promise<PaymentResult> {
    void req;
    return { approved: true, provider: 'manual' };
  },

  async cancel(): Promise<void> {},
};
