import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';

/**
 * The test terminal: behaves like a card terminal without one. It takes a
 * moment "reading the card", then approves - or declines when the amount
 * ends in .01, so the declined path can be tried too. Only ever used while
 * the till is in test mode (see cart.ts), where no sale is recorded either
 * way; it is not offered as a provider to pick.
 */
export const TEST_DELAY_MS = 1500;

let pending: { cancelled: boolean } | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const testTerminalProvider: PaymentProvider = {
  id: 'test',
  label: 'Test terminal',

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async getStatus(): Promise<ProviderStatus> {
    return { connected: true, detail: 'Test mode - approves after a moment, declines amounts ending in .01, records nothing' };
  },

  async startPayment(req: PaymentRequest): Promise<PaymentResult> {
    const run = { cancelled: false };
    pending = run;
    try {
      await wait(TEST_DELAY_MS);
      if (run.cancelled) return { approved: false, provider: 'test', error: 'Cancelled.' };
      if (Math.round(req.amount * 100) % 100 === 1) return { approved: false, provider: 'test', error: 'Declined (test terminal declines amounts ending in .01).' };
      return { approved: true, provider: 'test', txRef: `TEST-${Date.now().toString(36).toUpperCase()}`, cardBrand: 'test' };
    } finally {
      if (pending === run) pending = null;
    }
  },

  async cancel(): Promise<void> {
    if (pending) pending.cancelled = true;
  },
};
