import type { CommissionCreateInput } from '@zollify/shared';

/**
 * What the customer part of the commission form means, kept pure so it is
 * tested without a browser: a customer picked from the list, or one typed in
 * the same form - and the line that tells everyone how long details are kept.
 */

export interface CustomerContact {
  id: string;
  name: string;
  email: string;
  phone: string;
}

export interface CustomerChoice {
  /** An existing customer chosen from the search; null while typing a new one. */
  picked: CustomerContact | null;
  name: string;
  email: string;
  phone: string;
}

export const emptyChoice = (): CustomerChoice => ({ picked: null, name: '', email: '', phone: '' });

export const choiceOf = (c: CustomerContact): CustomerChoice => ({ picked: c, name: c.name, email: c.email, phone: c.phone });

/** The customer fields of a create request. `force` adds the typed-in customer although one like them exists. */
export function customerFields(choice: CustomerChoice, force = false): Pick<CommissionCreateInput, 'customerId' | 'customer' | 'forceNewCustomer'> {
  if (choice.picked) return { customerId: choice.picked.id, forceNewCustomer: false };
  return { customer: { name: choice.name, email: choice.email, phone: choice.phone }, forceNewCustomer: force };
}

/** The rule, in one line, for the form and the customer's page. */
export function retentionLine(days: number): string {
  if (days <= 0) return 'Details are erased as soon as their last commission closes.';
  return `Details are erased ${days} ${days === 1 ? 'day' : 'days'} after their last commission closes.`;
}

/** When a customer's details go: still in use, or a date. */
export function erasureNote(erasesAt: number | null, openCount: number): string {
  if (openCount > 0 || erasesAt === null) return 'In use: a commission is still open.';
  return `Details are erased on ${new Date(erasesAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}.`;
}

/** The server's offer of existing customers when the one typed in looks like them, or null for any other error. */
export function duplicatesIn(err: unknown): CustomerContact[] | null {
  const body = (err as { body?: { error?: string; matches?: CustomerContact[] } } | null)?.body;
  return body?.error === 'customer_exists' && Array.isArray(body.matches) ? body.matches : null;
}
