import { computed, reactive } from 'vue';
import type { SaleEvent, SaleLine } from '@zollify/sdk';
import { round2, toLocalPrice } from '@zollify/shared';
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
  /** What the customer is charged in. Equals baseCurrency unless the event converts. */
  currency: string;
  /** The event's own currency, which the books are kept in. */
  baseCurrency: string;
  /** 1 base = this many of `currency`. null when not converting. */
  exchangeRate: number | null;
  roundingIncrement: number;
  eventId: string | null;
  busy: boolean;
  /** A one-off discount the seller applies by hand, on top of any rules. */
  custom: CustomDiscount | null;
}

export const cart = reactive<CartState>({
  lines: [],
  currency: 'CHF',
  baseCurrency: 'CHF',
  exchangeRate: null,
  roundingIncrement: 0,
  eventId: null,
  busy: false,
  custom: null,
});

export const isConverting = computed(
  () => cart.exchangeRate !== null && cart.currency !== cart.baseCurrency,
);

/**
 * Converts a base amount into what the customer is actually charged.
 *
 * Rounding happens on the converted figure, not the base one — a booth in
 * Sweden charges round kronor, and rounding before conversion would produce
 * awkward numbers on the terminal.
 */
export function toCharged(baseAmount: number): number {
  if (!isConverting.value || cart.exchangeRate === null) return round2(baseAmount);
  return toLocalPrice(baseAmount, cart.exchangeRate, cart.roundingIncrement);
}

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
/** Owed in the event's base currency — this is the figure the books use. */
export const baseTotal = computed(() => totals.value.grandTotal);

/** Owed in the currency the customer pays in. */
export const total = computed(() => toCharged(baseTotal.value));
export const appliedDiscounts = computed(() => totals.value.ruleDiscounts);

export const itemCount = computed(() => cart.lines.reduce((n, l) => n + l.qty, 0));
export const isEmpty = computed(() => cart.lines.length === 0);

let lineSeq = 0;

// lineTotal is not asked for: the cart derives it, and only the distributed
// figure computed at checkout is meaningful anyway.
export function addLine(
  line: Omit<SaleLine, 'taxRate' | 'lineTotal'> & {
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
    lineTotal: (Math.round(line.unitPrice * 100) * line.qty) / 100,
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

export interface CheckoutPayment {
  /** cash · card · split · or a custom method name (TWINT, PayPal QR…). */
  method: string;
  /** Present for a split; otherwise one leg for the whole amount is implied. */
  legs?: { kind: 'cash' | 'card'; amount: number; provider?: string }[];
  /** Cash handed over, when counted. */
  cashReceived?: number;
  /** Take the card on the configured terminal rather than recording it by hand. */
  terminal?: { providerId: string };
}

/** Units of an item already on the ticket. */
export function inCart(productId: string, variantId: string | null = null): number {
  return cart.lines.filter((l) => l.productId === productId && (l.variantId ?? null) === variantId).reduce((n, l) => n + l.qty, 0);
}

/** A one-off item that is not in the catalogue: no stock, no rule discounts. */
export function addMisc(title: string, unitPrice: number, qty: number): void {
  cart.lines.push({
    lineId: `l${++lineSeq}`,
    productId: `misc:${crypto.randomUUID()}`,
    variantId: null,
    variantLabel: null,
    sku: null,
    name: title.trim() || 'Misc item',
    qty,
    unitPrice,
    lineTotal: (Math.round(unitPrice * 100) * qty) / 100,
    taxRate: null,
  });
}

/**
 * Records the sale and, on approval, announces it.
 *
 * Cash, split and custom methods are the seller's word — confirmed on screen,
 * never through a device. Card goes to the terminal when one is configured;
 * with none, it is the seller's word too.
 *
 * The `sale` event is the entire contract between POS and anything that cares
 * about revenue — core records it, Tax books it, and neither imports this
 * module. The cart is only cleared after the event is emitted, so a subscriber
 * that throws cannot leave a paid-for basket silently discarded.
 */
export async function checkout(saleId: string, pay: CheckoutPayment): Promise<CheckoutOutcome> {
  if (isEmpty.value) return { approved: false, error: 'The cart is empty.' };
  if (cart.busy) return { approved: false, error: 'A payment is already in progress.' };

  const charged = total.value;
  const base = baseTotal.value;
  if (charged <= 0) return { approved: false, error: 'The total is zero — nothing to charge.' };

  cart.busy = true;
  try {
    let providerName = 'manual';
    let txRef: string | undefined;
    let cardBrand: string | undefined;
    if (pay.terminal) {
      const provider = getProvider(pay.terminal.providerId as never);
      const result = await provider.startPayment({ amount: charged, currency: cart.currency, reference: saleId });
      if (!result.approved) return { approved: false, error: result.error ?? 'The payment was declined.' };
      providerName = result.provider;
      txRef = result.txRef;
      cardBrand = result.cardBrand;
    }

    // Discounts are spread proportionally across the lines so the recorded
    // line totals add up to what was actually paid. Distributed against the
    // base total: line figures stay in the currency the books are kept in.
    const priced = distributeTotal(
      cart.lines.map((line) => ({ ...line, lineTotal: (Math.round(line.unitPrice * 100) * line.qty) / 100 })),
      base,
    );

    const sale: SaleEvent = {
      saleId,
      eventId: cart.eventId,
      at: Date.now(),
      currency: cart.currency,
      total: charged,
      baseCurrency: cart.baseCurrency,
      baseTotal: base,
      exchangeRate: cart.exchangeRate ?? undefined,
      lines: priced.map(({ lineId: _l, variantLabel: _vl, type: _t, ...line }) => line),
      payment: {
        provider: pay.method === 'card' ? providerName : pay.method,
        approved: true,
        method: pay.method,
        legs: pay.legs,
        cashReceived: pay.cashReceived,
        txRef,
        cardBrand,
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
