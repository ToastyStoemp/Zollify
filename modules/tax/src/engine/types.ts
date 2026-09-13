/**
 * The clustering domain. A `Txn` is one payment or fee row from any source; a
 * `Cluster` is a run of them on one device with no gap longer than a day and a
 * half — which, at a convention, is one event. Online orders skip clustering
 * and are grouped per calendar month instead.
 */

export type TxnSource = 'mypos' | 'shopify' | 'sumup' | 'wise';

export interface Txn {
  id: string;
  /** Epoch ms. Stored as a number so the cluster survives JSON round-trips. */
  at: number;
  type: 'Payment' | 'Fee';
  /** Signed: + payment, − fee. */
  amount: number;
  currency: string;
  terminal: string;
  card: string;
  ref: string;
  desc: string;
  source: TxnSource;
  isOnline?: boolean;
  isManual?: boolean;
  orderNum?: string;
}

export interface MatchedEvent {
  id: string;
  name: string;
  dateStart: string;
  dateEnd: string;
  country: string;
}

export interface Cluster {
  uid: string;
  clusterID: string;
  device: string;
  /** Constituent devices when clusters from several terminals were merged. */
  devices?: string[];
  txns: Txn[];
  customName: string;
  country: string;
  cashAmount: number;
  cashNote: string;
  cashLoaded?: boolean;
  isOnlineCluster: boolean;
  manualOnline?: boolean;
  monthKey?: string;
  matchedEvent: MatchedEvent | null;
  bookedVoucherId: string | null;
  verify?: { gross: number; fees: number; diff: number; ok: boolean; mode: string } | { error: string } | null;
  // Derived from txns:
  payments: Txn[];
  fees: Txn[];
  totalPay: number;
  totalFee: number;
  net: number;
  start: number;
  end: number;
}

export const rid = (): string => Math.random().toString(36).slice(2);
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
export const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const monthKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
};
