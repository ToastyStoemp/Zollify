import { z } from 'zod';
import { round2 } from './money';

/**
 * Wholesale: selling to shops outright - the reverse of consignment. Trade
 * details and price tiers on products, trade customers, and orders from
 * draft to paid. Pure rules here so the server, the owner's screens and
 * the catalogue agree on what a line costs and what an order reserves.
 *
 * Stock: a confirmed or packed order reserves its quantities the way an
 * event claim does, on the account's "Wholesale" store; shipping records
 * the order as a sale at that store, so stock, revenue and the books
 * follow without a second inventory.
 */

const money = z.number().finite().min(0).max(1_000_000);
const day = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-12-31.')]);

export const TradeTierSchema = z.object({
  /** From this many units the price applies. */
  minQty: z.number().int().min(1).max(100_000),
  price: money,
});
export type TradeTier = z.infer<typeof TradeTierSchema>;

/** What a product is to the trade. Kept apart from the catalogue, keyed by product id. */
export const TradeDetailsSchema = z.object({
  /** Offered to the trade at all. */
  enabled: z.boolean().default(true),
  /** By quantity; the highest tier a line reaches applies. Empty = list price. */
  tiers: z.array(TradeTierSchema).max(10).default([]),
  /** Minimum order quantity. */
  moq: z.number().int().min(1).max(100_000).default(1),
  /** Units per case or pack - orders are rounded up to it. */
  packSize: z.number().int().min(1).max(10_000).default(1),
  /** Working days from confirmation to shipping. */
  leadDays: z.number().int().min(0).max(365).default(0),
  description: z.string().trim().max(1000).default(''),
  materials: z.string().trim().max(200).default(''),
  dimensions: z.string().trim().max(120).default(''),
});
export type TradeDetails = z.infer<typeof TradeDetailsSchema>;

export const TradeCustomerSchema = z.object({
  company: z.string().trim().min(1, "Enter the shop's name.").max(160),
  contact: z.string().trim().max(120).default(''),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().email().max(254)]).default(''),
  phone: z.string().trim().max(40).default(''),
  vatNumber: z.string().trim().max(40).default(''),
  enterpriseNumber: z.string().trim().max(40).default(''),
  address: z.string().trim().max(400).default(''),
  country: z.string().trim().toUpperCase().max(2).default(''),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('EUR'),
  /** Payment terms in words: "30 days net", "prepayment". */
  terms: z.string().trim().max(200).default(''),
  /** Off the tier price, for this customer. */
  discountPct: z.number().finite().min(0).max(100).default(0),
  notes: z.string().trim().max(2000).default(''),
  archived: z.boolean().default(false),
});
export type TradeCustomerInput = z.infer<typeof TradeCustomerSchema>;
export interface TradeCustomer extends TradeCustomerInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export const ORDER_STATUSES = ['draft', 'confirmed', 'packed', 'shipped', 'invoiced', 'paid', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  draft: 'Draft',
  confirmed: 'Confirmed',
  packed: 'Packed',
  shipped: 'Shipped',
  invoiced: 'Invoiced',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

/** Confirmed and not yet shipped: the stock is promised and set aside. */
export const reservesStock = (s: OrderStatus): boolean => s === 'confirmed' || s === 'packed';
/** Lines may still change. */
export const isEditable = (s: OrderStatus): boolean => s === 'draft' || s === 'confirmed';
export const isClosedOrder = (s: OrderStatus): boolean => s === 'paid' || s === 'cancelled';

export function nextOrderStatuses(from: OrderStatus): OrderStatus[] {
  switch (from) {
    case 'draft':
      return ['confirmed', 'cancelled'];
    case 'confirmed':
      return ['packed', 'shipped', 'cancelled'];
    case 'packed':
      return ['shipped', 'cancelled'];
    case 'shipped':
      return ['invoiced', 'paid'];
    case 'invoiced':
      return ['paid'];
    default:
      return [];
  }
}

export const OrderLineSchema = z.object({
  productId: z.string().min(1).max(80),
  variantId: z.string().max(80).nullable().default(null),
  /** Snapshots: what the line said when it was written, whatever the catalogue does later. */
  title: z.string().trim().min(1).max(200),
  variantLabel: z.string().trim().max(120).default(''),
  sku: z.string().trim().max(80).default(''),
  qty: z.number().int().min(1).max(100_000),
  /** After the customer's discount. */
  unitPrice: money,
});
export type OrderLine = z.infer<typeof OrderLineSchema>;

export const OrderInputSchema = z.object({
  customerId: z.string().min(1, 'Pick a customer.').max(80),
  lines: z.array(OrderLineSchema).max(500).default([]),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('EUR'),
  /** The customer's reference or a note for the packer. */
  note: z.string().trim().max(2000).default(''),
  /** When the customer wants it; empty = as soon as the lead time allows. */
  requestedDate: day.default(''),
});
export type OrderInput = z.infer<typeof OrderInputSchema>;

export interface WholesaleOrder extends OrderInput {
  id: string;
  /** Sequential per account, for the paperwork. */
  number: number;
  status: OrderStatus;
  /** Working days from the longest lead time among the lines, from confirmation. */
  expectedShipDate: string;
  createdAt: number;
  updatedAt: number;
  confirmedAt: number | null;
  shippedAt: number | null;
  /** The till sale the shipment was recorded as, at the Wholesale store. */
  saleId: string | null;
  createdBy: string | null;
}

/** The tier price for a quantity: the highest tier reached, or the list price. */
export function tierPriceFor(tiers: TradeTier[], qty: number, listPrice: number): number {
  const reached = [...tiers].filter((t) => qty >= t.minQty).sort((a, b) => b.minQty - a.minQty)[0];
  return reached ? reached.price : listPrice;
}

/** A quantity rounded up to whole packs and to the minimum. */
export function orderableQty(qty: number, details: Pick<TradeDetails, 'moq' | 'packSize'>): number {
  const n = Math.max(details.moq, Math.max(0, Math.floor(qty)));
  return Math.ceil(n / details.packSize) * details.packSize;
}

/** The unit price a customer pays for a quantity: the tier, less their discount. */
export function unitPriceFor(tiers: TradeTier[], qty: number, listPrice: number, discountPct: number): number {
  return round2(tierPriceFor(tiers, qty, listPrice) * (1 - Math.min(100, Math.max(0, discountPct)) / 100));
}

export function orderTotals(lines: Pick<OrderLine, 'qty' | 'unitPrice'>[]): { units: number; total: number } {
  return { units: lines.reduce((s, l) => s + l.qty, 0), total: round2(lines.reduce((s, l) => s + (Math.round(l.unitPrice * 100) * l.qty) / 100, 0)) };
}

/** `days` working days (Monday to Friday) after `from`, as YYYY-MM-DD. */
export function addWorkingDays(from: Date | number, days: number): string {
  const d = new Date(from);
  let left = Math.max(0, Math.floor(days));
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const w = d.getDay();
    if (w !== 0 && w !== 6) left--;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** When an order can ship: the longest lead time among its lines, from when it was confirmed. */
export function expectedShipDate(confirmedAt: number, leadDaysOf: (productId: string) => number, lines: Pick<OrderLine, 'productId'>[]): string {
  const lead = lines.reduce((m, l) => Math.max(m, leadDaysOf(l.productId)), 0);
  return addWorkingDays(confirmedAt, lead);
}

/** What the open orders promise per item ("pid:vid", vid '' for the product itself). */
export function reservedByItem(orders: Pick<WholesaleOrder, 'status' | 'lines'>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const o of orders) {
    if (!reservesStock(o.status)) continue;
    for (const l of o.lines) {
      const key = `${l.productId}:${l.variantId ?? ''}`;
      out.set(key, (out.get(key) ?? 0) + l.qty);
    }
  }
  return out;
}
