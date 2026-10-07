/** Data model v2 - shared between app and server. Grows in Phase 1/3. */
import type { EventVat, SaleTax, TaxClass } from './vat';

export type EventStatus = 'planned' | 'active' | 'closed';

/**
 * What a sales venue is. A convention or market (`event`, the default) runs
 * for a few dates; a `store` is a brick-and-mortar shop that is open
 * indefinitely. Both sell through the same till, claims and history - a
 * store is just a venue with no end date.
 */
export type SalesEventKind = 'event' | 'store';

export interface Venue {
  street?: string;
  postcode?: string;
  city?: string;
  country?: string;
  tin?: string;
}

/**
 * A file attached to an event - a ticket, a floor plan, the organiser's
 * schedule. Only this description rides on the event; the bytes live in the
 * server's file store and in a local cache (see event-files.ts).
 */
export interface EventAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  addedAt: number;
}

/**
 * Where the booth stands at an event. All optional, so old events and older
 * devices are unaffected. See event-booth.ts for validation and the fallback
 * to the legacy public-events overlay.
 */
export interface EventBooth {
  hall?: string;
  /** Stand or booth number. */
  number?: string;
  /** The convention's own page. https only. */
  link?: string;
  /** A short line for visitors, e.g. "New prints, limited pins." */
  note?: string;
}

export interface SalesEvent {
  id: string;
  name: string;
  /** Absent = 'event'. See SalesEventKind. */
  kind?: SalesEventKind;
  dateStart?: string;
  dateEnd?: string;
  venue: Venue;
  currency: string;
  /** Convention-local currency to display and charge in, e.g. "SEK". */
  localCurrency?: string;
  /** 1 unit of `currency` = exchangeRate units of `localCurrency`. */
  exchangeRate?: number;
  /** Round converted local prices to the nearest N units (0/undefined = cents only). */
  roundingIncrement?: number;
  /** Manual local-currency price overrides, keyed by stockKey ("pid" or "pid:vid"). */
  localPriceOverrides?: Record<string, number>;
  /** Manual local-currency tiered-discount bundle-total overrides, keyed by "ruleId:tierIndex". */
  localTierOverrides?: Record<string, number>;
  status: EventStatus;
  /** Per-event Swiss customs state (edec, form1174) - ported in Phase 6. */
  customs?: Record<string, unknown>;
  /** Per-event German customs (ATLAS) state - separate from `customs` so the two modules never collide. */
  customsDe?: Record<string, unknown>;
  /** VAT at this event - see resolveEventVat. Absent = from the country and the booth's exemptions. */
  vat?: EventVat;
  /** Hall, booth number, link and note - published by Public events. Not used for stores. */
  booth?: EventBooth;
  /** Keep this event out of the shared event pool even when the account shares its events (private or invite-only). */
  noPool?: boolean;
  /** Free-text notes for the team: setup times, stand number, who to ask. */
  notes?: string;
  /** Tickets, plans and other files. See EventAttachment. */
  attachments?: EventAttachment[];
  updatedAt: number;
  deletedAt?: number;
}

export interface Variant {
  id: string;
  name: string;
  sku?: string;
  price?: number;
  /** Per-unit production cost (base currency), maintained by cost batches. */
  cost?: number;
  weightG?: number;
  unlisted?: boolean;
  /** Variant-specific photo; falls back to the product photo in the UI. */
  imageId?: string;
  /** Overrides Product.material for this variant only (e.g. one colourway is
   *  a different material) - falls back to the product's material when unset. */
  material?: string;
}

export interface Product {
  id: string;
  title: string;
  sku?: string;
  type?: string;
  forSale: boolean;
  unlisted: boolean;
  price: number;
  /** Per-unit production cost (base currency) for products without variants,
   *  maintained by cost batches. Variant-level cost lives on the variant. */
  cost?: number;
  priceNote?: string;
  weightG?: number;
  tariffNo?: string;
  tariffRate?: number;
  /** Swiss import VAT rate, for customs paperwork - not what sales are taxed at (see taxClass). */
  vatRate?: number;
  /** Which VAT rate sales take at an event: the country's standard (default) or reduced rate. */
  taxClass?: TaxClass;
  packagingType?: string;
  originCountry?: string;
  /** Customs: overrides the HS-code-derived permit obligation in the e-dec XML. */
  permitOverride?: number;
  /** Year the artwork was produced. Customs wants title + year for art prints. */
  year?: number;
  /** Material composition (e.g. "Polyester, 100%" or "Zinc alloy, no precious metal").
   *  Customs wants this specific, not a generic material family - required for
   *  everything but art prints, same exemption as sku (see customsIssues()). */
  material?: string;
  variants: Variant[];
  imageId?: string;
  /**
   * Consignment: the artist this item belongs to. The account sells it on
   * their behalf and owes them the sale minus commission. Absent = the
   * account's own stock.
   */
  consignorId?: string;
  /** The artist's name, kept on the product so the till and labels can show it offline. */
  consignorName?: string;
  /** The artist's own product this was taken from, when it was imported from their linked catalogue. */
  consignorProductId?: string;
  sortOrder: number;
  updatedAt: number;
  deletedAt?: number;
}

/**
 * The one inventory: how many of a thing the booth owns, full stop.
 *
 * This is a counted figure, not a running balance. What is still available is
 * derived by subtracting recorded sales - a number decremented on every sale
 * drifts the moment one is reverted or arrives late from another register.
 */
export interface InventoryItem {
  productId: string;
  /** Variant id, or '' for the product itself (IndexedDB compound keys cannot hold null). */
  variantId: string;
  /** Total owned, as last counted. */
  onHand: number;
  updatedAt: number;
}

/**
 * An event's claim on the inventory - the stock set aside for it.
 *
 * A claim is reserved: no other event can sell against it. An event with no
 * claim sells from whatever is left unclaimed, which is the common case for a
 * booth that only works one event at a time.
 *
 * `broughtQty` is the stored name and means exactly that: what is being taken
 * to this event. Customs paperwork reads the same figure, because "claimed"
 * and "brought" are the same physical act.
 */
export interface EventStock {
  eventId: string;
  productId: string;
  /** Variant id, or '' for the product itself (IndexedDB compound keys cannot hold null). */
  variantId: string;
  broughtQty: number;
  updatedAt: number;
}

export type DiscountType = 'bxgy' | 'nth_pct' | 'tiered' | 'combo';

export interface DiscountTier {
  qty: number;
  total: number;
}

export interface DiscountRule {
  id: string;
  name: string;
  type: DiscountType;
  /** Products the rule applies to (all their variants included). For type='combo', each entry is a required bundle member. */
  productIds: string[];
  /** Specific variants, as "productId:variantId" keys. For type='combo', each entry is a required bundle member. */
  variantIds: string[];
  /** Product types (Product.type) the rule applies to - matches every product of that type. For type='combo', each entry is a required bundle member. */
  productTypes?: string[];
  buyQty?: number;
  freeQty?: number;
  nth?: number;
  percent?: number;
  tiers?: DiscountTier[];
  /** For type='combo': flat amount off (base currency) per complete set - every productIds/variantIds/productTypes member needs qty >= 1. */
  comboDiscountAmount?: number;
  tierContinue?: boolean;
  /** Don't show the derived "+N" quick-add chips on POS product cards. */
  hideQuickAdd?: boolean;
  /** Consignment artists whose items the rule applies to (Product.consignorId). */
  consignorIds?: string[];
  /** First day the till applies the rule (yyyy-mm-dd, inclusive); absent = always. */
  validFrom?: string;
  /** Last day the till applies the rule (yyyy-mm-dd, inclusive); absent = always. */
  validUntil?: string;
  /** Only at these events or stores; absent/empty = everywhere. */
  eventIds?: string[];
  /** Set when a module maintains the rule (e.g. 'consignment' for an artist-of-the-month discount). */
  managedBy?: string;
  updatedAt: number;
  deletedAt?: number;
}

/**
 * Whether a rule applies at the till today, at this event. The rows stay in
 * the catalogue either way; only where and when they are charged is limited.
 */
export function discountAppliesAt(
  rule: Pick<DiscountRule, 'validFrom' | 'validUntil' | 'eventIds'>,
  day: string,
  eventId: string | null,
): boolean {
  if (rule.validFrom && day < rule.validFrom) return false;
  if (rule.validUntil && day > rule.validUntil) return false;
  if (rule.eventIds?.length && (!eventId || !rule.eventIds.includes(eventId))) return false;
  return true;
}

/**
 * One cost component of a batch. Import and production are often billed
 * separately, so a batch sums several of these - entered by hand, or linked to
 * a purchase invoice recorded in ZollTax.
 */
export interface CostSource {
  id: string;
  label: string;
  amount: number;
  kind: 'manual' | 'zolltax';
  /** ZollTax invoice/expense id when kind='zolltax'. */
  ref?: string;
}

/** One product/variant in a cost batch (a shipment/order that arrived). */
export interface CostBatchLine {
  pid: string;
  /** '' for a product without variants (cost stored on the product). */
  vid: string;
  qty: number;
  /** Known per-item production cost (base currency); blank = derive from the total. */
  unitCost?: number;
}

/**
 * A shipment/order whose one lump total (production + shipping + import + fees)
 * is auto-distributed across its units to set each product/variant's per-unit
 * cost. Recorded over time - a later batch (e.g. a bigger, cheaper order) simply
 * updates the cost going forward.
 */
export interface CostBatch {
  id: string;
  /** yyyy-mm-dd the batch arrived / was ordered. */
  date: string;
  note?: string;
  currency?: string;
  /** Grand total for the whole shipment (base currency) - the sum of `sources`. */
  total: number;
  /** Itemized cost components (production, import, …); may link ZollTax invoices. */
  sources?: CostSource[];
  /** How the leftover (total − known unit costs) is spread across units. */
  weighting: 'even' | 'value';
  lines: CostBatchLine[];
  updatedAt: number;
  deletedAt?: number;
}

/** Built-in methods plus user-defined ones (e.g. "TWINT", "PayPal QR"). */
export type PaymentMethod = 'cash' | 'card' | 'split' | (string & {});

export interface PaymentLeg {
  kind: 'cash' | 'card';
  amount: number;
  provider?: string;
  txRef?: string;
  cardBrand?: string;
  authCode?: string;
  /**
   * What the card was actually charged, when it settled in a different
   * currency than the sale (cards taken in the base currency at a converted
   * event). `amount` stays in the sale's currency so legs still add up to the
   * total; this is the figure on the card slip. `rate`: 1 currency = rate of
   * the sale's currency, the market rate used at checkout.
   */
  settled?: CardSettlement;
}

export interface CardSettlement {
  amount: number;
  currency: string;
  rate: number;
}

export interface TxItem {
  pid: string;
  vid: string | null;
  title: string;
  variantLabel?: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  /** Same line in the event's base/tracking currency, when charged in a converted local currency. */
  baseUnitPrice?: number;
  baseLineTotal?: number;
  /**
   * The consignment artist the item belonged to when it sold - a snapshot,
   * so moving a product to another artist later never rewrites who was owed
   * for sales already made.
   */
  consignorId?: string;
  /** Percent the store kept on this line, when it was set for the line itself (e.g. a workshop's own split). */
  commissionPct?: number;
  /** The module record this line paid for - e.g. a workshop booking. */
  ref?: { moduleId: string; kind: string; id: string };
}

export interface TxDiscount {
  id?: string;
  name: string;
  amount: number;
  custom?: boolean;
}

export interface Transaction {
  id: string;
  eventId: string;
  deviceId: string;
  timestamp: number;
  method: PaymentMethod;
  payments: PaymentLeg[];
  items: TxItem[];
  discounts: TxDiscount[];
  total: number;
  currency: string;
  /** Event's base/tracking currency, when this sale was charged in a converted local currency. */
  baseCurrency?: string;
  /** Accounting figure in baseCurrency. */
  baseTotal?: number;
  /** Exchange rate snapshot used at checkout (base -> currency). */
  exchangeRate?: number;
  /** Op id of the revert that cancelled this transaction, if any. */
  revertedBy?: string;
  revertedAt?: number;
  /**
   * Secret for the customer's online receipt (see receipt-link.ts). Random,
   * unrelated to the id, and the only thing the public receipt page accepts -
   * knowing a sale's id gets you nothing.
   */
  receiptToken?: string;
  /**
   * What the till showed, in the charged currency - for receipts only.
   *
   * `items[].lineTotal` already has every discount spread into it (the books
   * and customs read those), so these are never subtracted again: they only
   * let a receipt list each line at the price on the screen and name each
   * discount, the way the customer saw it. `listTotals` pairs with `items`
   * by index.
   */
  asCharged?: AsCharged;
  /** VAT as applied at the time of the sale - see SaleTax. Absent on sales made before VAT was tracked. */
  tax?: SaleTax;
  /** Who rang it up - set by the server from the signed-in user, so staff cash-ups add up per person. */
  soldBy?: { userId: string; email: string | null };
}

export interface AsCharged {
  listTotals: number[];
  /**
   * How much of the discounts each line carries, paired with `items` by
   * index, in the charged currency - so `listTotals[i] - lineDiscounts[i]`
   * is what that line actually cost. A rule's discount only lands on the
   * lines the rule matched; a one-off discount on the whole sale. Split in
   * whole units whenever the discount and prices are whole. Absent on sales
   * recorded before the till kept this.
   */
  lineDiscounts?: number[];
  discounts: AsChargedDiscount[];
}

export interface AsChargedDiscount {
  name: string;
  amount: number;
  /** The rule that gave it; absent for a one-off discount. */
  ruleId?: string;
  /** Indexes into `items` of the lines it applied to. */
  lines?: number[];
}
