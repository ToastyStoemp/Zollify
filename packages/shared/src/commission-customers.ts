import { CUSTOMER_REMOVED_LABEL, isClosedStatus, type Commission, type CommissionStatus } from './commissions';
import { round2 } from './money';

/**
 * The rules about customers of commissions, kept pure so the server, the
 * screens and the tests share them: who counts as the same person, when a
 * customer's details are still needed, and what erasing clears.
 */

export const DAY_MS = 86_400_000;

/** Shorter than this and a "phone number" is too little to say two people are the same. */
const MIN_PHONE_DIGITS = 6;

export const emailKey = (email: string): string => email.trim().toLowerCase();

/** Digits only, so "+41 79 555 01 02" and "+41795550102" are the same number. */
export const phoneDigits = (phone: string): string => phone.replace(/\D/g, '');

/** The digits to compare on, or '' when the number is too short to mean anything. */
export const phoneKey = (phone: string): string => {
  const d = phoneDigits(phone);
  return d.length >= MIN_PHONE_DIGITS ? d : '';
};

interface Contact {
  id: string;
  email: string;
  phone: string;
}

/** Existing customers a new one would duplicate: the same email (any case) or the same phone digits. */
export function findDuplicates<T extends Contact>(candidate: { email: string; phone: string }, existing: readonly T[]): T[] {
  const e = emailKey(candidate.email);
  const p = phoneKey(candidate.phone);
  if (!e && !p) return [];
  return existing.filter((c) => (e && emailKey(c.email) === e) || (p && phoneKey(c.phone) === p));
}

/**
 * Groups commissions that predate customer records into customers: by email
 * (any case), else by phone digits, else one customer per commission. Returns
 * the ids of each group, in first-seen order.
 */
export function groupForMigration(items: readonly Contact[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const e = emailKey(item.email);
    const p = phoneKey(item.phone);
    const key = e ? `e:${e}` : p ? `p:${p}` : `c:${item.id}`;
    const list = groups.get(key);
    if (list) list.push(item.id);
    else groups.set(key, [item.id]);
  }
  return [...groups.values()];
}

/** When a commission closed: the step that closed it, else the last time it was touched. */
export function closedAtOf(c: Pick<Commission, 'updates' | 'updatedAt'>): number {
  for (let i = c.updates.length - 1; i >= 0; i--) {
    const u = c.updates[i]!;
    if (u.changed && isClosedStatus(u.status)) return u.at;
  }
  return c.updatedAt;
}

export interface EraseInput {
  /** Every commission of the customer, with when it closed (ignored while open). */
  commissions: readonly { status: CommissionStatus; closedAt: number }[];
  createdAt: number;
  /** Nothing is erased before this moment; set when records were migrated, so deploying erases nothing. */
  keepFrom: number;
  now: number;
  retentionDays: number;
}

export interface EraseDecision {
  erase: boolean;
  /** True while a commission is still open: the details are in use. */
  needed: boolean;
  /** When the details become due for erasure; null while they are needed. */
  dueAt: number | null;
}

/**
 * A customer is needed while any of their commissions is not collected or
 * cancelled. Once all are closed the clock starts at the latest close (or at
 * creation when there is none, or at `keepFrom` when that is later) and the
 * details are due `retentionDays` after it. A new commission makes them needed
 * again, and its closing restarts the clock.
 */
export function decideErase(i: EraseInput): EraseDecision {
  if (i.commissions.some((c) => !isClosedStatus(c.status))) return { erase: false, needed: true, dueAt: null };
  const last = i.commissions.reduce((m, c) => Math.max(m, c.closedAt), 0);
  const start = Math.max(last || i.createdAt, i.keepFrom);
  const dueAt = start + i.retentionDays * DAY_MS;
  return { erase: i.now >= dueAt, needed: false, dueAt };
}

/** What still has to be paid across a customer's commissions; a cancelled one owes nothing. */
export function totalOwed(commissions: readonly { status: CommissionStatus; balance: number }[]): number {
  return round2(commissions.reduce((sum, c) => sum + (c.status === 'cancelled' ? 0 : c.balance), 0));
}

/**
 * The commission with everything personal cleared, and what the books need
 * kept. Cleared: internal notes, the free-text details, and the messages
 * written for the customer (all free text that can name or describe a person).
 * Kept: title, price, deposit asked, currency, due date, status, the dates of
 * every step (the messages are blanked, the steps stay) and the link token.
 * Idempotent.
 */
export function eraseCommission(c: Commission, now: number): Commission {
  return {
    ...c,
    customerId: null,
    customerErasedAt: c.customerErasedAt ?? now,
    notes: '',
    description: '',
    updates: c.updates.map((u) => (u.message ? { ...u, message: '' } : u)),
  };
}

/** The name to show for a commission: the customer's, or the neutral label once erased. */
export const displayName = (customer: { name: string } | null | undefined): string => customer?.name ?? CUSTOMER_REMOVED_LABEL;
