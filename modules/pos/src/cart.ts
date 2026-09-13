import { computed, reactive } from 'vue';
import type { SaleEvent, SaleLine } from '@boothly/sdk';
import { round2 } from '@boothly/shared';
import { getProvider } from './payments/registry';
import { sdk } from './runtime';
import {
  computeCartTotals,
  distributeTotal,
  type CartLine as DiscountCartLine,
  type CustomDiscount,
} from './discounts';

export interface CartLine extends SaleLine {
  lineId: string;
  /** Variant key, or null for the product itself. */
  variantId: string | null;
  variantLabel: string | null;
  /** Product.type — some discount rules target a whole type rather than ids. */
  type?: string;
}

interface CartState {
  lines: CartLine[];
  currency: string;
  eventId: string | null;
  busy: boolean;
  /** A one-off discount the seller applies by hand, on top of any rules. */
  custom: CustomDiscount | null;
}

export const cart = reactive<CartState>({
  lines: [],
  currency: 'CHF',
  eventId: null,
  busy: false,
  custom: null,
});

/**
 * Lines in the shape the discount engine expects.
 *
 * Line totals are computed in integer minor units and converted back once.
 * Accumulating floats across a basket is how a till ends up a rappen out on a
 * long receipt, and that difference is exactly what gets noticed at cash-up.
 */
const discountLines = computed<DiscountCartLine[]>(() =>
  cart.lines.map((line) => ({
    pid: line.productId,
    vid: line.variantId,
    title: line.name,
    variantLabel: line.variantLabel,
    type: line.type,
    qty: line.qty,
    unitPrice: line.unitPrice,
    lineTotal: (Math.round(line.unitPrice * 100) * line.qty) / 100,
  })),
);

/**
 * Subtotal, rule discounts, manual discount and the amount actually owed.
 *
 * Rules come from core through the SDK, so a rule edited in Settings applies at
 * the next keystroke without POS holding its own copy.
 */
export const totals = computed(() =>
  computeCartTotals(discountLines.value, sdk().data.discounts.active(), cart.custom),
);

export const subtotal = computed(() => totals.value.subtotal);
export const discountTotal = computed(
  () => round2(totals.value.ruleDiscountTotal + totals.value.customDiscountAmount),
);
export const total = computed(() => totals.value.grandTotal);
export const appliedDiscounts = computed(() => totals.value.ruleDiscounts);

export const itemCount = computed(() => cart.lines.reduce((n, l) => n + l.qty, 0));
export const isEmpty = computed(() => cart.lines.length === 0);

let lineSeq = 0;

export function addLine(
  line: Omit<SaleLine, 'taxRate'> & {
    taxRate?: number | null;
    variantId?: string | null;
    variantLabel?: string | null;
    type?: string;
  },
): void {
  const variantId = line.variantId ?? null;
  const existing = cart.lines.find(
    (l) => l.productId === line.productId && l.variantId === variantId && l.unitPrice === line.unitPrice,
  );
  if (existing) {
    existing.qty += line.qty;
    return;
  }
  cart.lines.push({
    ...line,
    variantId,
    variantLabel: line.variantLabel ?? null,
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

export function setCustomDiscount(discount: CustomDiscount | null): void {
  cart.custom = discount;
}

export function clear(): void {
  cart.lines.length = 0;
  cart.custom = null;
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
 * about revenue — core records it, Tax books it, and neither imports this
 * module. The cart is only cleared after the event is emitted, so a subscriber
 * that throws cannot leave a paid-for basket silently discarded.
 */
export async function checkout(providerId: string, saleId: string): Promise<CheckoutOutcome> {
  if (isEmpty.value) return { approved: false, error: 'The cart is empty.' };
  if (cart.busy) return { approved: false, error: 'A payment is already in progress.' };

  const charged = total.value;
  if (charged <= 0) {
    return { approved: false, error: 'The total is zero — nothing to charge.' };
  }

  cart.busy = true;
  try {
    const provider = getProvider(providerId as never);
    const result = await provider.startPayment({
      amount: charged,
      currency: cart.currency,
      reference: saleId,
    });

    if (!result.approved) {
      return { approved: false, error: result.error ?? 'The payment was declined.' };
    }

    // Discounts are spread proportionally across the lines so the recorded
    // line totals add up to what was actually paid. Without this a discounted
    // basket reconciles to the wrong number line by line.
    const priced = distributeTotal(
      cart.lines.map((line) => ({
        ...line,
        lineTotal: (Math.round(line.unitPrice * 100) * line.qty) / 100,
      })),
      charged,
    );

    const sale: SaleEvent = {
      saleId,
      eventId: cart.eventId,
      at: Date.now(),
      currency: cart.currency,
      total: charged,
      lines: priced.map(
        ({ lineId: _l, variantId: _v, variantLabel: _vl, type: _t, lineTotal: _lt, ...line }) => line,
      ),
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
