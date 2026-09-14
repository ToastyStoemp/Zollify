import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';
import type { PaymentResultMessage, PaymentTriggerMessage } from '@zollify/shared';
import { getSetting } from '../lib/settings';
import { logDiagnostic } from '../lib/diagnostics';
import { sdk } from '../runtime';

/** Settings key: the satellite Carbon's device id (shown under This device on the Carbon itself). */
export const REMOTE_CARBON_DEVICE_KEY = 'payments.remoteCarbonDeviceId';

const PAYMENT_TIMEOUT_MS = 90_000;

/**
 * Takes the card on a satellite myPOS Carbon instead of this device: a
 * payment.trigger goes to the Carbon over the account's live channel, the
 * matching payment.result comes back, correlated by requestId. Ported from
 * ZollTool. The Carbon side is `listenForRemotePayments` in this module.
 */
let pending: { requestId: string; resolve: (msg: PaymentResultMessage) => void; timer: ReturnType<typeof setTimeout>; off: () => void } | null = null;

async function pay(target: string, req: PaymentRequest): Promise<PaymentResultMessage> {
  if (pending) throw new Error('A remote payment is already in progress');
  const requestId = crypto.randomUUID();
  const trigger: PaymentTriggerMessage = { type: 'payment.trigger', to: target, requestId, amount: req.amount, currency: req.currency, reference: req.reference };
  let done = (): void => {};
  const result = new Promise<PaymentResultMessage>((resolve, reject) => {
    const off = sdk().realtime.onPayment((msg) => {
      if (msg.type !== 'payment.result' || msg.requestId !== requestId) return;
      done();
      resolve(msg);
    });
    const timer = setTimeout(() => {
      done();
      reject(new Error('No response from the Carbon — check it is on, connected, and the device id is correct.'));
    }, PAYMENT_TIMEOUT_MS);
    done = (): void => {
      clearTimeout(timer);
      off();
      pending = null;
    };
    pending = { requestId, resolve, timer, off };
  });
  logDiagnostic(`RemoteCarbon trigger to=${target} amount=${req.amount} currency=${req.currency}`);
  if (!sdk().realtime.sendPayment(trigger)) {
    done();
    throw new Error('Not connected to the server — the Carbon cannot be reached.');
  }
  const msg = await result;
  logDiagnostic(`RemoteCarbon result approved=${msg.approved}${msg.error ? ` error=${msg.error}` : ''}`);
  return msg;
}

export const myposCarbonRemoteProvider: PaymentProvider = {
  id: 'mypos-carbon-remote',
  label: 'myPOS Carbon (remote)',
  // The target is a setting, not a platform capability, so this always lists;
  // an unset target surfaces as "not connected" in getStatus().
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async getStatus(): Promise<ProviderStatus> {
    const target = await getSetting<string>(REMOTE_CARBON_DEVICE_KEY);
    if (!target) return { connected: false, detail: 'No remote Carbon chosen — pick one under Payments' };
    return sdk().realtime.connected() ? { connected: true, detail: 'Ready (online)' } : { connected: false, detail: 'Not connected to the server' };
  },
  async startPayment(req: PaymentRequest): Promise<PaymentResult> {
    const target = await getSetting<string>(REMOTE_CARBON_DEVICE_KEY);
    if (!target) return { approved: false, provider: 'mypos-carbon-remote', error: 'No remote Carbon configured — pick one under Payments.' };
    try {
      const msg = await pay(target, req);
      return { approved: msg.approved, provider: 'mypos-carbon-remote', txRef: msg.txRef, cardBrand: msg.cardBrand, authCode: msg.authCode, error: msg.error };
    } catch (err) {
      return { approved: false, provider: 'mypos-carbon-remote', error: err instanceof Error ? err.message : String(err) };
    }
  },
  async cancel(): Promise<void> {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.off();
    pending = null;
  },
};
