import { computed, reactive } from 'vue';
import type { SaleEvent, SaleLine } from '@boothly/sdk';
import { getProvider } from './payments/registry';
import { sdk } from './runtime';

export interface CartLine extends SaleLine {
  lineId: string;
}

interface CartState {
  lines: CartLine[];
  currency: string;
  eventId: string | null;
  busy: boolean;
}

export const cart = reactive<CartState>({
  lines: [],
  currency: 'CHF',
  eventId: null,
  busy: false,
});

/**
 * Totals are computed in integer minor units and converted back once.
 * Accumulating floats across a basket is how a till ends up a rappen out on a
 * long receipt, and that difference is exactly what gets noticed at cash-up.
 */
export const totalMinor = computed(() =>
  cart.lines.reduce((sum, line) => sum + Math.round(line.unitPrice * 100) * line.qty, 0),
);

export const total = computed(() => totalMinor.value / 100);
export const itemCount = computed(() => cart.lines.reduce((n, l) => n + l.qty, 0));
export const isEmpty = computed(() => cart.lines.length === 0);

let lineSeq = 0;

export function addLine(line: Omit<SaleLine, 'taxRate'> & { taxRate?: number | null }): void {
  const existing = cart.lines.find(
    (l) => l.productId === line.productId && l.unitPrice === line.unitPrice,
  );
  if (existing) {
    existing.qty += line.qty;
    return;
  }
  cart.lines.push({
    ...line,
    taxRate: line.taxRate ?? null,
    lineId: `l${++lineSeq}`,
  });
}

export function setQty(lineId: string, qty: number): void {
  const line = cart.lines.find((l) => l.lineId === lineId);
  if (!line) return;
  if (qty <= 0) {
    removeLine(lineId);
    return;
  }
  line.qty = qty;
}

export function removeLine(lineId: string): void {
  const i = cart.lines.findIndex((l) => l.lineId === lineId);
  if (i >= 0) cart.lines.splice(i, 1);
}

export function clear(): void {
  cart.lines.length = 0;
}

export interface CheckoutOutcome {
  approved: boolean;
  error?: string;
  sale?: SaleEvent;
}

/**
 * Takes payment through the selected provider and, on approval, announces the
 * sale.
 *
 * The `sale` event is the entire contract between POS and anything that cares
 * about revenue — Tax subscribes to it and never imports this module. The cart
 * is only cleared after the event is emitted, so a subscriber that throws
 * cannot leave a paid-for basket silently discarded.
 */
export async function checkout(providerId: string, saleId: string): Promise<CheckoutOutcome> {
  if (isEmpty.value) return { approved: false, error: 'The cart is empty.' };
  if (cart.busy) return { approved: false, error: 'A payment is already in progress.' };

  cart.busy = true;
  try {
    const provider = getProvider(providerId as never);
    const result = await provider.startPayment({
      amount: total.value,
      currency: cart.currency,
      reference: saleId,
    });

    if (!result.approved) {
      return { approved: false, error: result.error ?? 'The payment was declined.' };
    }

    const sale: SaleEvent = {
      saleId,
      eventId: cart.eventId,
      at: Date.now(),
      currency: cart.currency,
      total: total.value,
      lines: cart.lines.map(({ lineId: _lineId, ...line }) => line),
      payment: {
        provider: result.provider,
        approved: true,
        txRef: result.txRef,
        cardBrand: result.cardBrand,
      },
    };

    sdk().events.emit('sale', sale);
    clear();
    return { approved: true, sale };
  } catch (err) {
    return { approved: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    cart.busy = false;
  }
}
