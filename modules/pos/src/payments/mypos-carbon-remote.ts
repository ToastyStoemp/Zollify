import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';
import type { PaymentCancelMessage, PaymentResultMessage, PaymentTriggerMessage } from '@zollify/shared';
import { getSetting } from '../lib/settings';
import { logDiagnostic } from '../lib/diagnostics';
import { reportLateApproval } from '../lib/late-approvals';
import { sdk } from '../runtime';

/** Settings key: the satellite Carbon's device id (shown under This device on the Carbon itself). */
export const REMOTE_CARBON_DEVICE_KEY = 'payments.remoteCarbonDeviceId';

const PAYMENT_TIMEOUT_MS = 90_000;
/**
 * How long the till keeps an ear out for the answer to a payment it gave up
 * on. The Carbon cannot be made to drop a payment from here, so the customer
 * may still tap minutes later; past this the request is forgotten.
 */
const LATE_RESULT_WATCH_MS = 15 * 60_000;

const LABEL = 'myPOS Carbon (remote)';

/**
 * Takes the card on a satellite myPOS Carbon instead of this device: a
 * payment.trigger goes to the Carbon over the account's live channel, the
 * matching payment.result comes back, correlated by requestId. Ported from
 * ZollTool. The Carbon side is `listenForRemotePayments` in this module.
 */
interface RemoteRequest {
  requestId: string;
  target: string;
  req: PaymentRequest;
}
let pending: (RemoteRequest & { reject: (err: Error) => void; settle: () => void }) | null = null;

/** Calls back with the Carbon's answer to one request; the returned function stops listening. */
function onResultFor(requestId: string, handler: (msg: PaymentResultMessage) => void): () => void {
  return sdk().realtime.onPayment((msg) => {
    if (msg.type === 'payment.result' && msg.requestId === requestId) handler(msg);
  });
}

/**
 * The till stopped waiting for this request, but the Carbon may still be
 * showing it. Ask the Carbon to drop it, and keep listening: an approval that
 * arrives now charged a card for a sale nobody recorded, and the seller must
 * hear of it. A Carbon or server that predates payment.cancel ignores it.
 */
function abandon(request: RemoteRequest): void {
  const cancel: PaymentCancelMessage = { type: 'payment.cancel', to: request.target, requestId: request.requestId };
  sdk().realtime.sendPayment(cancel);
  const stop = (): void => {
    clearTimeout(expiry);
    off();
  };
  const off = onResultFor(request.requestId, (msg) => {
    stop();
    logDiagnostic(`RemoteCarbon late result approved=${msg.approved}${msg.error ? ` error=${msg.error}` : ''}`);
    if (msg.approved) void reportLateApproval({ terminal: LABEL, amount: request.req.amount, currency: request.req.currency, txRef: msg.txRef });
  });
  const expiry = setTimeout(stop, LATE_RESULT_WATCH_MS);
}

async function pay(target: string, req: PaymentRequest): Promise<PaymentResultMessage> {
  if (pending) throw new Error('A remote payment is already in progress');
  const request: RemoteRequest = { requestId: crypto.randomUUID(), target, req };
  const trigger: PaymentTriggerMessage = { type: 'payment.trigger', to: target, requestId: request.requestId, amount: req.amount, currency: req.currency, reference: req.reference };
  let settle = (): void => {};
  const result = new Promise<PaymentResultMessage>((resolve, reject) => {
    const off = onResultFor(request.requestId, (msg) => {
      settle();
      resolve(msg);
    });
    const timer = setTimeout(() => {
      settle();
      abandon(request);
      reject(new Error('No response from the Carbon - check it is on, connected, and the device id is correct. If the Carbon still shows the payment, cancel it there before charging again.'));
    }, PAYMENT_TIMEOUT_MS);
    settle = (): void => {
      clearTimeout(timer);
      off();
      pending = null;
    };
    pending = { ...request, reject, settle };
  });
  logDiagnostic(`RemoteCarbon trigger to=${target} amount=${req.amount} currency=${req.currency}`);
  if (!sdk().realtime.sendPayment(trigger)) {
    settle();
    throw new Error('Not connected to the server - the Carbon cannot be reached.');
  }
  const msg = await result;
  logDiagnostic(`RemoteCarbon result approved=${msg.approved}${msg.error ? ` error=${msg.error}` : ''}`);
  return msg;
}

export const myposCarbonRemoteProvider: PaymentProvider = {
  id: 'mypos-carbon-remote',
  label: LABEL,
  // The target is a setting, not a platform capability, so this always lists;
  // an unset target surfaces as "not connected" in getStatus().
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async getStatus(): Promise<ProviderStatus> {
    const target = await getSetting<string>(REMOTE_CARBON_DEVICE_KEY);
    if (!target) return { connected: false, detail: 'No remote Carbon chosen - pick one below' };
    return sdk().realtime.connected() ? { connected: true, detail: 'Ready (online)' } : { connected: false, detail: 'Not connected to the server' };
  },
  async startPayment(req: PaymentRequest): Promise<PaymentResult> {
    const target = await getSetting<string>(REMOTE_CARBON_DEVICE_KEY);
    if (!target) return { approved: false, provider: 'mypos-carbon-remote', error: 'No remote Carbon configured - pick one under Payments.' };
    try {
      const msg = await pay(target, req);
      return { approved: msg.approved, provider: 'mypos-carbon-remote', txRef: msg.txRef, cardBrand: msg.cardBrand, authCode: msg.authCode, error: msg.error };
    } catch (err) {
      return { approved: false, provider: 'mypos-carbon-remote', error: err instanceof Error ? err.message : String(err) };
    }
  },
  async cancel(): Promise<void> {
    if (!pending) return;
    const p = pending;
    p.settle();
    abandon(p);
    // startPayment() turns this into { approved: false, error: 'Cancelled' }.
    p.reject(new Error('Cancelled'));
  },
};
