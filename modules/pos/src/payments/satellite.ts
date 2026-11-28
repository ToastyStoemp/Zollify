import type { PaymentCancelMessage, PaymentResultMessage, PaymentTriggerMessage } from '@zollify/shared';
import { myposCarbonProvider } from './mypos-carbon';
import { logDiagnostic } from '../lib/diagnostics';
import { sdk } from '../runtime';

type Outcome = Omit<PaymentResultMessage, 'type' | 'to' | 'requestId'>;

/** Told to a register whose request arrives while the Carbon is still on an earlier one. */
export const SATELLITE_BUSY_ERROR = 'The Carbon is still busy with an earlier payment - finish or cancel it on the Carbon, then try again.';

/**
 * The Carbon side of a remote payment: a register asked THIS device to
 * charge a card. Runs the same on-device flow as a local sale and replies
 * over the live channel. Wired at module setup so it works whatever screen
 * the Carbon is showing - usually the customer display.
 *
 * One payment at a time. A register that retries while the Carbon still
 * shows its first request is told the Carbon is busy, so the customer can
 * never be walked through two charges for one sale.
 */
export function listenForRemotePayments(): () => void {
  let myId = '';
  // The request the Carbon is working on, and whether its register asked to drop it.
  let active: { requestId: string; from: string; cancelled: boolean } | null = null;
  void sdk().realtime.deviceId().then((id) => (myId = id));

  const reply = (to: string, requestId: string, outcome: Outcome): void => {
    sdk().realtime.sendPayment({ type: 'payment.result', to, requestId, ...outcome });
  };

  /** Takes the card for one request. The outcome always goes back, cancelled or not: it is the only proof of a charge. */
  async function charge(msg: PaymentTriggerMessage, from: string): Promise<Outcome> {
    if (!(await myposCarbonProvider.isAvailable())) return { approved: false, error: 'This device cannot process card payments' };
    // Cancelled before the card screen opened: nothing to charge.
    if (active?.cancelled) return { approved: false, error: 'Cancelled' };
    const r = await myposCarbonProvider.startPayment({ amount: msg.amount, currency: msg.currency, reference: msg.reference });
    logDiagnostic(`payment.trigger from=${from} finished approved=${r.approved}`);
    return { approved: r.approved, txRef: r.txRef, cardBrand: r.cardBrand, authCode: r.authCode, error: r.error };
  }

  async function onTrigger(msg: PaymentTriggerMessage, from: string): Promise<void> {
    logDiagnostic(`payment.trigger received amount=${msg.amount} currency=${msg.currency} from=${from}`);
    if (active) {
      // The same request delivered twice is already being answered.
      if (active.requestId !== msg.requestId) reply(from, msg.requestId, { approved: false, error: SATELLITE_BUSY_ERROR });
      return;
    }
    active = { requestId: msg.requestId, from, cancelled: false };
    try {
      reply(from, msg.requestId, await charge(msg, from));
    } catch (err) {
      reply(from, msg.requestId, { approved: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      active = null;
    }
  }

  async function onCancel(msg: PaymentCancelMessage, from: string): Promise<void> {
    if (!active || active.requestId !== msg.requestId || active.from !== from) return;
    logDiagnostic(`payment.cancel received from=${from}`);
    active.cancelled = true;
    // Today a no-op: the Carbon's card screen can only be closed on the Carbon
    // itself. Asked through the provider so a terminal that can cancel, does.
    await myposCarbonProvider.cancel().catch(() => undefined);
  }

  return sdk().realtime.onPayment((msg) => {
    if (!msg.from || msg.to !== myId) return;
    if (msg.type === 'payment.trigger') void onTrigger(msg, msg.from);
    else if (msg.type === 'payment.cancel') void onCancel(msg, msg.from);
  });
}
