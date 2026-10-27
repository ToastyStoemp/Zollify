import type { LoyaltyReward, LoyaltyScheme, LoyaltySettings, LoyaltyStanding } from '@zollify/shared';
import { sdk } from './runtime';

/** The server half's records, as the screens get them. */

export interface MemberView {
  id: string;
  code: string;
  email: string;
  name: string;
  joinedAt: number;
  lastEarnedAt: number | null;
  standing: LoyaltyStanding;
}
export interface LedgerRow {
  id: string;
  saleId: string | null;
  amount: number;
  at: number;
  note: string;
}
export interface GoogleView {
  issuerId: string;
  clientEmail: string;
  logoUrl: string;
  updatedAt: number;
}
export interface SettingsView {
  settings: LoyaltySettings;
  joinUrl: string;
  currency: string;
  emailEnabled: boolean;
  google: GoogleView | null;
  members: number;
}
/** What the till gets for a scanned card. */
export interface Lookup {
  member: { id: string; code: string; name: string; standing: LoyaltyStanding };
  settings: { programme: string; scheme: LoyaltyScheme; rewardCost: number; reward: LoyaltyReward; stampEvery: number; pointsPerUnit: number; minSpend: number };
}

export const api = {
  settings: () => sdk().http.get<SettingsView>('settings'),
  saveSettings: (settings: LoyaltySettings) => sdk().http.put<{ settings: LoyaltySettings }>('settings', settings),
  newJoinLink: () => sdk().http.post<{ joinUrl: string }>('settings/join-token'),
  saveGoogle: (body: { issuerId: string; serviceAccountJson: string; logoUrl: string }) => sdk().http.put<{ ok: boolean; clientEmail: string }>('google', body),
  removeGoogle: () => sdk().http.del<{ ok: boolean }>('google'),
  members: () => sdk().http.get<{ members: MemberView[] }>('members'),
  member: (id: string) => sdk().http.get<{ member: MemberView; ledger: LedgerRow[] }>(`members/${encodeURIComponent(id)}`),
  adjust: (id: string, delta: number, note: string) => sdk().http.post<{ member: MemberView }>(`members/${encodeURIComponent(id)}/adjust`, { delta, note }),
  erase: (id: string) => sdk().http.del<{ ok: boolean }>(`members/${encodeURIComponent(id)}`),
  recount: () => sdk().http.post<{ members: number }>('recount'),
  lookup: (code: string) => sdk().http.get<Lookup>(`lookup?code=${encodeURIComponent(code)}`),
};

export const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);
