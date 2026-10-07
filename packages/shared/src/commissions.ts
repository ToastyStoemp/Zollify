import { z } from 'zod';
import { round2 } from './money';

/**
 * Commissions: custom work an artist takes on for a customer, from the first
 * request to pickup. Pure types and rules here so the server, the owner's
 * screens and the till agree on the pipeline and on what is owed.
 */

/** The fixed pipeline, in order. `cancelled` is a side exit rather than a step. */
export const COMMISSION_STATUSES = ['requested', 'accepted', 'in_progress', 'ready', 'collected', 'cancelled'] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

export const COMMISSION_STATUS_LABEL: Record<CommissionStatus, string> = {
  requested: 'Requested',
  accepted: 'Accepted',
  in_progress: 'In progress',
  ready: 'Ready for pickup',
  collected: 'Collected',
  cancelled: 'Cancelled',
};

/** Done with: nothing more is expected to happen, so it is never overdue. */
export const isClosedStatus = (s: CommissionStatus): boolean => s === 'collected' || s === 'cancelled';

/** What a sale line carries in `ref.kind` when it pays for a commission. */
export const COMMISSION_REF_KIND = 'commission';

/** A commission's public link is the account's origin plus this path and the token. */
export const COMMISSION_PUBLIC_PATH = '/p/commissions/';
/** 24 random bytes, base64url: 192 bits, not guessable and not enumerable. */
export const COMMISSION_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

const day = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-12-31.')]);
const money = z.number().finite().min(0).max(1_000_000);

export const CommissionInputSchema = z.object({
  customerName: z.string().trim().min(1, 'Enter the customer\'s name.').max(120),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().email().max(254)]).default(''),
  phone: z.string().trim().max(40).default(''),
  /** Short name of the piece; the customer sees it on the tracking page. */
  title: z.string().trim().min(1, 'Give the commission a short title.').max(120),
  /** What was asked for, in detail. Stays with the artist. */
  description: z.string().trim().max(4000).default(''),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('EUR'),
  price: money.default(0),
  /** What the artist asks up front. Informational: what was actually paid comes from the till. */
  depositAsked: money.default(0),
  dueDate: day.default(''),
  /** Private to the artist and staff, never on the public page. */
  notes: z.string().trim().max(4000).default(''),
});
export type CommissionInput = z.infer<typeof CommissionInputSchema>;

export const CommissionUpdateSchema = z.object({
  status: z.enum(COMMISSION_STATUSES).optional(),
  /** Shown to the customer under this step. */
  message: z.string().trim().max(500).default(''),
  /** Email the customer about this update, when they left an address and the server can send. */
  email: z.boolean().default(false),
});
export type CommissionUpdateInput = z.infer<typeof CommissionUpdateSchema>;

/** One entry in the timeline: a step the commission reached, or a note for the customer. */
export interface CommissionUpdate {
  id: string;
  at: number;
  /** The status the commission was in after this entry. */
  status: CommissionStatus;
  /** True when this entry moved it to `status`; false for a message that changed nothing. */
  changed: boolean;
  message: string;
}

export interface Commission extends CommissionInput {
  id: string;
  status: CommissionStatus;
  updates: CommissionUpdate[];
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
}

/** A payment at the till, found by following the sale lines that point at the commission. */
export interface CommissionPayment {
  saleId: string;
  at: number;
  amount: number;
  label: string;
}

export interface CommissionTotals {
  paid: number;
  payments: CommissionPayment[];
  /** What is still owed against the price; never negative. */
  balance: number;
}

export function commissionTotals(price: number, payments: CommissionPayment[]): CommissionTotals {
  const paid = round2(payments.reduce((sum, p) => sum + p.amount, 0));
  return { paid, payments, balance: round2(Math.max(0, price - paid)) };
}

/** Past its due date and not finished. `today` is YYYY-MM-DD, local to the shop. */
export function isOverdue(c: Pick<Commission, 'dueDate' | 'status'>, today: string): boolean {
  return !!c.dueDate && !isClosedStatus(c.status) && c.dueDate < today;
}

/** The statuses a commission may move to from here: any open step, and out to cancelled. */
export function nextStatuses(from: CommissionStatus): CommissionStatus[] {
  if (from === 'collected' || from === 'cancelled') return [];
  return COMMISSION_STATUSES.filter((s) => s !== from);
}

/** Where the owner says people collect from; shown on the tracking page. */
export const CommissionSettingsSchema = z.object({
  /** Shown as the sender of the page; falls back to the account's name. */
  shopName: z.string().trim().max(80).default(''),
  pickupName: z.string().trim().max(120).default(''),
  pickupAddress: z.string().trim().max(300).default(''),
  pickupNote: z.string().trim().max(300).default(''),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('EUR'),
});
export type CommissionSettings = z.infer<typeof CommissionSettingsSchema>;

/** What the tracking page gets, and all of it: nothing else about the customer or the commission leaves. */
export interface PublicCommission {
  shop: string;
  title: string;
  status: CommissionStatus;
  statusLabel: string;
  dueDate: string;
  currency: string;
  price: number;
  paid: number;
  balance: number;
  updates: { at: number; status: CommissionStatus; statusLabel: string; changed: boolean; message: string }[];
  pickup: { name: string; address: string; note: string } | null;
}
