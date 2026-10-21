import { computed, reactive, ref } from 'vue';
import type { SaleEvent, SaleLine, SaleLineRef, TillLine, TillLineInfo } from '@zollify/sdk';
import type { CardSettlement, SalesEvent } from '@zollify/shared';
import { round2, toLocalPrice } from '@zollify/shared';
import { getProvider } from './payments/registry';
import { testTerminalProvider } from './payments/test-terminal';
import type { PaymentProvider, PaymentResult } from './payments/provider';
import { logDiagnostic } from './lib/diagnostics';
import { sdk } from './runtime';
import { mintReceiptToken, saleTaxFor } from './lib/after-sale';
import {
  allocateDiscounts,
  applySettlements,
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
  /** Product.type - some discount rules target a whole type rather than ids. */
  type?: string;
  /** Added by another module (a workshop place, say): its quantity is not the seller's to change. */
  fixed?: boolean;
  /** That module's key for the line, so the same thing is never added twice. */
  key?: string;
  /** Outside VAT whatever the event charges (a voucher sold): recorded with no rate. */
  taxFree?: boolean;
  /**
   * Money paid earlier, spent on this sale (a gift card). Kept as a negative
   * unit price; no discount reaches it, and at checkout it records only what
   * it covered - see applySettlements.
   */
  settles?: boolean;
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
  /** A one-off discount the seller applies by hand, on top of any rules. An amount is in the charge currency. */
  custom: CustomDiscount | null;
  /** Per-event local prices set under Prices, keyed "pid:vid" ('' for the product). */
  priceOverrides: Record<string, number>;
  /** Per-event local bundle totals, keyed "ruleId:tierIndex" or "ruleId:combo". */
  tierOverrides: Record<string, number>;
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
  priceOverrides: {},
  tierOverrides: {},
});

export const isConverting = computed(
  () => cart.exchangeRate !== null && cart.currency !== cart.baseCurrency,
);

/**
 * "Charge cards in the base currency" (Settings → Card terminal). At an event that
 * prices in a local currency, cards are still taken in the base currency, at
 * today's market rate - a German booth in Switzerland sells a 30 € painting
 * for 30 CHF, and the card is charged 32.15 EUR. Cash stays in the local
 * currency. `rate` is the market rate, 1 base = rate local - never the
 * event's own pricing rate, which can be a deliberate round 1:1.
 */
export const CARD_IN_BASE_KEY = 'cardInBaseCurrency';

/**
 * Test mode: the till runs every step of a sale - cart, discounts, the card
 * on a pretend terminal, the receipt screen - and records nothing. No
 * transaction, no stock movement, no books, nothing synced. For trying the
 * till out, training a helper, or checking a receipt layout, without a
 * refund to make afterwards. Device-local and switched on by hand, with a
 * banner on the till for as long as it is on.
 */
export const TEST_MODE_KEY = 'testMode';
export const testMode = ref(false);
export async function loadTestMode(): Promise<boolean> {
  testMode.value = (await sdk().config.get<boolean>(TEST_MODE_KEY)) ?? false;
  return testMode.value;
}
export async function setTestMode(on: boolean): Promise<void> {
  testMode.value = on;
  await sdk().config.set(TEST_MODE_KEY, on);
}
export const cardFx = reactive({ enabled: false, rate: null as number | null, at: 0 });
/**
 * The day's market rate for a converted sale (base -> charged), recorded with
 * each sale so its base value is what the money was worth that day. Fetched
 * with the card rate; a rate older than MARKET_RATE_MAX_AGE is not recorded -
 * the sale is then valued at its date's rate later.
 */
export const marketFx = reactive({ rate: null as number | null, at: 0, pair: '' });
const MARKET_RATE_MAX_AGE = 3 * 86400000;
export async function loadMarketFx(): Promise<void> {
  const pair = `${cart.baseCurrency}:${cart.currency}`;
  // A rate for another currency pair must never be recorded with this one's sales.
  if (marketFx.pair !== pair) Object.assign(marketFx, { rate: null, at: 0, pair });
  if (!isConverting.value) return;
  try {
    const latest = await sdk().fx?.latest(cart.baseCurrency, cart.currency);
    if (latest && marketFx.pair === pair) Object.assign(marketFx, latest);
  } catch {
    /* none - the sale is valued at its date's rate later */
  }
}
const marketRateNow = (): { rate: number; at: number } | null =>
  marketFx.pair === `${cart.baseCurrency}:${cart.currency}` && marketFx.rate && Date.now() - marketFx.at < MARKET_RATE_MAX_AGE
    ? { rate: marketFx.rate, at: marketFx.at }
    : null;
export const cardInBase = computed(() => cardFx.enabled && isConverting.value);

/**
 * Points the cart at the till's event: where its sales are recorded, in which
 * currency, at which rate and local prices. Called when POS opens and again
 * whenever the till moves to another event (Sell at …, the automatic switch),
 * so a sale is never filed under the event the till just left.
 */
export function setCartEvent(event: SalesEvent | null, fallbackCurrency: string): void {
  const base = event?.currency ?? fallbackCurrency;
  const converting = Boolean(event?.localCurrency && event.exchangeRate);
  const currency = converting ? event!.localCurrency! : base;
  // A card rate for another currency pair must not carry over.
  if (currency !== cart.currency || base !== cart.baseCurrency) Object.assign(cardFx, { rate: null, at: 0 });
  cart.eventId = event?.id ?? null;
  cart.baseCurrency = base;
  cart.currency = currency;
  cart.exchangeRate = converting ? (event!.exchangeRate ?? null) : null;
  cart.roundingIncrement = event?.roundingIncrement ?? 0;
  cart.priceOverrides = { ...(event?.localPriceOverrides ?? {}) };
  cart.tierOverrides = { ...(event?.localTierOverrides ?? {}) };
}

/** Reads the setting and, when it applies, today's rate (or the last one this device saw, offline). */
export async function loadCardFx(): Promise<void> {
  void loadMarketFx();
  cardFx.enabled = (await sdk().config.get<boolean>(CARD_IN_BASE_KEY)) ?? false;
  if (!cardInBase.value) return;
  try {
    // Optional chaining: a shell older than this module has no fx.
    const latest = await sdk().fx?.latest(cart.baseCurrency, cart.currency);
    if (latest) Object.assign(cardFx, latest);
  } catch {
    /* no rate - a card checkout says so */
  }
}

/** What a local-currency amount comes to on the card, in the base currency. Null when not charging cards in base. */
export function cardSettlement(localAmount: number): CardSettlement | null {
  if (!cardInBase.value || !cardFx.rate) return null;
  return { amount: round2(localAmount / cardFx.rate), currency: cart.baseCurrency, rate: cardFx.rate };
}

/**
 * Converts a base amount into what the customer is actually charged.
 *
 * Rounding happens on the converted figure, not the base one - a booth in
 * Sweden charges round kronor, and rounding before conversion would produce
 * awkward numbers on the terminal.
 */
export function toCharged(baseAmount: number): number {
  if (!isConverting.value || cart.exchangeRate === null) return round2(baseAmount);
  return toLocalPrice(baseAmount, cart.exchangeRate, cart.roundingIncrement);
}

/** What one catalogue line is charged: the event's override when set, else converted and rounded. */
export function localPrice(productId: string, variantId: string | null, basePrice: number): number {
  if (!isConverting.value) return round2(basePrice);
  const override = cart.priceOverrides[`${productId}:${variantId ?? ''}`];
  return override != null ? override : toCharged(basePrice);
}

function localTierTotal(ruleId: string, index: number | string, baseTotal: number): number {
  const override = cart.tierOverrides[`${ruleId}:${index}`];
  return override != null ? override : toCharged(baseTotal);
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
    // Read live from the catalogue, so a cart started before an artist's
    // discount began still gets it.
    consignorId: sdk().data.products.get(line.productId)?.consignorId,
    qty: line.qty,
    // A settling line is not goods: nothing for a discount to match or share.
    unitPrice: line.settles ? 0 : line.unitPrice,
    lineTotal: line.settles ? 0 : (Math.round(line.unitPrice * 100) * line.qty) / 100,
  })),
);

/**
 * Subtotal, rule discounts, manual discount and the amount actually owed.
 *
 * Rules come from core through the SDK, so a rule edited in Settings applies at
 * the next keystroke without POS holding its own copy.
 */
const rate = computed(() => (isConverting.value && cart.exchangeRate ? cart.exchangeRate : 1));

/** The manual discount in base currency - an amount was typed in the charge currency. */
const baseCustom = computed<CustomDiscount | null>(() =>
  cart.custom && cart.custom.type === 'amount' ? { ...cart.custom, value: round2(cart.custom.value / rate.value) } : cart.custom,
);

export const totals = computed(() =>
  computeCartTotals(discountLines.value, sdk().data.discounts.active(), baseCustom.value),
);

/**
 * The charge layer, ported from ZollTool: discounts are computed directly
 * against the local (override-aware) line prices and local bundle totals,
 * not by scaling the base-currency figure - so a bundle price set under
 * Prices lands exactly at checkout instead of drifting through rounding.
 */
const chargeLines = computed<DiscountCartLine[]>(() =>
  discountLines.value.map((l) => {
    const unitPrice = localPrice(l.pid, l.vid, l.unitPrice);
    return { ...l, unitPrice, lineTotal: (Math.round(unitPrice * 100) * l.qty) / 100 };
  }),
);
const localRules = computed(() =>
  sdk().data.discounts.active().map((rule) => {
    if (rule.type === 'tiered' && rule.tiers?.length) return { ...rule, tiers: rule.tiers.map((t, i) => ({ ...t, total: localTierTotal(rule.id, i, t.total) })) };
    if (rule.type === 'combo' && rule.comboDiscountAmount != null) return { ...rule, comboDiscountAmount: localTierTotal(rule.id, 'combo', rule.comboDiscountAmount) };
    return rule;
  }),
);
export const chargeTotals = computed(() => (isConverting.value ? computeCartTotals(chargeLines.value, localRules.value, cart.custom) : totals.value));

export const subtotal = computed(() => totals.value.subtotal);
export const discountTotal = computed(
  () => round2(totals.value.ruleDiscountTotal + totals.value.customDiscountAmount),
);
/**
 * What each settling line (a gift card spent) brings, in cart order, and how
 * much of it the sale actually uses: never more than the goods come to after
 * discounts, so a card worth more than the sale keeps the rest.
 */
const settling = computed(() => cart.lines.map((l) => (l.settles ? round2(Math.abs(l.unitPrice) * l.qty) : 0)));
const appliedBase = computed(() => applySettlements(settling.value, totals.value.grandTotal));
const appliedCharged = computed(() => applySettlements(settling.value.map((a) => toCharged(a)), chargeTotals.value.grandTotal));
/** Paid earlier and spent on this sale, as charged - the part of the goods no payment is taken for. */
export const settledTotal = computed(() => round2(appliedCharged.value.reduce((s, a) => s + a, 0)));

/** Owed in the event's base currency - this is the figure the books use. */
export const baseTotal = computed(() => round2(totals.value.grandTotal - appliedBase.value.reduce((s, a) => s + a, 0)));

/** Owed in the currency the customer pays in. */
export const total = computed(() => round2(chargeTotals.value.grandTotal - settledTotal.value));
/** Rule discounts as charged, in the charge currency. */
export const appliedDiscounts = computed(() => chargeTotals.value.ruleDiscounts);
/** The manual discount as charged. */
export const customDiscountCharged = computed(() => chargeTotals.value.customDiscountAmount);

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
  if (line.fixed && qty > 0) return;
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
  /** Test mode: the sale went through the motions and was not recorded anywhere. */
  test?: boolean;
  /** The seller abandoned this attempt (cancelCheckout) - nothing was recorded, whatever the terminal answered. */
  cancelled?: boolean;
}

export interface CheckoutPayment {
  /** cash · card · split · or a custom method name (TWINT, PayPal QR…). */
  method: string;
  /** Present for a split; otherwise one leg for the whole amount is implied. */
  legs?: { kind: 'cash' | 'card'; amount: number; provider?: string; settled?: CardSettlement }[];
  /** Cash handed over, when counted. */
  cashReceived?: number;
  /** Take the card on the configured terminal rather than recording it by hand. `amount` is a split's card leg; absent, the whole sale goes on the card. */
  terminal?: { providerId: string; amount?: number };
}

// Each checkout is one attempt; cancelCheckout() bumps the counter so an
// attempt whose terminal answers after the seller gave up on it (Cancel,
// "Complete by hand", retry) can no longer record the sale.
let attempt = 0;
let activeProvider: PaymentProvider | null = null;

/** Abandons the terminal request in flight, if any. Safe to call when nothing is pending. */
export async function cancelCheckout(): Promise<void> {
  attempt++;
  const provider = activeProvider;
  activeProvider = null;
  if (provider) await provider.cancel().catch(() => {});
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
 * A line another module put on the till - a workshop place, a booking. Not a
 * catalogue item: no stock, and no rule discounts reach it (they match
 * catalogue products only), though a manual discount still spreads over it.
 * The same key twice keeps one line.
 */
export function addModuleLine(line: Omit<TillLine, 'ref'> & { ref?: SaleLineRef }): boolean {
  if (cart.lines.some((l) => l.key === line.key)) return true;
  // A settling line is money coming off the sale: kept negative, so the cart
  // and the sale record read the way a receipt does.
  const unitPrice = line.settles ? -Math.abs(line.unitPrice) : line.unitPrice;
  cart.lines.push({
    lineId: `l${++lineSeq}`,
    productId: `module:${line.key}`,
    variantId: null,
    variantLabel: null,
    sku: null,
    name: line.name,
    qty: line.qty,
    unitPrice,
    lineTotal: (Math.round(unitPrice * 100) * line.qty) / 100,
    taxRate: null,
    fixed: true,
    key: line.key,
    ...(line.taxFree || line.settles ? { taxFree: true } : {}),
    ...(line.settles ? { settles: true } : {}),
    ...(line.consignorId ? { consignorId: line.consignorId } : {}),
    ...(typeof line.commissionPct === 'number' ? { commissionPct: line.commissionPct } : {}),
    ...(line.ref ? { ref: line.ref } : {}),
  });
  return true;
}

/** The line a module added under `key`, for that module to read back. */
export function findModuleLine(key: string): (TillLineInfo & { ref?: SaleLineRef }) | null {
  const l = cart.lines.find((x) => x.key === key);
  // A settling line reads back as the amount it applies, the way it was given.
  return l ? { key, name: l.name, qty: l.qty, unitPrice: l.settles ? Math.abs(l.unitPrice) : l.unitPrice, ...(l.ref ? { ref: l.ref } : {}) } : null;
}

/** Changes what a module's line charges, in place. False when the cart has no line under that key. */
export function replaceModuleLine(line: Omit<TillLine, 'ref'>): boolean {
  const l = cart.lines.find((x) => x.key === line.key);
  if (!l) return false;
  l.name = line.name;
  l.qty = line.qty;
  l.unitPrice = l.settles ? -Math.abs(line.unitPrice) : line.unitPrice;
  l.lineTotal = (Math.round(l.unitPrice * 100) * line.qty) / 100;
  return true;
}

/**
 * Records the sale and, on approval, announces it.
 *
 * Cash, split and custom methods are the seller's word - confirmed on screen,
 * never through a device. Card goes to the terminal when one is configured;
 * with none, it is the seller's word too.
 *
 * The `sale` event is the entire contract between POS and anything that cares
 * about revenue - core records it, Tax books it, and neither imports this
 * module. The cart is only cleared after the event is emitted, so a subscriber
 * that throws cannot leave a paid-for basket silently discarded.
 */
export async function checkout(saleId: string, pay: CheckoutPayment): Promise<CheckoutOutcome> {
  if (isEmpty.value) return { approved: false, error: 'The cart is empty.' };
  if (cart.busy) return { approved: false, error: 'A payment is already in progress.' };
  // Checked against the event the sale is recorded on, not only the banner's.
  const lock = cart.eventId ? sdk().data.events.sellLock(cart.eventId) : null;
  if (lock && !lock.forced) return { approved: false, error: `Sell 🔒 - ${lock.by.map((e) => e.name).join(', ')} took this event's leftovers.` };

  const charged = total.value;
  const base = baseTotal.value;
  // Nothing to take - unless money paid earlier (a gift card) covers goods that are in the cart.
  const covered = charged <= 0 && settledTotal.value > 0 && chargeTotals.value.grandTotal > 0;
  if (charged <= 0 && !covered) return { approved: false, error: 'The total is zero - nothing to charge.' };

  cart.busy = true;
  const thisAttempt = ++attempt;
  try {
    let providerName = 'manual';
    let txRef: string | undefined;
    let cardBrand: string | undefined;
    if ((pay.method === 'card' || pay.terminal) && cardInBase.value && !cardFx.rate) await loadCardFx();
    const settled = pay.method === 'card' ? cardSettlement(charged) : null;
    if (pay.terminal) {
      // A split only puts its card leg on the terminal; that leg's own
      // settlement figure travels in pay.legs, so the sale record stays as is.
      const onCard = pay.terminal.amount ?? charged;
      const onCardSettled = cardSettlement(onCard);
      if (cardInBase.value && !onCardSettled) {
        return { approved: false, error: `No ${cart.baseCurrency}/${cart.currency} exchange rate on this device yet - go online once, or turn off charging cards in ${cart.baseCurrency} under Settings → Card terminal.` };
      }
      // In test mode every card goes to the pretend terminal, whatever is configured.
      const provider = testMode.value ? testTerminalProvider : getProvider(pay.terminal.providerId as never);
      activeProvider = provider;
      const result = await provider
        .startPayment(
          onCardSettled
            ? { amount: onCardSettled.amount, currency: onCardSettled.currency, reference: saleId }
            : { amount: onCard, currency: cart.currency, reference: saleId },
        )
        .catch((err: unknown): PaymentResult => ({ approved: false, provider: provider.id, error: err instanceof Error ? err.message : String(err) }));
      if (thisAttempt !== attempt) {
        if (result.approved) logDiagnostic(`Terminal approved sale ${saleId} after the seller cancelled it - not recorded (txRef=${result.txRef ?? '-'})`);
        return { approved: false, cancelled: true, error: 'Cancelled' };
      }
      if (!result.approved) return { approved: false, error: result.error ?? 'The payment was declined.' };
      providerName = result.provider;
      txRef = result.txRef;
      cardBrand = result.cardBrand;
    }

    // Each discount lands on the lines it belongs to - a rule's on the lines
    // it matched, a one-off one on the whole sale - in whole units where the
    // amounts are whole (allocateDiscounts). Line totals stay in the currency
    // the books are kept in; the charged currency's split goes on asCharged.
    const baseShares = allocateDiscounts(discountLines.value, totals.value);
    const chargeShares = allocateDiscounts(chargeLines.value, chargeTotals.value);
    const usedBase = appliedBase.value;
    const usedCharged = appliedCharged.value;
    const priced = cart.lines.map((line, i) => ({
      ...line,
      // A settling line records what it actually covered, as a negative amount.
      lineTotal: line.settles ? -usedBase[i]! : round2((Math.round(line.unitPrice * 100) * line.qty) / 100 - baseShares[i]!),
    }));
    // Safety net: if the split ever disagrees with the total (a discount
    // capped at a line's value, the total floored at zero), fall back to
    // spreading the difference so the lines still add up to what was paid.
    // Over the goods only: a settling line is already exactly what it covered.
    const goods = priced.filter((l) => !l.settles);
    if (Math.abs(goods.reduce((sum, l) => sum + l.lineTotal, 0) - totals.value.grandTotal) > 0.001) distributeTotal(goods, totals.value.grandTotal);

    const tax = saleTaxFor(cart.eventId, priced.map((l) => ({ productId: l.productId, taxFree: l.taxFree })));
    const sale: SaleEvent = {
      saleId,
      eventId: cart.eventId,
      at: Date.now(),
      currency: cart.currency,
      total: charged,
      baseCurrency: cart.baseCurrency,
      baseTotal: base,
      exchangeRate: cart.exchangeRate ?? undefined,
      ...(isConverting.value && marketRateNow() ? { marketRate: marketRateNow()! } : {}),
      // Each line carries the VAT rate actually applied (null when exempt or unknown).
      lines: priced.map(({ lineId: _l, variantLabel: _vl, type: _t, fixed: _f, key: _k, taxFree: _x, settles: _s, ...line }, i) => ({ ...line, taxRate: tax?.rates[i] ?? null })),
      ...(tax ? { tax } : {}),
      // Minted for every sale, whether or not a QR is shown: a receipt can
      // still be handed over later from the sale's receipt screen.
      receiptToken: mintReceiptToken(),
      // What the screen showed, for the receipt: list prices and each
      // discount by name, in the charged currency.
      asCharged: {
        listTotals: chargeLines.value.map((l, i) => (cart.lines[i]!.settles ? -usedCharged[i]! : l.lineTotal)),
        lineDiscounts: chargeShares,
        discounts: [
          ...chargeTotals.value.ruleDiscounts
            .filter((r) => r.amount > 0)
            .map((r) => ({ name: r.rule.name, amount: r.amount, ruleId: r.rule.id, lines: [...r.lines] })),
          ...(cart.custom && chargeTotals.value.customDiscountAmount > 0
            ? [{ name: cart.custom.name || 'Discount', amount: chargeTotals.value.customDiscountAmount, lines: cart.lines.map((_, i) => i) }]
            : []),
        ],
      },
      payment: {
        provider: pay.method === 'card' ? providerName : pay.method,
        approved: true,
        method: pay.method,
        legs: pay.legs,
        cashReceived: pay.cashReceived,
        txRef,
        cardBrand,
        ...(settled ? { settled } : {}),
      },
    };

    // Test mode: the sale is handed back for the screen and never announced,
    // so nothing records, books, restocks or syncs it.
    if (testMode.value) {
      clear();
      return { approved: true, sale, test: true };
    }
    sdk().events.emit('sale', sale);
    clear();
    return { approved: true, sale };
  } catch (err) {
    return { approved: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    activeProvider = null;
    cart.busy = false;
  }
}
