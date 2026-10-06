import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';
import { getSetting, setSetting } from '../lib/settings';
import { sdk } from '../runtime';

/**
 * Nexi SmartPOS (Nets SmartPOS N950 in Denmark), driven from the till over
 * the cloud: the server sends the amount to the terminal through Poynt's
 * Payment Bridge, the customer pays on the terminal, and the terminal tells
 * the server the outcome, which the till asks for until it has it. Works
 * from any device - nothing pairs locally. The account is connected once
 * under Settings → Payments, and each till picks its terminal there.
 */

export const SMARTPOS_TERMINAL_SETTING = 'smartpos.terminal';
export interface SmartposTerminal {
  storeId: string;
  storeName: string;
  deviceId: string;
  name: string;
  serial: string;
}

type Outcome = { state: 'sent' | 'started' | 'approved' | 'declined' | 'cancelled'; transactionId?: string; cardBrand?: string; last4?: string; authCode?: string; message?: string };

const POLL_MS = 1500;
/** No word from the terminal by then: it is off, asleep or offline. */
const PICKUP_MS = 45_000;
/** Longest a customer gets at the terminal. */
const GIVE_UP_MS = 180_000;

/** Card amounts go to the terminal in minor units (øre, cents). */
export function toMinor(amount: number, currency: string): number {
  let digits = 2;
  try {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    /* unknown code: cents */
  }
  return Math.round(amount * 10 ** digits);
}

const errorText = (err: unknown, fallback: string): string =>
  (err as { body?: { message?: string } } | null)?.body?.message ?? (err instanceof Error && err.message ? err.message : fallback);

let current: { ref: string | null; stopped: boolean } | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const nexiSmartposProvider: PaymentProvider = {
  id: 'nexi-smartpos',
  label: 'Nexi SmartPOS (Nets N950)',

  async isAvailable(): Promise<boolean> {
    try {
      return (await sdk().http.get<{ configured: boolean }>('smartpos/status')).configured;
    } catch {
      return false;
    }
  },

  async getStatus(): Promise<ProviderStatus> {
    try {
      const s = await sdk().http.get<{ configured: boolean; connected: boolean }>('smartpos/status');
      if (!s.configured) return { connected: false, detail: 'Not set up on this server' };
      if (!s.connected) return { connected: false, detail: 'Connect your Nexi account' };
      const t = await getSetting<SmartposTerminal>(SMARTPOS_TERMINAL_SETTING);
      return t ? { connected: true, detail: `Terminal: ${t.name}` } : { connected: false, detail: 'Pick this till’s terminal below' };
    } catch (err) {
      return { connected: false, detail: errorText(err, 'Server not reachable') };
    }
  },

  async startPayment(req: PaymentRequest): Promise<PaymentResult> {
    const terminal = await getSetting<SmartposTerminal>(SMARTPOS_TERMINAL_SETTING);
    if (!terminal) return { approved: false, provider: 'nexi-smartpos', error: 'No terminal picked for this till - choose one under Settings → Payments.' };
    const run = { ref: null as string | null, stopped: false };
    current = run;
    try {
      const { referenceId } = await sdk().http.post<{ referenceId: string }>('smartpos/payments', {
        amount: toMinor(req.amount, req.currency),
        currency: req.currency.toUpperCase(),
        reference: req.reference,
        storeId: terminal.storeId,
        deviceId: terminal.deviceId,
      });
      run.ref = referenceId;
      const started = Date.now();
      for (;;) {
        await wait(POLL_MS);
        const o = await sdk().http.get<Outcome>(`smartpos/payments/${encodeURIComponent(referenceId)}`).catch(() => null);
        if (o?.state === 'approved') {
          return { approved: true, provider: 'nexi-smartpos', ...(o.transactionId ? { txRef: o.transactionId } : {}), ...(o.cardBrand ? { cardBrand: o.cardBrand } : {}), ...(o.authCode ? { authCode: o.authCode } : {}) };
        }
        if (o?.state === 'declined') return { approved: false, provider: 'nexi-smartpos', error: o.message || 'Declined on the terminal.' };
        if (o?.state === 'cancelled') return { approved: false, provider: 'nexi-smartpos', error: 'Cancelled.' };
        const waited = Date.now() - started;
        if (run.stopped && waited > 20_000) return { approved: false, provider: 'nexi-smartpos', error: 'Cancelled.' };
        if (o?.state === 'sent' && waited > PICKUP_MS) {
          void sdk().http.post(`smartpos/payments/${encodeURIComponent(referenceId)}/cancel`).catch(() => undefined);
          return { approved: false, provider: 'nexi-smartpos', error: `${terminal.name} did not pick up the payment - is it on and online?` };
        }
        if (waited > GIVE_UP_MS) {
          void sdk().http.post(`smartpos/payments/${encodeURIComponent(referenceId)}/cancel`).catch(() => undefined);
          // Never assume either way: the card may still have gone through.
          return { approved: false, provider: 'nexi-smartpos', error: 'No answer from the terminal. Check it before charging again - the payment may have gone through.' };
        }
      }
    } catch (err) {
      return { approved: false, provider: 'nexi-smartpos', error: errorText(err, 'Could not reach the terminal.') };
    } finally {
      if (current === run) current = null;
    }
  },

  /** Asks the terminal to drop the payment; the outcome still comes back from it. */
  async cancel(): Promise<void> {
    const run = current;
    if (!run) return;
    run.stopped = true;
    if (run.ref) await sdk().http.post(`smartpos/payments/${encodeURIComponent(run.ref)}/cancel`).catch(() => undefined);
  },

  /** Sends the owner to Nexi/Poynt to allow Zollify on their account; they come back to Settings. */
  async configure(): Promise<void> {
    const { url } = await sdk().http.post<{ url: string }>('smartpos/connect');
    window.location.href = url;
  },

  async disconnect(): Promise<void> {
    await sdk().http.del('smartpos/connection');
    await setSetting(SMARTPOS_TERMINAL_SETTING, null);
  },
};

export const loadSmartposTerminals = async (): Promise<SmartposTerminal[]> => (await sdk().http.get<{ terminals: SmartposTerminal[] }>('smartpos/terminals')).terminals;
