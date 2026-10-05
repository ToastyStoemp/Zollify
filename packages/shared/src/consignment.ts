import { z } from 'zod';
import type { SalesEvent, Transaction } from './types';

/**
 * Consignment - selling artists' work on their behalf.
 *
 * A store owner's account carries artists ("consignors") next to its own
 * stock. A product tagged with `consignorId` is the artist's; every sale of it
 * owes the artist the sale minus the store's commission. An artist can sell in
 * one of the owner's stores or several, and can link their own Zollify
 * account - the same one they run their convention booth from - to follow
 * their sales and payouts.
 *
 * Everything here is pure: the server computes statements from the op-log
 * with it, and the tests pin the arithmetic.
 */

/** A venue that is a permanent shop rather than a dated event. */
export function isStore(event: Pick<SalesEvent, 'kind'> | null | undefined): boolean {
  return event?.kind === 'store';
}

export const ConsignorInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().max(160).default(''),
  /** Percent of each sale the store keeps. */
  commissionPct: z.number().min(0).max(100),
  /** Per-store overrides of commissionPct, by store id. */
  storeCommission: z.record(z.string().min(1).max(80), z.number().min(0).max(100)).default({}),
  /** The stores that carry this artist; a shared artist lists several. */
  storeIds: z.array(z.string().min(1).max(80)).max(200).default([]),
  note: z.string().max(1000).default(''),
  archived: z.boolean().default(false),
});
export type ConsignorInput = z.infer<typeof ConsignorInputSchema>;

export interface Consignor {
  id: string;
  name: string;
  email: string;
  commissionPct: number;
  storeCommission: Record<string, number>;
  storeIds: string[];
  note: string;
  archived: boolean;
  /** Name of the artist's own Zollify account, once they have linked it. */
  linkedAccountName: string | null;
  linked: boolean;
  /** A link code was issued and has not been used or expired yet. */
  linkPending: boolean;
  createdAt: number;
  updatedAt: number;
}

export const PayoutInputSchema = z.object({
  consignorId: z.string().min(1).max(80),
  /** The store it settles, or null for a payout across all of them. */
  storeId: z.string().min(1).max(80).nullable().default(null),
  amount: z.number().positive().max(10_000_000),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  /** yyyy-mm-dd */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().max(500).default(''),
});
export type PayoutInput = z.infer<typeof PayoutInputSchema>;

export interface ConsignmentPayout extends PayoutInput {
  id: string;
  createdAt: number;
}

/** The commission a store keeps on this artist's sales there. */
export function commissionFor(consignor: Pick<Consignor, 'commissionPct' | 'storeCommission'>, storeId: string): number {
  const override = consignor.storeCommission?.[storeId];
  return typeof override === 'number' ? override : consignor.commissionPct;
}

/** One sold consigned item, split into what the store keeps and what the artist is owed. */
export interface ConsignmentLine {
  txId: string;
  at: number;
  consignorId: string;
  /** The event or store it sold at. */
  storeId: string;
  productId: string;
  variantId: string | null;
  title: string;
  variantLabel?: string;
  qty: number;
  currency: string;
  /** What the customer paid for the line, discounts included, in the books' currency. */
  gross: number;
  commissionPct: number;
  commission: number;
  artistShare: number;
}

const toMinor = (n: number): number => Math.round(n * 100);

/**
 * Every consigned line in these sales, reverted sales left out.
 *
 * Attribution is the `consignorId` snapshotted onto the line when it sold -
 * never the product's current owner - so reassigning a product cannot move
 * money that was already earned. Amounts are in the books' currency: a sale
 * charged in a converted local currency still stores its lines in base.
 */
export function consignmentLines(
  transactions: Transaction[],
  consignors: Pick<Consignor, 'id' | 'commissionPct' | 'storeCommission'>[],
): ConsignmentLine[] {
  const byId = new Map(consignors.map((c) => [c.id, c]));
  const out: ConsignmentLine[] = [];
  for (const tx of transactions) {
    if (tx.revertedAt || tx.revertedBy) continue;
    const currency = tx.baseCurrency ?? tx.currency;
    for (const item of tx.items) {
      const consignor = item.consignorId ? byId.get(item.consignorId) : undefined;
      if (!consignor) continue;
      const pct = commissionFor(consignor, tx.eventId);
      const grossMinor = toMinor(item.baseLineTotal ?? item.lineTotal);
      const commissionMinor = Math.round((grossMinor * pct) / 100);
      out.push({
        txId: tx.id,
        at: tx.timestamp,
        consignorId: consignor.id,
        storeId: tx.eventId,
        productId: item.pid,
        variantId: item.vid,
        title: item.title,
        ...(item.variantLabel ? { variantLabel: item.variantLabel } : {}),
        qty: item.qty,
        currency,
        gross: grossMinor / 100,
        commissionPct: pct,
        commission: commissionMinor / 100,
        artistShare: (grossMinor - commissionMinor) / 100,
      });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

export interface StoreTotals {
  storeId: string;
  currency: string;
  units: number;
  gross: number;
  commission: number;
  artistShare: number;
}

export interface CurrencyBalance {
  currency: string;
  units: number;
  gross: number;
  commission: number;
  artistShare: number;
  paid: number;
  /** Still owed to the artist; negative when they were paid ahead. */
  balance: number;
}

export interface ConsignorStatement {
  consignorId: string;
  byStore: StoreTotals[];
  totals: CurrencyBalance[];
}

/**
 * What each artist sold, per store, and what is still owed to them.
 *
 * The balance is across all stores: an artist shared between two shops is
 * paid by one owner, and a payout naming a store still settles the same
 * debt. Money is summed in minor units so a long statement never drifts a cent.
 */
export function consignmentStatements(
  lines: ConsignmentLine[],
  payouts: Pick<ConsignmentPayout, 'consignorId' | 'amount' | 'currency'>[],
  consignorIds: string[],
): ConsignorStatement[] {
  type Acc = { units: number; gross: number; commission: number; share: number; paid: number };
  const zero = (): Acc => ({ units: 0, gross: 0, commission: 0, share: 0, paid: 0 });
  const stores = new Map<string, Map<string, Acc>>(); // consignor → "store|currency"
  const totals = new Map<string, Map<string, Acc>>(); // consignor → currency
  const bucket = (outer: Map<string, Map<string, Acc>>, id: string, key: string): Acc => {
    let inner = outer.get(id);
    if (!inner) outer.set(id, (inner = new Map()));
    let acc = inner.get(key);
    if (!acc) inner.set(key, (acc = zero()));
    return acc;
  };

  for (const l of lines) {
    for (const acc of [bucket(stores, l.consignorId, `${l.storeId}|${l.currency}`), bucket(totals, l.consignorId, l.currency)]) {
      acc.units += l.qty;
      acc.gross += toMinor(l.gross);
      acc.commission += toMinor(l.commission);
      acc.share += toMinor(l.artistShare);
    }
  }
  for (const p of payouts) bucket(totals, p.consignorId, p.currency).paid += toMinor(p.amount);

  const ids = [...new Set([...consignorIds, ...totals.keys()])];
  return ids.map((consignorId) => ({
    consignorId,
    byStore: [...(stores.get(consignorId) ?? new Map<string, Acc>()).entries()]
      .map(([key, a]) => {
        const cut = key.lastIndexOf('|');
        const storeId = key.slice(0, cut);
        const currency = key.slice(cut + 1);
        return { storeId, currency, units: a.units, gross: a.gross / 100, commission: a.commission / 100, artistShare: a.share / 100 };
      })
      .sort((a, b) => a.storeId.localeCompare(b.storeId) || a.currency.localeCompare(b.currency)),
    totals: [...(totals.get(consignorId) ?? new Map<string, Acc>()).entries()]
      .map(([currency, a]) => ({
        currency,
        units: a.units,
        gross: a.gross / 100,
        commission: a.commission / 100,
        artistShare: a.share / 100,
        paid: a.paid / 100,
        balance: (a.share - a.paid) / 100,
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  }));
}

// ── The artist's side ──────────────────────────────────────────────────────

/** A store, as an artist consigning to it may see it. */
export interface ConsignmentVenue {
  id: string;
  name: string;
  kind: 'event' | 'store';
  city?: string;
  country?: string;
}

/** One of the artist's items in a store owner's catalogue. */
export interface ConsignedItem {
  productId: string;
  variantId: string;
  title: string;
  variantLabel?: string;
  sku?: string;
  price: number;
  /** The artist's own product it came from, when imported from their catalogue. */
  sourceProductId?: string;
  /** What the store last counted, or null when it never counted the item. */
  onHand: number | null;
  /** onHand less what sold since that count; null when uncounted. */
  remaining: number | null;
  sold: number;
}

/** Everything one store owner shares with one linked artist. */
export interface ArtistConsignment {
  storeAccountId: string;
  storeAccountName: string;
  /** The store's book currency - what its prices are in. */
  currency: string;
  consignorId: string;
  /** How the store names the artist. */
  consignorName: string;
  commissionPct: number;
  storeCommission: Record<string, number>;
  /** The owner's module is switched off: nothing is shared until it is back on. */
  paused: boolean;
  venues: ConsignmentVenue[];
  items: ConsignedItem[];
  lines: ConsignmentLine[];
  payouts: ConsignmentPayout[];
  statement: ConsignorStatement;
}
