import { z } from 'zod';
import { isTimeZone } from './consignment-books';
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

/**
 * Who a commission is for. The details live in one customer record per person,
 * so a returning customer is not retyped; commissions point at it by id. They
 * are personal data, kept only while needed (see `decideErase`).
 */
export const CustomerInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter the customer\'s name.').max(120),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().email().max(254)]).default(''),
  phone: z.string().trim().max(40).default(''),
});
export type CustomerInput = z.infer<typeof CustomerInputSchema>;

export interface Customer extends CustomerInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** Shown in place of the name once a customer's details have been erased. */
export const CUSTOMER_REMOVED_LABEL = 'Customer removed';

export const CommissionInputSchema = z.object({
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

/**
 * A new commission is for an existing customer (`customerId`) or for a new one
 * typed in the same form (`customer`). A new customer who looks like an
 * existing one is not created until the seller says so (`forceNewCustomer`).
 */
export const CommissionCreateSchema = CommissionInputSchema.extend({
  customerId: z.string().min(1).max(80).optional(),
  customer: CustomerInputSchema.optional(),
  forceNewCustomer: z.boolean().default(false),
}).refine((v) => !!v.customerId !== !!v.customer, { message: 'Pick a customer or enter a new one.', path: ['customer'] });
export type CommissionCreateInput = z.infer<typeof CommissionCreateSchema>;

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
  /** What the customer wrote, on the request page or their tracking page. */
  brief?: CustomerBrief | null;
  /** Came in from the public request page. */
  source?: 'request';
  /** The customer record; null once their details were erased. */
  customerId: string | null;
  /** When the personal details were cleared from this commission, if they were. */
  customerErasedAt: number | null;
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

/** What the till asks for first: a deposit, then the rest; or the full price in one go. */
export const COMMISSION_PAYMENT_MODES = ['deposit', 'full'] as const;
export type CommissionPaymentMode = (typeof COMMISSION_PAYMENT_MODES)[number];

export type CommissionPaymentKind = 'Deposit' | 'Full price' | 'Balance' | 'Payment';

/**
 * The payment the till offers next for a commission, and how much. With
 * `full`, nothing paid yet means the whole price, whatever deposit was once
 * set; with `deposit`, a deposit asked comes first. After the first payment it
 * is the balance either way. `Payment` with 0: nothing to suggest (no price,
 * or paid up) - the seller types an amount.
 */
export function nextCommissionPayment(
  c: Pick<Commission, 'price' | 'depositAsked'>,
  paid: number,
  mode: CommissionPaymentMode,
): { kind: CommissionPaymentKind; amount: number } {
  const owed = round2(Math.max(0, c.price - paid));
  const deposit = round2(Math.max(0, c.depositAsked - paid));
  if (paid <= 0) {
    if (mode === 'deposit' && deposit > 0) return { kind: 'Deposit', amount: deposit };
    if (owed > 0) return { kind: 'Full price', amount: owed };
    if (deposit > 0) return { kind: 'Deposit', amount: deposit };
    return { kind: 'Payment', amount: 0 };
  }
  return owed > 0 ? { kind: 'Balance', amount: owed } : { kind: 'Payment', amount: 0 };
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

export const DEFAULT_KEEP_CUSTOMER_DAYS = 30;

/** Where the owner says people collect from; shown on the tracking page. */
export const CommissionSettingsSchema = z.object({
  /** Shown as the sender of the page; falls back to the account's name. */
  shopName: z.string().trim().max(80).default(''),
  pickupName: z.string().trim().max(120).default(''),
  pickupAddress: z.string().trim().max(300).default(''),
  pickupNote: z.string().trim().max(300).default(''),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('EUR'),
  /** IANA zone the tracking page shows times in, e.g. Europe/Zurich. */
  timeZone: z.string().trim().min(1).max(64).refine(isTimeZone, 'Unknown time zone.').default('UTC'),
  /** Days a customer's details are kept after their last commission closes; 0 erases at the next sweep. */
  keepCustomerDays: z.number().int().min(0).max(365).default(DEFAULT_KEEP_CUSTOMER_DAYS),
  /** The public request page takes new requests. Its address is kept apart (see the request-page routes). */
  requestsOpen: z.boolean().default(false),
  /** What the request page says above the form: what you take on, prices, how long. */
  requestIntro: z.string().trim().max(1000).default(''),
  /** At the till: a deposit first (the deposit field is offered), or the full price at once (it is not). */
  paymentMode: z.enum(COMMISSION_PAYMENT_MODES).default('deposit'),
});
export type CommissionSettings = z.infer<typeof CommissionSettingsSchema>;

// ── What the customer tells us ─────────────────────────────────────────────

/** Reference pictures one commission may hold, from the customer. */
export const BRIEF_MAX_PICTURES = 6;
/** The public request page's address: `/p/commissions/request/<token>`. */
export const COMMISSION_REQUEST_PATH = '/p/commissions/request/';
/** 18 random bytes, base64url: the request page's token. */
export const COMMISSION_REQUEST_TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;

/** An address the customer leaves on their tracking page, for updates. */
export const CustomerEmailSchema = z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254) });

/** What the customer wrote about what they want; theirs to change while the commission is open. */
export const CustomerBriefSchema = z.object({
  text: z.string().trim().max(4000, 'Keep it under 4000 characters.').default(''),
});

/** A new request from the public page. */
export const CommissionRequestSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  phone: z.string().trim().max(40).default(''),
  /** A few words: "Fox portrait, A4". */
  title: z.string().trim().min(1, 'Say in a few words what you would like.').max(120),
  /** The brief. */
  text: z.string().trim().min(1, 'Describe what you would like.').max(4000),
  budget: z.string().trim().max(80).default(''),
  /** When they would like it by; YYYY-MM-DD or empty. */
  wantedBy: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).default(''),
  /** Honeypot: a bot fills it, a person never sees it. */
  website: z.string().max(200).default(''),
});
export type CommissionRequestInput = z.infer<typeof CommissionRequestSchema>;

/** The customer's brief as kept on the commission. Personal free text: cleared when their details are erased. */
export interface CustomerBrief {
  text: string;
  /** From the request form: what they said about money and time. */
  budget: string;
  wantedBy: string;
  updatedAt: number;
}

/** A reference picture's description; the bytes stay on the server. */
export interface BriefPicture {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
}

// ── Browser notifications ──────────────────────────────────────────────────

/** Devices one commission may notify. */
export const PUSH_MAX_PER_COMMISSION = 5;

/**
 * Push services a subscription may point at. The address comes from the
 * customer's browser, and the server posts to it - so only the browsers' own
 * push services, never somewhere a stranger chose (an address inside the
 * server's network, say).
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];

export function isPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  return PUSH_HOSTS.some((re) => re.test(u.hostname));
}

export const PushSubscriptionSchema = z.object({
  endpoint: z.string().max(1000).refine(isPushEndpoint, 'That is not a browser push address.'),
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{40,120}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/) }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionSchema>;

/** Statuses at which the tracking page keeps asking the server for news; closed ones will not change. */
export const isWatchedStatus = (s: CommissionStatus): boolean => !isClosedStatus(s);

/** What the tracking page gets, and all of it: nothing else about the customer or the commission leaves. */
export interface PublicCommission {
  shop: string;
  title: string;
  status: CommissionStatus;
  statusLabel: string;
  dueDate: string;
  /** Zone the update times are shown in. */
  timeZone: string;
  currency: string;
  price: number;
  paid: number;
  balance: number;
  updates: { at: number; status: CommissionStatus; statusLabel: string; changed: boolean; message: string }[];
  pickup: { name: string; address: string; note: string } | null;
  /** What the customer told us, and their pictures; theirs to see on their own page. */
  brief: { text: string; budget: string; wantedBy: string } | null;
  pictures: BriefPicture[];
  /** The customer may still change the brief and the pictures. */
  canAddBrief: boolean;
  /** An email is on file for updates (never which one). Without, the page offers to take one. */
  hasEmail: boolean;
  /** The server can send email at all; without, the page does not ask for an address. */
  mailEnabled: boolean;
  /** The server can send browser notifications. */
  push: boolean;
}
