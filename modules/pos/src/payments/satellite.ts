import type { PaymentResultMessage } from '@zollify/shared';
import { myposCarbonProvider } from './mypos-carbon';
import { logDiagnostic } from '../lib/diagnostics';
import { sdk } from '../runtime';

/**
 * The Carbon side of a remote payment: a register asked THIS device to
 * charge a card. Runs the same on-device flow as a local sale and replies
 * over the live channel. Wired at module setup so it works whatever screen
 * the Carbon is showing — usually the customer display.
 */
export function listenForRemotePayments(): () => void {
  let myId = '';
  void sdk().realtime.deviceId().then((id) => (myId = id));
  return sdk().realtime.onPayment((msg) => {
    if (msg.type !== 'payment.trigger' || !msg.from || msg.to !== myId) return;
    void (async () => {
      logDiagnostic(`payment.trigger received amount=${msg.amount} currency=${msg.currency} from=${msg.from}`);
      const reply = (r: Omit<PaymentResultMessage, 'type' | 'to' | 'requestId'>): void => {
        sdk().realtime.sendPayment({ type: 'payment.result', to: msg.from!, requestId: msg.requestId, ...r });
      };
      if (!(await myposCarbonProvider.isAvailable())) return reply({ approved: false, error: 'This device cannot process card payments' });
      const r = await myposCarbonProvider.startPayment({ amount: msg.amount, currency: msg.currency, reference: msg.reference });
      reply({ approved: r.approved, txRef: r.txRef, cardBrand: r.cardBrand, authCode: r.authCode, error: r.error });
    })();
  });
}
