import { computed, reactive, ref, type Ref } from 'vue';
import type { SalesEvent } from '@zollify/shared';
import { cashShortcutAmounts, round2, splitCashPortionAmounts } from '@zollify/shared';
import type { SaleEvent } from '@zollify/sdk';
import { GIVEN_AWAY, cancelCheckout, cardFx, cardInBase, cardSettlement, checkout, isConverting, itemCount, loadCardFx, loadMarketFx, marketFx, total } from '../cart';
import { singleFlight } from '../lib/single-flight';
import type { PaymentProvider } from '../payments/provider';
import { sdk } from '../runtime';
import { useTillMoney } from './useTillMoney';
import type { Toast } from './useToast';

export type Phase = 'idle' | 'confirm' | 'terminal' | 'failed' | 'needsLogin';
export interface PaymentState {
  phase: Phase;
  method: string;
  total: number;
  cashReceived: string;
  splitCash: string;
  splitCard: string;
  error: string;
}

export interface PaymentFlowDeps {
  toast: Toast;
  activeEvent: Readonly<Ref<SalesEvent | null>>;
  /** Sell 🔒 without force: nothing may be rung up at this event. */
  sellBlocked: Readonly<Ref<boolean>>;
  lockedBy: Readonly<Ref<string>>;
  provider: Readonly<Ref<PaymentProvider>>;
  providerId: Readonly<Ref<string>>;
  hasTerminal: Readonly<Ref<boolean>>;
  refreshTerminalStatus: () => Promise<void>;
  /** The sale went through (or, with `test`, went through the motions): the till takes it from here. */
  onPaid: (sale: SaleEvent, message: string, test?: boolean) => void;
}

/**
 * The payment sheet's state machine: idle -> confirm (cash, split, by hand)
 * or -> terminal -> failed / needsLogin, and back to idle when the sale is
 * recorded or cancelled. The sale itself is cart.ts' checkout().
 */
export function usePaymentFlow({ toast, activeEvent, sellBlocked, lockedBy, provider, providerId, hasTerminal, refreshTerminalStatus, onPaid }: PaymentFlowDeps) {
  const { currency } = useTillMoney();
  const payment = reactive<PaymentState>({ phase: 'idle', method: 'cash', total: 0, cashReceived: '', splitCash: '', splitCard: '', error: '' });

  const cashShortcuts = computed(() => (payment.method === 'cash' ? cashShortcutAmounts(payment.total, currency.value) : []));
  const splitCashShortcuts = computed(() => splitCashPortionAmounts(Math.max(0, payment.total - (Number(payment.splitCard) || 0)), currency.value));
  const change = computed(() => round2((Number(payment.cashReceived) || 0) - payment.total));
  const splitState = computed(() => {
    const cash = Number(payment.splitCash) || 0;
    const card = Number(payment.splitCard) || 0;
    const rem = round2(payment.total - cash - card);
    if (rem > 0.001) return { ok: false, label: 'Remaining', amount: rem, cls: 'bad' };
    if (rem < -0.001) return { ok: false, label: 'Over by', amount: -rem, cls: 'warn' };
    return { ok: cash > 0 || card > 0, label: 'Paid', amount: cash + card, cls: 'good' };
  });
  const confirmDisabled = computed(() => {
    if (payment.method === 'cash') return (Number(payment.cashReceived) || 0) < payment.total - 0.001;
    if (payment.method === 'split') return !splitState.value.ok;
    return false;
  });
  const title = computed(() => ({ cash: 'Cash payment', card: 'Card payment', split: 'Split payment', [GIVEN_AWAY]: 'Give away' })[payment.method] ?? `${payment.method} payment`);
  /** A cart that comes to nothing (a 100% discount): there is nothing to pay, so it is given away instead. */
  const givesAway = computed(() => itemCount.value > 0 && Math.abs(total.value) < 0.005);

  function startPayment(method: string): void {
    // A card payment is already on its way to the terminal (see cardStart).
    if (cardStart.busy) return;
    if (!itemCount.value) return;
    if (!activeEvent.value) return toast('Pick an active event first (Events).', 'bad');
    if (sellBlocked.value) return toast(`Sell 🔒 - ${lockedBy.value} took this event's leftovers.`, 'bad');
    payment.method = method;
    payment.total = total.value;
    payment.cashReceived = payment.total.toFixed(2);
    payment.splitCash = '';
    payment.splitCard = '';
    payment.error = '';
    logSent.value = false;
    // Keep the card rate current through a long day; a stale one still works offline.
    if (method === 'card' && cardInBase.value && Date.now() - cardFx.at > 3_600_000) void loadCardFx();
    // The day's rate recorded with the sale: kept fresh through a long day too.
    if (isConverting.value && Date.now() - marketFx.at > 3_600_000) void loadMarketFx();
    if (method === 'card' && hasTerminal.value) {
      cardStart.run();
      return;
    }
    payment.phase = 'confirm';
  }

  /** A reader that needs an interactive sign-in (SumUp) and isn't signed in gets a connect-or-choose screen instead of a failing terminal call. */
  async function beginCardPayment(): Promise<void> {
    try {
      if (await provider.value.needsLogin?.()) {
        payment.phase = 'needsLogin';
        return;
      }
    } catch {
      /* if the check itself fails, let the terminal report it */
    }
    payment.phase = 'terminal';
    void runTerminal();
  }
  // The sign-in check takes a moment and the pay buttons stay on screen for it.
  // A second tap in that gap would send a second request to the terminal, which
  // refuses it, and the screen would say "failed" over a payment still running.
  const cardStart = singleFlight(beginCardPayment);
  async function connectReader(): Promise<void> {
    const p = provider.value;
    if (!p.configure) return;
    try {
      await p.configure();
    } catch (err) {
      return toast(err instanceof Error ? err.message : String(err), 'bad');
    }
    if (await p.needsLogin?.()) return toast(`Still not signed in to ${p.label}`, 'bad');
    void refreshTerminalStatus();
    payment.phase = 'terminal';
    void runTerminal();
  }

  // ── Support: send the diagnostic log straight from a failed payment ─────────
  const sendingLog = ref(false);
  const logSent = ref(false);
  async function sendLog(): Promise<void> {
    sendingLog.value = true;
    try {
      await sdk().diagnostics.sendLog('payment-failed');
      logSent.value = true;
    } catch (err) {
      toast(`Send failed: ${err instanceof Error ? err.message : String(err)}`, 'bad');
    } finally {
      sendingLog.value = false;
    }
  }

  async function runTerminal(): Promise<void> {
    const outcome = await checkout(crypto.randomUUID(), { method: 'card', terminal: { providerId: providerId.value } });
    if (outcome.cancelled || payment.phase !== 'terminal') return;
    if (outcome.approved) onPaid(outcome.sale!, `Card approved${outcome.sale?.payment.cardBrand ? ` · ${outcome.sale.payment.cardBrand}` : ''}`, outcome.test);
    else {
      payment.error = outcome.error ?? 'Card payment declined';
      payment.phase = 'failed';
    }
  }

  // Leaving a live terminal request behind - for a retry or to record the card
  // by hand - cancels it first, so a late approval can't record a second sale.
  async function retryCard(): Promise<void> {
    await cancelCheckout();
    payment.phase = 'terminal';
    void runTerminal();
  }
  async function completeByHand(): Promise<void> {
    await cancelCheckout();
    payment.phase = 'confirm';
    payment.method = 'card';
  }

  async function confirmPayment(): Promise<void> {
    let legs: { kind: 'cash' | 'card'; amount: number }[] | undefined;
    if (payment.method === 'split') {
      legs = [
        { kind: 'cash' as const, amount: Math.max(0, Number(payment.splitCash) || 0) },
        { kind: 'card' as const, amount: Math.max(0, Number(payment.splitCard) || 0) },
      ]
        .filter((l) => l.amount > 0)
        .map((l) => {
          const settled = l.kind === 'card' ? cardSettlement(l.amount) : null;
          return settled ? { ...l, settled } : l;
        });
    }
    // A split's card leg goes on the terminal when there is one; the Confirm
    // button is disabled while the terminal works (cart.busy) and Cancel aborts it.
    const cardLeg = legs?.find((l) => l.kind === 'card');
    const outcome = await checkout(crypto.randomUUID(), {
      method: payment.method,
      legs,
      cashReceived: payment.method === 'cash' ? Number(payment.cashReceived) || undefined : undefined,
      terminal: hasTerminal.value && cardLeg ? { providerId: providerId.value, amount: cardLeg.amount } : undefined,
    });
    if (outcome.cancelled) return;
    if (!outcome.approved) return toast(outcome.error ?? 'Could not record the sale.', 'bad');
    const count = outcome.sale!.lines.reduce((s, l) => s + l.qty, 0);
    const items = `${count} item${count === 1 ? '' : 's'}`;
    onPaid(outcome.sale!, payment.method === GIVEN_AWAY ? `Given away - ${items}` : `Payment confirmed - ${items} sold`, outcome.test);
  }

  async function cancelPayment(): Promise<void> {
    await cancelCheckout();
    payment.phase = 'idle';
  }

  return {
    payment, cashShortcuts, splitCashShortcuts, change, splitState, confirmDisabled, title, givesAway, sendingLog, logSent,
    startPayment, connectReader, sendLog, retryCard, completeByHand, confirmPayment, cancelPayment,
  };
}
export type PaymentFlow = ReturnType<typeof usePaymentFlow>;
