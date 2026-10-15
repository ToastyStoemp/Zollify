import { COMMISSION_REF_KIND, type Commission, type CommissionCreateInput, type CommissionInput, type CustomerInput, type CommissionPayment, type CommissionSettings, type CommissionStatus } from '@zollify/shared';
import { sdk } from './runtime';
import type { CustomerContact } from './customer-form';

/**
 * Typed wrapper over this module's server half. Requests reach
 * `/api/m/commissions/…`; the host roots them there, so nothing here can
 * address another module or another account.
 */

/** A commission as the owner's screens get it: the record plus what the till has taken and its link. */
export interface CommissionView extends Commission {
  /** The customer's details, joined in by the server; the neutral "Customer removed" once erased. */
  customerName: string;
  email: string;
  phone: string;
  paid: number;
  balance: number;
  payments: CommissionPayment[];
  token: string;
  publicPath: string;
  publicUrl: string;
}

export interface CommissionList {
  commissions: CommissionView[];
  settings: CommissionSettings;
  emailEnabled: boolean;
}

/** A customer with what they ordered and when their details will be erased. */
export interface CustomerSummary extends CustomerContact {
  createdAt: number;
  commissionCount: number;
  openCount: number;
  owed: number;
  /** When the details go; null while a commission is still open. */
  erasesAt: number | null;
}

export interface CustomerDetail {
  customer: CustomerSummary;
  commissions: CommissionView[];
  keepCustomerDays: number;
}

export const api = {
  list: () => sdk().http.get<CommissionList>('commissions'),
  create: (input: CommissionCreateInput) => sdk().http.post<CommissionView>('commissions', input),
  save: (id: string, input: CommissionInput) => sdk().http.put<CommissionView>(`commissions/${id}`, input),
  update: (id: string, body: { status?: CommissionStatus; message: string; email: boolean }) =>
    sdk().http.post<{ commission: CommissionView; emailed: boolean }>(`commissions/${id}/updates`, body),
  emailLink: (id: string) => sdk().http.post<{ emailed: boolean }>(`commissions/${id}/email-link`),
  newLink: (id: string) => sdk().http.post<CommissionView>(`commissions/${id}/link`),
  remove: (id: string) => sdk().http.del<{ ok: true }>(`commissions/${id}`),
  searchCustomers: (q: string) => sdk().http.get<{ customers: CustomerContact[] }>(`customers/search?q=${encodeURIComponent(q)}`),
  customers: (q: string) => sdk().http.get<{ customers: CustomerSummary[]; keepCustomerDays: number }>(`customers?q=${encodeURIComponent(q)}`),
  customer: (id: string) => sdk().http.get<CustomerDetail>(`customers/${id}`),
  saveCustomer: (id: string, input: CustomerInput) => sdk().http.put<CustomerContact>(`customers/${id}`, input),
  eraseCustomer: (id: string) => sdk().http.post<{ ok: true; commissions: number }>(`customers/${id}/erase`),
  eraseClosedCustomers: () => sdk().http.post<{ erased: number }>('customers/erase-closed'),
  settings: () => sdk().http.get<CommissionSettings>('settings'),
  saveSettings: (s: CommissionSettings) => sdk().http.put<CommissionSettings>('settings', s),
};

export function errorText(err: unknown, fallback: string): string {
  const body = (err as { body?: { message?: string } } | null)?.body;
  if (body?.message) return body.message;
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Today in the shop's own calendar (not UTC), as YYYY-MM-DD - what "overdue" is measured against. */
export const localToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * What this device has rung up for a commission that the server has not yet
 * seen (an offline sale, say), so a deposit is never offered twice. Sales the
 * server already counted are skipped by id.
 */
export function pendingPaid(commissionId: string, counted: CommissionPayment[]): number {
  const known = new Set(counted.map((p) => p.saleId));
  let sum = 0;
  for (const tx of sdk().data.transactions.recent()) {
    if (tx.revertedAt || known.has(tx.id)) continue;
    for (const item of tx.items) if (item.ref?.moduleId === 'commissions' && item.ref.kind === COMMISSION_REF_KIND && item.ref.id === commissionId) sum += item.lineTotal;
  }
  return Math.round(sum * 100) / 100;
}
