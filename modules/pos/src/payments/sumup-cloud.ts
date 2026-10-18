import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';
import { toMinor } from './nexi-smartpos';
import { getSetting, setSetting } from '../lib/settings';
import { sdk } from '../runtime';

/**
 * SumUp Solo over SumUp's Cloud API: the server sends the amount to the Solo,
 * the customer pays there, and the till asks the server for the outcome until
 * it has it. Nothing pairs with this device, so it works in a browser too -
 * the Solo only has to be online (Wi-Fi or its own SIM). The account connects
 * its SumUp login once; each till picks its Solo under Settings → Card terminal.
 */

export const SUMUP_READER_SETTING = 'sumup.cloudReader';
export interface SumupReader {
  id: string;
  name: string;
  status: string;
  model: string;
}
export interface SumupCloudStatus {
  /** The server has a SumUp app to connect with. */
  configured: boolean;
  /** The server has the affiliate key SumUp wants on every card payment. */
  affiliate: boolean;
  connected: boolean;
  merchant: { code: string; name: string } | null;
  canManage: boolean;
  redirectUrl: string;
}

export const loadSumupCloudStatus = (): Promise<SumupCloudStatus> => sdk().http.get<SumupCloudStatus>('sumup/cloud/status');
export const loadSumupReaders = async (): Promise<SumupReader[]> => (await sdk().http.get<{ readers: SumupReader[] }>('sumup/cloud/readers')).readers;
export const pairSumupReader = async (pairingCode: string, name: string): Promise<SumupReader> =>
  (await sdk().http.post<{ reader: SumupReader }>('sumup/cloud/readers', { pairingCode, name })).reader;
export const thisTillsReader = (): Promise<Pick<SumupReader, 'id' | 'name'> | undefined> => getSetting<Pick<SumupReader, 'id' | 'name'>>(SUMUP_READER_SETTING);
export const useReader = (r: Pick<SumupReader, 'id' | 'name'> | null): Promise<void> => setSetting(SUMUP_READER_SETTING, r ? { id: r.id, name: r.name } : null);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorText = (err: unknown, fallback: string): string =>
  (err as { body?: { message?: string } } | null)?.body?.message ?? (err instanceof Error && err.message ? err.message : fallback);

/**
 * Opens SumUp's sign-in in a window of its own and waits until the server has
 * the connection, so the screen that asked - setup or Settings - stays as it
 * was. True once connected; false when the window closed without it.
 */
export async function connectSumup(): Promise<boolean> {
  const { url } = await sdk().http.post<{ url: string }>('sumup/cloud/connect');
  const popup = window.open(url, 'zollify-sumup', 'width=480,height=720');
  if (!popup) throw new Error('Allow pop-ups for Zollify, then tap Connect again.');
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    await wait(2000);
    const s = await loadSumupCloudStatus().catch(() => null);
    if (s?.connected) return true;
    // The window closing first means the merchant gave up - one last look, then stop.
    if (popup.closed) return (await loadSumupCloudStatus().catch(() => null))?.connected ?? false;
  }
  return false;
}

type Outcome = { state: 'sent' | 'approved' | 'declined' | 'cancelled'; transactionId?: string; message?: string };
const POLL_MS = 1500;
/** Longest a customer gets at the Solo. */
const GIVE_UP_MS = 180_000;
let current: { ref: string | null; stopped: boolean } | null = null;

export const sumupCloudProvider: PaymentProvider = {
  id: 'sumup-cloud',
  label: 'SumUp Solo (over the internet)',

  /** Offered wherever the server has a SumUp app - any device, browser included. */
  async isAvailable(): Promise<boolean> {
    try {
      return (await loadSumupCloudStatus()).configured;
    } catch {
      return false;
    }
  },

  async getStatus(): Promise<ProviderStatus> {
    try {
      const s = await loadSumupCloudStatus();
      if (!s.connected) return { connected: false, detail: 'Connect your SumUp account' };
      if (!s.affiliate) return { connected: false, detail: 'The server needs a SumUp affiliate key' };
      const r = await thisTillsReader();
      return r ? { connected: true, detail: `Solo: ${r.name}` } : { connected: false, detail: 'Pair or pick this till’s Solo below' };
    } catch (err) {
      return { connected: false, detail: errorText(err, 'Server not reachable') };
    }
  },

  async startPayment(req: PaymentRequest): Promise<PaymentResult> {
    const reader = await thisTillsReader();
    if (!reader) return { approved: false, provider: 'sumup-cloud', error: 'No Solo picked for this till - choose one under Settings → Card terminal.' };
    const run = { ref: null as string | null, stopped: false };
    current = run;
    try {
      const { referenceId } = await sdk().http.post<{ referenceId: string }>('sumup/cloud/payments', {
        amount: toMinor(req.amount, req.currency),
        currency: req.currency.toUpperCase(),
        reference: req.reference,
        readerId: reader.id,
      });
      run.ref = referenceId;
      const started = Date.now();
      for (;;) {
        await wait(POLL_MS);
        const o = await sdk().http.get<Outcome>(`sumup/cloud/payments/${encodeURIComponent(referenceId)}`).catch(() => null);
        if (o?.state === 'approved') return { approved: true, provider: 'sumup-cloud', ...(o.transactionId ? { txRef: o.transactionId } : {}) };
        if (o?.state === 'declined') return { approved: false, provider: 'sumup-cloud', error: o.message || 'Declined on the Solo.' };
        if (o?.state === 'cancelled') return { approved: false, provider: 'sumup-cloud', error: 'Cancelled.' };
        const waited = Date.now() - started;
        if (run.stopped && waited > 20_000) return { approved: false, provider: 'sumup-cloud', error: 'Cancelled.' };
        if (waited > GIVE_UP_MS) {
          void sdk().http.post(`sumup/cloud/payments/${encodeURIComponent(referenceId)}/cancel`).catch(() => undefined);
          // Never assume either way: the card may still have gone through.
          return { approved: false, provider: 'sumup-cloud', error: 'No answer from the Solo. Check the SumUp app before charging again - the payment may have gone through.' };
        }
      }
    } catch (err) {
      return { approved: false, provider: 'sumup-cloud', error: errorText(err, `Could not reach ${reader.name} - is it on and online?`) };
    } finally {
      if (current === run) current = null;
    }
  },

  /** Asks the Solo to drop the payment; it can only while it waits for the card. */
  async cancel(): Promise<void> {
    const run = current;
    if (!run) return;
    run.stopped = true;
    if (run.ref) await sdk().http.post(`sumup/cloud/payments/${encodeURIComponent(run.ref)}/cancel`).catch(() => undefined);
  },

  async configure(): Promise<void> {
    if (!(await connectSumup())) throw new Error('SumUp was not connected.');
  },

  async disconnect(): Promise<void> {
    await sdk().http.del('sumup/cloud/connection');
    await useReader(null);
  },
};
