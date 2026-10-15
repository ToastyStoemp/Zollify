import { ref } from 'vue';
import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';
import { toMinor } from './nexi-smartpos';
import { sdk } from '../runtime';

/**
 * MobilePay by QR code: the server creates the payment, the till draws the
 * QR on its screen (and on the customer display), the customer scans it with
 * their phone and pays in the MobilePay app, and the till asks the server for
 * the outcome until it has one. No terminal, nothing pairs - any device with
 * a screen. The account enters its MobilePay API keys once under Settings →
 * Payments; this provider is then offered on every till.
 *
 * Works as the till's card terminal (every Card tap shows a QR) or, next to a
 * real terminal, as the MobilePay button the till adds by itself.
 */

/** The method name a MobilePay sale is recorded under when a card terminal is the till's terminal. */
export const MOBILEPAY_METHOD = 'MobilePay';

export interface MobilepayStatus {
  connected: boolean;
  env: 'test' | 'production' | null;
  msn: string | null;
  canManage: boolean;
}
export interface MobilepayKeysInput {
  env: 'test' | 'production';
  msn: string;
  clientId: string;
  clientSecret: string;
  subscriptionKey: string;
}

/** Settings asks every provider for its status every few seconds; one answer serves all the asks of a moment. */
let statusCache: { at: number; value: Promise<MobilepayStatus> } | null = null;
const STATUS_TTL_MS = 3000;
export const loadMobilepayStatus = (): Promise<MobilepayStatus> => {
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const value = sdk().http.get<MobilepayStatus>('mobilepay/status');
  statusCache = { at: Date.now(), value };
  value.catch(() => (statusCache = null));
  return value;
};
const settled = (p: Promise<MobilepayStatus>): Promise<MobilepayStatus> => {
  statusCache = null;
  return p;
};
export const saveMobilepayKeys = (keys: MobilepayKeysInput): Promise<MobilepayStatus> => settled(sdk().http.put<MobilepayStatus>('mobilepay/keys', keys));
export const clearMobilepayKeys = (): Promise<MobilepayStatus> => settled(sdk().http.del<MobilepayStatus>('mobilepay/keys'));

/** The link the customer's phone must scan right now, for the till and the customer display to draw; null between payments. */
export const mobilepayQr = ref<string | null>(null);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorText = (err: unknown, fallback: string): string =>
  (err as { body?: { message?: string } } | null)?.body?.message ?? (err instanceof Error && err.message ? err.message : fallback);

type Outcome = { state: 'sent' | 'authorized' | 'approved' | 'declined' | 'cancelled'; transactionId?: string; message?: string };
/** What Vipps MobilePay asks of pollers: every two seconds. */
const POLL_MS = 2000;
/** Longest a customer gets with the code on screen; MobilePay's own payment request lasts ten minutes. */
const GIVE_UP_MS = 300_000;
let current: { ref: string | null; stopped: boolean } | null = null;

export const mobilepayProvider: PaymentProvider = {
  id: 'mobilepay',
  label: 'MobilePay (QR code on screen)',

  /** Offered wherever a server answers - any device, browser included. */
  async isAvailable(): Promise<boolean> {
    try {
      await loadMobilepayStatus();
      return true;
    } catch {
      return false;
    }
  },

  async getStatus(): Promise<ProviderStatus> {
    try {
      const s = await loadMobilepayStatus();
      if (!s.connected) return { connected: false, detail: 'Enter your MobilePay API keys below' };
      return { connected: true, detail: `${s.env === 'test' ? 'Test environment · ' : ''}sales unit ${s.msn}` };
    } catch (err) {
      return { connected: false, detail: errorText(err, 'Server not reachable') };
    }
  },

  async startPayment(req: PaymentRequest): Promise<PaymentResult> {
    const run = { ref: null as string | null, stopped: false };
    current = run;
    try {
      const { referenceId, qr } = await sdk().http.post<{ referenceId: string; qr: string }>('mobilepay/payments', {
        amount: toMinor(req.amount, req.currency),
        currency: req.currency.toUpperCase(),
        reference: req.reference,
      });
      run.ref = referenceId;
      mobilepayQr.value = qr;
      const started = Date.now();
      for (;;) {
        await wait(POLL_MS);
        const o = await sdk().http.get<Outcome>(`mobilepay/payments/${encodeURIComponent(referenceId)}`).catch(() => null);
        if (o?.state === 'approved') return { approved: true, provider: 'mobilepay', ...(o.transactionId ? { txRef: o.transactionId } : {}) };
        if (o?.state === 'declined') return { approved: false, provider: 'mobilepay', error: o.message || 'MobilePay did not complete the payment.' };
        if (o?.state === 'cancelled') return { approved: false, provider: 'mobilepay', error: run.stopped ? 'Cancelled.' : 'The customer did not pay - the request was cancelled or ran out.' };
        const waited = Date.now() - started;
        if (run.stopped && waited > 10_000) return { approved: false, provider: 'mobilepay', error: 'Cancelled.' };
        if (waited > GIVE_UP_MS) {
          void sdk().http.post(`mobilepay/payments/${encodeURIComponent(referenceId)}/cancel`).catch(() => undefined);
          // Never assume either way: the customer may still have paid.
          return { approved: false, provider: 'mobilepay', error: 'No payment came in. Check the MobilePay app or portal before charging again - it may have gone through.' };
        }
      }
    } catch (err) {
      return { approved: false, provider: 'mobilepay', error: errorText(err, 'Could not start the MobilePay payment.') };
    } finally {
      if (current === run) current = null;
      mobilepayQr.value = null;
    }
  },

  /** Drops the request; MobilePay only can while the customer has not paid. */
  async cancel(): Promise<void> {
    const run = current;
    if (!run) return;
    run.stopped = true;
    if (run.ref) await sdk().http.post(`mobilepay/payments/${encodeURIComponent(run.ref)}/cancel`).catch(() => undefined);
  },

  async disconnect(): Promise<void> {
    await clearMobilepayKeys();
  },
};
