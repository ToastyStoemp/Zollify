import type { DayJournal, EconomicSettings } from '@zollify/shared';
import { sdk } from './runtime';

/** Typed calls to this module's server half (/api/m/economic/…). */

export interface Connection {
  /** This server is registered with e-conomic. */
  server: boolean;
  /** The store has connected its agreement. */
  grant: boolean;
}
export interface Booking {
  day: string;
  status: 'pending' | 'booked';
  voucherNumber: number | null;
  year: string | null;
  totalMinor: number;
  note: string | null;
  createdAt: number;
}
export interface DaySummary {
  day: string;
  total: number;
  currency: string | null;
  sales: number;
  reversals: number;
  problems: string[];
  open: boolean;
  booking: Booking | null;
}

export const loadSettings = () => sdk().http.get<{ settings: EconomicSettings } & Connection>('settings');
export const saveSettings = (settings: EconomicSettings) => sdk().http.put<{ settings: EconomicSettings } & Connection>('settings', settings);
export const saveGrant = (token: string | null) => sdk().http.put<Connection>('grant', { token });
export const testConnection = () => sdk().http.post<{ ok: true; company: string | null; agreementNumber: number | null }>('test', {});

export const loadDays = (from: string, to: string) => sdk().http.get<{ days: DaySummary[] }>(`days?from=${from}&to=${to}`);
export const loadDay = (day: string) => sdk().http.get<{ journal: DayJournal; booking: Booking | null; open: boolean }>(`days/${day}`);
export const bookDay = (day: string) => sdk().http.post<{ booking: Booking }>(`days/${day}/book`, {});
export const freeDay = (day: string) => sdk().http.del<{ ok: true }>(`days/${day}/booking`);

export function errorText(err: unknown, fallback: string): string {
  const body = (err as { body?: { message?: string } } | null)?.body;
  return body?.message ?? (err instanceof Error ? err.message : fallback);
}
