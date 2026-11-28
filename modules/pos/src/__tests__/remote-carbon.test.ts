import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentCancelMessage, PaymentResultMessage, PaymentTriggerMessage } from '@zollify/shared';
import type { Sdk } from '@zollify/sdk';
import type { PaymentResult } from '../payments/provider';

/**
 * A till takes the card on a satellite Carbon over the live channel. When the
 * seller gives up on a payment the Carbon still shows, the Carbon is told,
 * a retry cannot start a second charge next to the first, and an approval
 * that arrives afterwards reaches the seller instead of vanishing.
 */

type Message = PaymentTriggerMessage | PaymentResultMessage | PaymentCancelMessage;

const h = vi.hoisted(() => ({
  carbon: {
    available: true,
    /** Resolves the "can this device take cards" check; null answers at once. */
    availableGate: null as null | Promise<void>,
    payments: [] as { amount: number; finish: (r: Partial<PaymentResult>) => void }[],
    cancels: 0,
  },
}));
const { carbon } = h;

vi.mock('../lib/settings', () => ({ getSetting: async () => 'carbon' }));
vi.mock('../payments/mypos-carbon', () => ({
  myposCarbonProvider: {
    id: 'mypos-carbon',
    label: 'MyPOS Carbon (on-device)',
    isAvailable: async () => {
      await h.carbon.availableGate;
      return h.carbon.available;
    },
    startPayment: (req: { amount: number }) =>
      new Promise((resolve) => {
        h.carbon.payments.push({ amount: req.amount, finish: (r) => resolve({ approved: false, provider: 'mypos-carbon', ...r }) });
      }),
    cancel: async () => void h.carbon.cancels++,
  },
}));

const { setSdk } = await import('../runtime');
const { myposCarbonRemoteProvider } = await import('../payments/mypos-carbon-remote');
const { listenForRemotePayments, SATELLITE_BUSY_ERROR } = await import('../payments/satellite');
const { lateApprovals } = await import('../lib/late-approvals');

// One live channel for both ends. The server stamps `from`; the till sends
// triggers and cancels, the Carbon sends results.
const sent: Message[] = [];
const listeners = new Set<(msg: Message) => void>();
const toasts: string[] = [];
const store: Record<string, unknown> = {};
function relay(msg: Message): boolean {
  const stamped = { ...msg, from: msg.type === 'payment.result' ? 'carbon' : 'till' };
  sent.push(stamped);
  for (const l of [...listeners]) l(stamped);
  return true;
}
const fake = {
  realtime: {
    connected: () => true,
    deviceId: async () => 'carbon',
    sendPayment: relay,
    onPayment: (handler: (msg: Message) => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  },
  ui: { toast: (message: string) => toasts.push(message) },
  config: { get: async (key: string) => store[key], set: async (key: string, value: unknown) => void (store[key] = value) },
  log: { info: () => {} },
} as unknown as Sdk;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const ofType = <T extends Message['type']>(type: T): Extract<Message, { type: T }>[] => sent.filter((m): m is Extract<Message, { type: T }> => m.type === type);
const pay = (amount = 25): Promise<PaymentResult> => myposCarbonRemoteProvider.startPayment({ amount, currency: 'EUR', reference: 'sale-1' });

let stopCarbon = (): void => {};
beforeEach(async () => {
  vi.useFakeTimers();
  setSdk(fake);
  sent.length = 0;
  toasts.length = 0;
  listeners.clear();
  lateApprovals.value = [];
  Object.assign(carbon, { available: true, availableGate: null, payments: [], cancels: 0 });
  stopCarbon = listenForRemotePayments();
  await flush();
});
afterEach(async () => {
  // Nothing may be left waiting on the Carbon for the next test.
  for (const p of carbon.payments) p.finish({ approved: false, error: 'test over' });
  await myposCarbonRemoteProvider.cancel();
  await flush();
  stopCarbon();
  vi.useRealTimers();
});

describe('a payment on the remote Carbon', () => {
  it('approves the sale when the Carbon answers in time', async () => {
    const result = pay();
    await flush();
    carbon.payments[0]!.finish({ approved: true, txRef: 'TX-1' });
    expect(await result).toMatchObject({ approved: true, txRef: 'TX-1' });
    expect(lateApprovals.value).toEqual([]);
  });

  it('cancel tells the Carbon which request to drop', async () => {
    const result = pay();
    await flush();
    await myposCarbonRemoteProvider.cancel();
    expect(await result).toMatchObject({ approved: false, error: 'Cancelled' });
    const [trigger] = ofType('payment.trigger');
    expect(ofType('payment.cancel')).toEqual([{ type: 'payment.cancel', to: 'carbon', from: 'till', requestId: trigger!.requestId }]);
    await flush();
    expect(carbon.cancels).toBe(1);
  });

  it('an approval after cancel reaches the seller with amount and reference', async () => {
    const result = pay(25);
    await flush();
    await myposCarbonRemoteProvider.cancel();
    await result;
    // The customer taps the Carbon, which still showed the payment.
    carbon.payments[0]!.finish({ approved: true, txRef: 'TX-LATE' });
    await flush();
    expect(lateApprovals.value).toHaveLength(1);
    expect(lateApprovals.value[0]).toMatchObject({ terminal: 'myPOS Carbon (remote)', amount: 25, currency: 'EUR', txRef: 'TX-LATE' });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain('TX-LATE');
  });

  it('an approval after the 90 s timeout reaches the seller too', async () => {
    const result = pay(40);
    await flush();
    await vi.advanceTimersByTimeAsync(90_000);
    expect((await result).approved).toBe(false);
    expect(ofType('payment.cancel')).toHaveLength(1);
    carbon.payments[0]!.finish({ approved: true, txRef: 'TX-SLOW' });
    await flush();
    expect(lateApprovals.value.map((a) => [a.amount, a.txRef])).toEqual([[40, 'TX-SLOW']]);
  });

  it('a decline after cancel raises no warning', async () => {
    const result = pay();
    await flush();
    await myposCarbonRemoteProvider.cancel();
    await result;
    carbon.payments[0]!.finish({ approved: false, error: 'Payment cancelled' });
    await flush();
    expect(lateApprovals.value).toEqual([]);
  });

  it('a retry while the Carbon still shows the first payment is refused, not charged', async () => {
    const first = pay();
    await flush();
    await myposCarbonRemoteProvider.cancel();
    await first;
    const retry = await pay();
    expect(retry).toMatchObject({ approved: false, error: SATELLITE_BUSY_ERROR });
    // The Carbon never opened a second card screen.
    expect(carbon.payments).toHaveLength(1);
  });

  it('a cancel that arrives before the card screen opened stops the payment', async () => {
    let open = (): void => {};
    carbon.availableGate = new Promise<void>((resolve) => (open = resolve));
    const result = pay();
    await flush();
    await myposCarbonRemoteProvider.cancel();
    await result;
    open();
    await flush();
    expect(carbon.payments).toHaveLength(0);
    expect(ofType('payment.result').at(-1)).toMatchObject({ approved: false, error: 'Cancelled' });
    expect(lateApprovals.value).toEqual([]);
  });

  it('takes the next payment once the first is over', async () => {
    const first = pay();
    await flush();
    carbon.payments[0]!.finish({ approved: true, txRef: 'TX-1' });
    await first;
    const second = pay();
    await flush();
    carbon.payments[1]!.finish({ approved: true, txRef: 'TX-2' });
    expect(await second).toMatchObject({ approved: true, txRef: 'TX-2' });
  });

  it('a message type from a newer version is ignored by both ends', async () => {
    const result = pay();
    await flush();
    const [trigger] = ofType('payment.trigger');
    relay({ type: 'payment.future', to: 'carbon', requestId: trigger!.requestId } as unknown as Message);
    await flush();
    carbon.payments[0]!.finish({ approved: true, txRef: 'TX-1' });
    expect(await result).toMatchObject({ approved: true, txRef: 'TX-1' });
    expect(carbon.payments).toHaveLength(1);
  });

  it('a cancel for another request, or from another register, does not touch the running payment', async () => {
    const result = pay();
    await flush();
    const [trigger] = ofType('payment.trigger');
    for (const l of [...listeners]) l({ type: 'payment.cancel', to: 'carbon', from: 'till', requestId: 'someone-elses' });
    for (const l of [...listeners]) l({ type: 'payment.cancel', to: 'carbon', from: 'other-till', requestId: trigger!.requestId });
    await flush();
    expect(carbon.cancels).toBe(0);
    carbon.payments[0]!.finish({ approved: true, txRef: 'TX-1' });
    expect((await result).approved).toBe(true);
  });
});
