/** Data model v2 — shared between app and server. Grows in Phase 1/3. */

export type EventStatus = 'planned' | 'active' | 'closed';

export interface Venue {
  street?: string;
  postcode?: string;
  city?: string;
  country?: string;
  tin?: string;
}

export interface SalesEvent {
  id: string;
  name: string;
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
  /** Per-event customs state (edec, form1174) — ported in Phase 6. */
  customs?: Record<string, unknown>;
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
  vatRate?: number;
  packagingType?: string;
  originCountry?: string;
  /** Customs: overrides the HS-code-derived permit obligation in the e-dec XML. */
  permitOverride?: number;
  /** Year the artwork was produced. Customs wants title + year for art prints. */
  year?: number;
  /** Material composition (e.g. "Genuine leather"). Customs wants it for purses. */
  material?: string;
  variants: Variant[];
  imageId?: string;
  sortOrder: number;
  updatedAt: number;
  deletedAt?: number;
}

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
  /** Product types (Product.type) the rule applies to — matches every product of that type. For type='combo', each entry is a required bundle member. */
  productTypes?: string[];
  buyQty?: number;
  freeQty?: number;
  nth?: number;
  percent?: number;
  tiers?: DiscountTier[];
  /** For type='combo': flat amount off (base currency) per complete set — every productIds/variantIds/productTypes member needs qty >= 1. */
  comboDiscountAmount?: number;
  tierContinue?: boolean;
  /** Don't show the derived "+N" quick-add chips on POS product cards. */
  hideQuickAdd?: boolean;
  updatedAt: number;
  deletedAt?: number;
}

/**
 * One cost component of a batch. Import and production are often billed
 * separately, so a batch sums several of these — entered by hand, or linked to
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
 * cost. Recorded over time — a later batch (e.g. a bigger, cheaper order) simply
 * updates the cost going forward.
 */
export interface CostBatch {
  id: string;
  /** yyyy-mm-dd the batch arrived / was ordered. */
  date: string;
  note?: string;
  currency?: string;
  /** Grand total for the whole shipment (base currency) — the sum of `sources`. */
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
}
