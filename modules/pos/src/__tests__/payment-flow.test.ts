import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { SalesEvent } from '@zollify/shared';
import type { SaleEvent, Sdk } from '@zollify/sdk';
import type { PaymentProvider, PaymentRequest, PaymentResult } from '../payments/provider';

/**
 * The payment sheet, from the tap on a pay button to the sale: cash, card on
 * a terminal (approved, declined, cancelled, by hand), split and give-away,
 * and the second tap that must start nothing. Runs against the real cart and
 * checkout(), with a terminal that answers when the test says so. Written
 * when this left PosView.vue, to pin down what it did there.
 */

const h = vi.hoisted(() => ({ answer: null as null | ((r: PaymentResult) => void), requests: [] as PaymentRequest[], cancels: 0 }));
const terminal: PaymentProvider = {
  id: 'mypos-go2',
  label: 'MyPOS GO2',
  isAvailable: async () => true,
  getStatus: async () => ({ connected: true }),
  startPayment: (req) => {
    h.requests.push(req);
    return new Promise<PaymentResult>((resolve) => (h.answer = resolve));
  },
  cancel: async () => {
    h.cancels++;
    h.answer?.({ approved: false, provider: 'mypos-go2', error: 'Cancelled.' });
  },
};
vi.mock('../payments/registry', () => ({ getProvider: () => terminal }));

const { setSdk } = await import('../runtime');
const { addMisc, cart, clear, setCartEvent, setCustomDiscount, GIVEN_AWAY } = await import('../cart');
const { usePaymentFlow } = await import('../composables/usePaymentFlow');

const store: Record<string, unknown> = {};
const sales: SaleEvent[] = [];
const sentLogs: string[] = [];
const empty = (): unknown => new Proxy(() => [], { get: (_t, k) => (k === 'then' ? undefined : empty()), apply: () => [] });
const fake = new Proxy(
  {
    data: new Proxy({ events: { sellLock: () => null, list: () => [], get: () => undefined } } as Record<string, unknown>, { get: (t, k: string) => (k in t ? t[k] : empty()) }),
    events: { emit: (_name: string, sale: SaleEvent) => sales.push(sale) },
    ui: { toast: () => undefined },
    config: { get: async (key: string) => store[key], set: async (key: string, value: unknown) => void (store[key] = value) },
    diagnostics: { sendLog: async (reason: string) => void sentLogs.push(reason) },
  } as Record<string, unknown>,
  { get: (t, k: string) => (k in t ? t[k] : empty()) },
) as unknown as Sdk;

const event = { id: 'con', name: 'Con', venue: {}, currency: 'EUR', status: 'active', updatedAt: 1 } as SalesEvent;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r));

interface TillOptions {
  hasTerminal?: boolean;
  event?: SalesEvent | null;
  sellBlocked?: boolean;
  provider?: PaymentProvider;
}
function till(options: TillOptions = {}) {
  const toasts: [string, string?][] = [];
  const paid: { sale: SaleEvent; message: string; test?: boolean }[] = [];
  const refreshTerminalStatus = vi.fn(async () => undefined);
  const flow = usePaymentFlow({
    toast: (text, kind) => toasts.push(kind ? [text, kind] : [text]),
    activeEvent: ref(options.event === undefined ? event : options.event),
    sellBlocked: ref(options.sellBlocked ?? false),
    lockedBy: ref('Other Con'),
    provider: ref(options.provider ?? terminal),
    providerId: ref('mypos-go2'),
    hasTerminal: ref(options.hasTerminal ?? false),
    refreshTerminalStatus,
    onPaid: (sale, message, test) => {
      // The till's finish() closes the sheet first.
      flow.payment.phase = 'idle';
      paid.push({ sale, message, test });
    },
  });
  return { ...flow, toasts, paid, refreshTerminalStatus };
}

beforeEach(() => {
  setSdk(fake);
  for (const key of Object.keys(store)) delete store[key];
  sales.length = 0;
  sentLogs.length = 0;
  h.answer = null;
  h.requests.length = 0;
  h.cancels = 0;
  clear();
  setCartEvent(event, 'EUR');
  addMisc('Print', 20, 1);
  addMisc('Sticker', 2.5, 2);
});

// A terminal still waiting at the end of a test is answered, so the cart is free for the next one.
afterEach(async () => {
  h.answer?.({ approved: false, provider: 'mypos-go2', error: 'Test over.' });
  await tick();
  await tick();
});

describe('starting a payment', () => {
  it('does nothing on an empty cart', () => {
    clear();
    const t = till();
    t.startPayment('cash');
    expect(t.payment.phase).toBe('idle');
    expect(t.toasts).toEqual([]);
  });

  it('asks for an event when none is active', () => {
    const t = till({ event: null });
    t.startPayment('cash');
    expect(t.payment.phase).toBe('idle');
    expect(t.toasts).toEqual([['Pick an active event first (Events).', 'bad']]);
  });

  it('refuses while the event is sell-locked', () => {
    const t = till({ sellBlocked: true });
    t.startPayment('card');
    expect(t.payment.phase).toBe('idle');
    expect(t.toasts).toEqual([["Sell 🔒 - Other Con took this event's leftovers.", 'bad']]);
  });
});

describe('cash', () => {
  it('opens on the exact amount, shows the change, and records the sale on confirm', async () => {
    const t = till();
    t.startPayment('cash');
    expect(t.payment).toMatchObject({ phase: 'confirm', method: 'cash', total: 25, cashReceived: '25.00' });
    expect(t.title.value).toBe('Cash payment');
    expect(t.cashShortcuts.value.every((a) => a >= 25)).toBe(true);
    expect(t.confirmDisabled.value).toBe(false);

    t.payment.cashReceived = '20';
    expect(t.change.value).toBe(-5);
    expect(t.confirmDisabled.value).toBe(true);

    t.payment.cashReceived = '30';
    expect(t.change.value).toBe(5);
    await t.confirmPayment();
    expect(sales).toHaveLength(1);
    expect(sales[0]!.payment).toMatchObject({ method: 'cash', provider: 'cash', cashReceived: 30 });
    expect(t.paid).toEqual([{ sale: sales[0], message: 'Payment confirmed - 3 items sold', test: undefined }]);
    expect(cart.lines).toHaveLength(0);
  });

  it('says "1 item" for one', async () => {
    clear();
    addMisc('Print', 20, 1);
    const t = till();
    t.startPayment('cash');
    await t.confirmPayment();
    expect(t.paid[0]!.message).toBe('Payment confirmed - 1 item sold');
  });

  it('cancel closes the sheet and keeps the cart', async () => {
    const t = till();
    t.startPayment('cash');
    await t.cancelPayment();
    expect(t.payment.phase).toBe('idle');
    expect(cart.lines).toHaveLength(2);
    expect(sales).toHaveLength(0);
  });
});

describe('card without a terminal', () => {
  it('is confirmed on screen and recorded as a manual card payment', async () => {
    const t = till({ hasTerminal: false });
    t.startPayment('card');
    expect(t.payment).toMatchObject({ phase: 'confirm', method: 'card' });
    expect(h.requests).toHaveLength(0);
    await t.confirmPayment();
    expect(sales[0]!.payment).toMatchObject({ method: 'card', provider: 'manual' });
  });

  it('records a custom method under its own name', async () => {
    const t = till();
    t.startPayment('Twint');
    expect(t.title.value).toBe('Twint payment');
    await t.confirmPayment();
    expect(sales[0]!.payment).toMatchObject({ method: 'Twint', provider: 'Twint' });
  });
});

describe('card on a terminal', () => {
  it('goes to the terminal and finishes when it approves', async () => {
    const t = till({ hasTerminal: true });
    t.startPayment('card');
    // Still idle while the reader's sign-in is checked.
    expect(t.payment.phase).toBe('idle');
    await tick();
    expect(t.payment.phase).toBe('terminal');
    expect(h.requests).toEqual([expect.objectContaining({ amount: 25, currency: 'EUR' })]);
    h.answer!({ approved: true, provider: 'mypos-go2', txRef: 'T1', cardBrand: 'visa' });
    await tick();
    expect(t.payment.phase).toBe('idle');
    expect(t.paid).toEqual([{ sale: sales[0], message: 'Card approved · visa', test: undefined }]);
    expect(sales[0]!.payment).toMatchObject({ method: 'card', provider: 'mypos-go2', txRef: 'T1' });
  });

  it('a second tap while the reader is checked starts nothing', async () => {
    const t = till({ hasTerminal: true });
    t.startPayment('card');
    t.startPayment('card');
    t.startPayment('cash');
    await tick();
    expect(h.requests).toHaveLength(1);
    expect(t.payment).toMatchObject({ phase: 'terminal', method: 'card' });
    expect(t.toasts).toEqual([]);
  });

  it('shows a decline with its reason, and a retry asks the terminal again', async () => {
    const t = till({ hasTerminal: true });
    t.startPayment('card');
    await tick();
    h.answer!({ approved: false, provider: 'mypos-go2', error: 'Insufficient funds' });
    await tick();
    expect(t.payment).toMatchObject({ phase: 'failed', error: 'Insufficient funds' });
    expect(sales).toHaveLength(0);
    expect(cart.lines).toHaveLength(2);

    await t.retryCard();
    expect(t.payment.phase).toBe('terminal');
    await tick();
    expect(h.requests).toHaveLength(2);
    h.answer!({ approved: true, provider: 'mypos-go2' });
    await tick();
    expect(t.paid.map((p) => p.message)).toEqual(['Card approved']);
  });

  it('falls back to a plain message when the terminal gives no reason', async () => {
    const t = till({ hasTerminal: true });
    t.startPayment('card');
    await tick();
    h.answer!({ approved: false, provider: 'mypos-go2' });
    await tick();
    expect(t.payment).toMatchObject({ phase: 'failed', error: 'The payment was declined.' });
  });

  it('a failed card can be completed by hand', async () => {
    const t = till({ hasTerminal: true });
    t.startPayment('card');
    await tick();
    h.answer!({ approved: false, provider: 'mypos-go2', error: 'Declined' });
    await tick();
    await t.completeByHand();
    expect(t.payment).toMatchObject({ phase: 'confirm', method: 'card' });
    await t.confirmPayment();
    expect(h.requests).toHaveLength(1);
    expect(sales[0]!.payment).toMatchObject({ method: 'card', provider: 'manual' });
  });

  it('cancel while the terminal works closes the sheet; its late answer records nothing', async () => {
    const t = till({ hasTerminal: true });
    t.startPayment('card');
    await tick();
    await t.cancelPayment();
    expect(h.cancels).toBe(1);
    expect(t.payment.phase).toBe('idle');
    await tick();
    expect(t.paid).toEqual([]);
    expect(sales).toHaveLength(0);
    expect(cart.lines).toHaveLength(2);
    expect(cart.busy).toBe(false);
  });

  it('a reader that is not signed in gets the sign-in screen, and goes on once connected', async () => {
    let signedIn = false;
    const configure = vi.fn(async () => void (signedIn = true));
    const reader: PaymentProvider = { ...terminal, label: 'SumUp', needsLogin: async () => !signedIn, configure };
    const t = till({ hasTerminal: true, provider: reader });
    t.startPayment('card');
    await tick();
    expect(t.payment.phase).toBe('needsLogin');
    expect(h.requests).toHaveLength(0);
    await t.connectReader();
    expect(configure).toHaveBeenCalledOnce();
    expect(t.refreshTerminalStatus).toHaveBeenCalledOnce();
    expect(t.payment.phase).toBe('terminal');
    await tick();
    expect(h.requests).toHaveLength(1);
  });

  it('stays on the sign-in screen when signing in did not work', async () => {
    const reader: PaymentProvider = { ...terminal, label: 'SumUp', needsLogin: async () => true, configure: async () => undefined };
    const t = till({ hasTerminal: true, provider: reader });
    t.startPayment('card');
    await tick();
    await t.connectReader();
    expect(t.payment.phase).toBe('needsLogin');
    expect(t.toasts).toEqual([['Still not signed in to SumUp', 'bad']]);
  });
});

describe('split', () => {
  it('needs the two parts to add up before it can be confirmed', () => {
    const t = till();
    t.startPayment('split');
    expect(t.splitState.value).toMatchObject({ ok: false, label: 'Remaining', amount: 25 });
    expect(t.confirmDisabled.value).toBe(true);
    t.payment.splitCash = '10';
    t.payment.splitCard = '20';
    expect(t.splitState.value).toMatchObject({ ok: false, label: 'Over by', amount: 5 });
    t.payment.splitCard = '15';
    expect(t.splitState.value).toMatchObject({ ok: true, label: 'Paid', amount: 25 });
    expect(t.confirmDisabled.value).toBe(false);
  });

  it('records both legs, by hand without a terminal', async () => {
    const t = till();
    t.startPayment('split');
    t.payment.splitCash = '10';
    t.payment.splitCard = '15';
    await t.confirmPayment();
    expect(h.requests).toHaveLength(0);
    expect(sales[0]!.payment).toMatchObject({ method: 'split', legs: [{ kind: 'cash', amount: 10 }, { kind: 'card', amount: 15 }] });
    expect(t.paid[0]!.message).toBe('Payment confirmed - 3 items sold');
  });

  it('puts only the card part on the terminal', async () => {
    const t = till({ hasTerminal: true });
    t.startPayment('split');
    expect(t.payment.phase).toBe('confirm');
    t.payment.splitCash = '10';
    t.payment.splitCard = '15';
    const done = t.confirmPayment();
    await tick();
    expect(h.requests).toEqual([expect.objectContaining({ amount: 15 })]);
    expect(cart.busy).toBe(true);
    h.answer!({ approved: true, provider: 'mypos-go2' });
    await done;
    expect(sales).toHaveLength(1);
    expect(t.paid).toHaveLength(1);
  });

  it('a declined card part leaves the sheet open with the reason as a toast', async () => {
    const t = till({ hasTerminal: true });
    t.startPayment('split');
    t.payment.splitCash = '10';
    t.payment.splitCard = '15';
    const done = t.confirmPayment();
    await tick();
    h.answer!({ approved: false, provider: 'mypos-go2', error: 'Declined' });
    await done;
    expect(t.payment.phase).toBe('confirm');
    expect(t.toasts).toEqual([['Declined', 'bad']]);
    expect(sales).toHaveLength(0);
  });
});

describe('give away', () => {
  it('is what a cart that comes to nothing is completed with', async () => {
    const t = till();
    expect(t.givesAway.value).toBe(false);
    setCustomDiscount({ type: 'percent', value: 100, name: 'Given away' });
    expect(t.givesAway.value).toBe(true);
    t.startPayment(GIVEN_AWAY);
    expect(t.title.value).toBe('Give away');
    expect(t.payment).toMatchObject({ phase: 'confirm', total: 0 });
    await t.confirmPayment();
    expect(t.paid[0]!.message).toBe('Given away - 3 items');
    expect(sales[0]!.payment).toMatchObject({ method: GIVEN_AWAY, legs: [] });
  });

  it('a cart with a price cannot be given away', async () => {
    const t = till();
    t.startPayment(GIVEN_AWAY);
    await t.confirmPayment();
    expect(sales).toHaveLength(0);
    expect(t.toasts).toEqual([['Only a sale that comes to nothing can be given away.', 'bad']]);
  });
});

describe('sending the log from a failed payment', () => {
  it('sends it once asked, and a new payment offers it again', async () => {
    const t = till();
    await t.sendLog();
    expect(sentLogs).toEqual(['payment-failed']);
    expect(t.logSent.value).toBe(true);
    expect(t.sendingLog.value).toBe(false);
    t.startPayment('cash');
    expect(t.logSent.value).toBe(false);
  });
});
