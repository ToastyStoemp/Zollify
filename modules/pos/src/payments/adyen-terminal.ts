import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';
import { getSetting, setSetting } from '../lib/settings';
import { sdk } from '../runtime';

/**
 * Adyen terminals (a Verifone V400m, P400, S1 and the rest of Adyen's
 * fleet), driven from the till over the cloud: the server sends the amount
 * to the terminal through Adyen's Terminal API, the customer pays on the
 * terminal, and the till asks the server for the outcome until it has it.
 * Works from any device - nothing pairs locally. The account adds its Adyen
 * API key once under Settings → Payments, and each till picks its terminal.
 */

export const ADYEN_TERMINAL_SETTING = 'adyen.terminal';
export interface AdyenTerminal {
  /** Adyen's terminal id: model-serial, as on the back of the device (V400m-347395464). */
  poiId: string;
  name: string;
}

export interface AdyenStatus {
  configured: boolean;
  canManage: boolean;
  canList: boolean;
  app: { merchantAccount: string; environment: 'test' | 'live'; keyHint: string } | null;
}
export const loadAdyenStatus = (): Promise<AdyenStatus> => sdk().http.get<AdyenStatus>('adyen/status');
export const saveAdyenApp = (app: { apiKey: string; merchantAccount: string; environment: 'test' | 'live' }) => sdk().http.put<{ canList: boolean }>('adyen/app', app);
export const removeAdyenApp = () => sdk().http.del('adyen/app');
export const loadAdyenTerminals = async (): Promise<{ id: string; model: string; serial: string; name: string }[]> => (await sdk().http.get<{ terminals: { id: string; model: string; serial: string; name: string }[] }>('adyen/terminals')).terminals;

type Outcome = { state: 'sent' | 'approved' | 'declined' | 'cancelled'; transactionId?: string; pspReference?: string; cardBrand?: string; last4?: string; authCode?: string; message?: string };

const POLL_MS = 1500;
/** Longest a customer gets at the terminal; the server gives up on the sync call about then too. */
const GIVE_UP_MS = 200_000;

const errorText = (err: unknown, fallback: string): string =>
  (err as { body?: { message?: string } } | null)?.body?.message ?? (err instanceof Error && err.message ? err.message : fallback);

let current: { ref: string | null; stopped: boolean } | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const adyenTerminalProvider: PaymentProvider = {
  id: 'adyen-terminal',
  label: 'Adyen terminal (Verifone V400m, P400, S1…)',

  async isAvailable(): Promise<boolean> {
    try {
      await loadAdyenStatus();
      return true;
    } catch {
      return false;
    }
  },

  async getStatus(): Promise<ProviderStatus> {
    try {
      const s = await loadAdyenStatus();
      if (!s.configured) return { connected: false, detail: 'Add your Adyen API key below' };
      const t = await getSetting<AdyenTerminal>(ADYEN_TERMINAL_SETTING);
      return t ? { connected: true, detail: `Terminal: ${t.name}${s.app?.environment === 'test' ? ' (test)' : ''}` } : { connected: false, detail: 'Pick this till’s terminal below' };
    } catch (err) {
      return { connected: false, detail: errorText(err, 'Server not reachable') };
    }
  },

  async startPayment(req: PaymentRequest): Promise<PaymentResult> {
    const terminal = await getSetting<AdyenTerminal>(ADYEN_TERMINAL_SETTING);
    if (!terminal) return { approved: false, provider: 'adyen-terminal', error: 'No terminal picked for this till - choose one under Settings → Payments.' };
    const run = { ref: null as string | null, stopped: false };
    current = run;
    try {
      const { referenceId } = await sdk().http.post<{ referenceId: string }>('adyen/payments', {
        amount: Math.round(req.amount * 100) / 100,
        currency: req.currency.toUpperCase(),
        reference: req.reference,
        poiId: terminal.poiId,
      });
      run.ref = referenceId;
      const started = Date.now();
      for (;;) {
        await wait(POLL_MS);
        const o = await sdk().http.get<Outcome>(`adyen/payments/${encodeURIComponent(referenceId)}`).catch(() => null);
        if (o?.state === 'approved') {
          const txRef = o.pspReference ?? o.transactionId;
          return { approved: true, provider: 'adyen-terminal', ...(txRef ? { txRef } : {}), ...(o.cardBrand ? { cardBrand: o.cardBrand } : {}), ...(o.authCode ? { authCode: o.authCode } : {}) };
        }
        if (o?.state === 'declined') return { approved: false, provider: 'adyen-terminal', error: o.message || 'Declined on the terminal.' };
        if (o?.state === 'cancelled') return { approved: false, provider: 'adyen-terminal', error: 'Cancelled.' };
        const waited = Date.now() - started;
        if (run.stopped && waited > 20_000) return { approved: false, provider: 'adyen-terminal', error: 'Cancelled.' };
        if (waited > GIVE_UP_MS) {
          void sdk().http.post(`adyen/payments/${encodeURIComponent(referenceId)}/cancel`).catch(() => undefined);
          // Never assume either way: the card may still have gone through.
          return { approved: false, provider: 'adyen-terminal', error: 'No answer from the terminal. Check it before charging again - the payment may have gone through.' };
        }
      }
    } catch (err) {
      return { approved: false, provider: 'adyen-terminal', error: errorText(err, 'Could not reach the terminal.') };
    } finally {
      if (current === run) current = null;
    }
  },

  async cancel(): Promise<void> {
    const run = current;
    if (!run) return;
    run.stopped = true;
    if (run.ref) await sdk().http.post(`adyen/payments/${encodeURIComponent(run.ref)}/cancel`).catch(() => undefined);
  },

  async disconnect(): Promise<void> {
    await setSetting(ADYEN_TERMINAL_SETTING, null);
  },
};
