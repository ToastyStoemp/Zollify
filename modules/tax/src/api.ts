import type { ExpenseDetail, SalesEvent, SplitMethod, TravelRates } from '@zollify/shared';
import { sdk } from './runtime';
import type { BookingPayload } from './engine/clusters';

/** Typed wrapper over this module's server half at `/api/m/tax/…`. */

export interface SourceRow {
  date: string;
  type: 'Payment' | 'Fee';
  amount: number;
  currency: string;
  terminal: string;
  card: string;
  ref: string;
  desc: string;
  source: 'mypos' | 'sumup' | 'shopify';
  isOnline: boolean;
  orderNum?: string;
  isManual?: boolean;
}

export interface Booking {
  voucherNumber: string;
  voucherId: string;
  kind: string;
  totalMinor: number;
  bookedAt: number;
}

export interface TaxStatus {
  enabled: Record<string, boolean>;
  mypos: { mode: 'live' | 'mock' };
  shopify: { mode: string; shop: string | null; ready: boolean; error?: string };
  sumup: { mode: 'live' | 'mock'; ready: boolean };
  lexware: { configured: boolean; feeCategory: boolean };
  ai: { configured: boolean };
  values: Record<string, string | boolean>;
  bookings: Booking[];
}

export interface ConfigField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  hint?: string;
  template?: boolean;
  select?: { value: string; label: string }[];
}
export interface ConfigGroup {
  id: string;
  label: string;
  hint: string;
  fields: ConfigField[];
}

export interface Expense {
  id: string;
  eventId: string;
  category: string;
  amount: number;
  currency: string;
  date: string;
  vendor: string;
  note: string;
  invoice: { filename: string; uploadedAt: number | null } | null;
  bookedVoucherId: string | null;
  /** How a computed expense came about (per diems, mileage, a shared cost's split); null when typed in. */
  detail: ExpenseDetail | null;
  /** Who added it; absent or null for expenses from before this was kept. */
  createdBy?: { userId: string; email: string | null } | null;
  createdAt: number;
  updatedAt: number;
}

/** A cost covering several events, split across them on the server. */
export interface SharedExpenseInput {
  eventIds: string[];
  method: SplitMethod;
  category: string;
  amount: number;
  currency: string;
  date: string;
  vendor: string;
  note: string;
}

export interface PnlRow {
  eventId: string;
  name: string;
  country: string;
  start: string;
  currency: string;
  revenue: number;
  expenses: number;
  margin: number;
  expenseCount: number;
  unbooked: number;
  currencies: string[];
  byCategory: Record<string, number>;
}

export interface InvoiceScan {
  fields: { vendor: string; category: string; amount: number; currency: string; date: string; stayStart: string; stayEnd: string; country: string; confidence: number };
  match: { eventId: string; name: string } | null;
  candidates: { eventId: string; name: string; score: number; why: string[] }[];
  remainingToday: number;
}

const q = (params: Record<string, string | undefined>): string =>
  '?' + new URLSearchParams(Object.fromEntries(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])))).toString();

/** The printing side of a year, from Sourcing: materials bought and misprints, in the account's currency. */
export interface YearMaterials {
  materials: { spent: number; orders: number; byType: Record<string, number> };
  waste: { qty: number; cost: number; byMaterial: { id: string; name: string; unit: string; qty: number; cost: number }[] };
}

/** A card the phone has named by its last four digits; `role` is null until the owner marks it. */
export interface CardRow {
  last4: string;
  role: 'business' | 'personal' | null;
  label: string;
}
/** A payment the phone saw on a card (Google Wallet), kept until dismissed. */
export interface CardPayment {
  id: string;
  at: number;
  amount: number;
  currency: string;
  merchant: string;
  last4: string;
  addedExpenseId: string | null;
}

export const api = {
  cards: () => sdk().http.get<{ cards: CardRow[] }>('cards'),
  markCard: (last4: string, role: 'business' | 'personal', label: string) => sdk().http.put<{ ok: boolean }>(`cards/${last4}`, { role, label }),
  cardPayments: () => sdk().http.get<{ payments: CardPayment[] }>('card-payments'),
  sendCardPayment: (body: { id: string; at: number; amount: number; currency: string; merchant: string; last4: string }) => sdk().http.post<{ stored: boolean; duplicate: boolean }>('card-payments', body),
  /** Quick-adds a card payment as an expense on the event; the same payment can be added again. */
  addCardPayment: (id: string, body: { eventId: string; category: string; vendor?: string; note?: string }) => sdk().http.post<{ expense: Expense }>(`card-payments/${id}/add`, body),
  dismissCardPayment: (id: string) => sdk().http.del<{ ok: boolean }>(`card-payments/${id}`),
  /** A period's books as one zip - sales, lines, expenses and their invoices - for the accountant. */
  export: (from: string, to: string) => sdk().http.get<{ filename: string; base64: string; counts: { sales: number; lines: number; expenses: number; invoices: number } }>(`export${q({ from, to })}`),
  year: (year: number) => sdk().http.get<YearMaterials>(`year/${year}`),
  status: () => sdk().http.get<TaxStatus>('status'),
  config: () => sdk().http.get<{ groups: ConfigGroup[]; values: Record<string, string | boolean>; enabled: Record<string, boolean> }>('config'),
  saveConfig: (patch: { set?: Record<string, string>; clear?: string[]; enabled?: Record<string, boolean> }) =>
    sdk().http.put<{ ok: true; values: Record<string, string | boolean>; enabled: Record<string, boolean> }>('config', patch),
  testConfig: (group: string) => sdk().http.post<{ ok: boolean; detail: string }>('config/test', { group }),

  events: () => sdk().http.get<{ events: SalesEvent[] }>('events'),
  eventCash: (eventId: string) => sdk().http.get<{ cash: number; currency: string; count: number; taken?: Record<string, number> }>(`events/${encodeURIComponent(eventId)}/cash`),

  myposAccounts: () => sdk().http.get<{ mode: string; accounts: { account_number: string; currency?: string; name?: string }[] }>('mypos/accounts'),
  myposTransactions: (from: string, to: string, accounts?: string[]) =>
    sdk().http.get<{ mode: string; transactions: SourceRow[] }>('mypos/transactions' + q({ from, to, accounts: accounts?.join(',') })),
  myposVerify: (from: string, to: string) =>
    sdk().http.get<{ mode: string; summary: { gross: number; fees: number; net: number; count: number } }>('mypos/verify' + q({ from, to })),
  shopifyOrders: (from: string, to: string) => sdk().http.get<{ mode: string; orders: SourceRow[] }>('shopify/orders' + q({ from, to })),
  sumupTransactions: (from: string, to: string) => sdk().http.get<{ mode: string; transactions: SourceRow[] }>('sumup/transactions' + q({ from, to })),

  book: (payload: BookingPayload & { dryRun: boolean }) =>
    sdk().http.post<{ dryRun: boolean; voucherId?: string; permalink?: string }>('lexware/book', payload),
  bookings: () => sdk().http.get<{ bookings: Booking[] }>('bookings'),

  expenses: (eventId?: string) => sdk().http.get<{ categories: { id: string; label: string }[]; expenses: Expense[] }>('ledger/expenses' + q({ eventId })),
  /** The categories alone - all a staff member's quick expense may read. */
  categories: () => sdk().http.get<{ categories: { id: string; label: string }[] }>('ledger/categories'),
  addExpense: (e: Partial<Expense>) => sdk().http.post<{ expense: Expense }>('ledger/expenses', e),
  updateExpense: (id: string, e: Partial<Expense>) => sdk().http.put<{ expense: Expense }>(`ledger/expenses/${id}`, e),
  deleteExpense: (id: string) => sdk().http.del<{ ok: true }>(`ledger/expenses/${id}`),
  addShared: (e: SharedExpenseInput) => sdk().http.post<{ expenses: Expense[] }>('ledger/expenses/shared', e),
  rates: () => sdk().http.get<{ rates: TravelRates; defaults: string[] }>('ledger/rates'),
  saveRates: (rates: TravelRates) => sdk().http.put<{ rates: TravelRates }>('ledger/rates', rates),
  resetRates: (homeCountry: string) => sdk().http.post<{ rates: TravelRates }>('ledger/rates/reset', { homeCountry }),
  invoice: (id: string) => sdk().http.get<{ filename: string; base64: string }>(`ledger/expenses/${id}/invoice`),
  attachInvoice: (id: string, base64: string, filename: string) => sdk().http.post<{ expense: Expense }>(`ledger/expenses/${id}/invoice`, { base64, filename }),
  pnl: () => sdk().http.get<{ rows: PnlRow[] }>('ledger/pnl'),
  scanInvoice: (base64: string) => sdk().http.post<InvoiceScan>('ledger/parse', { base64 }),
};
