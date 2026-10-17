import type { Transaction } from './types';

/**
 * A sale's money in the base currency.
 *
 * A converted sale is charged in a local currency (115 SEK) at the event's
 * pricing rate, which is often deliberately round. What it is worth in the
 * base currency is the charged amount at the day's market rate (115 SEK at
 * 11.13 = EUR 10.33), not the catalogue figure (EUR 10). The till records
 * that rate with the sale (`marketRate`); an older sale, or one made offline
 * with no recent rate, falls back to a rate looked up for its date, and only
 * then to the catalogue figure (`baseTotal`).
 */

/** The multiplier from a sale's charged currency to `base`. */
export function toBaseFactor(
  tx: Pick<Transaction, 'currency' | 'baseCurrency' | 'baseTotal' | 'total' | 'marketRate'>,
  base: string,
  /** A rate looked up for the sale's date: 1 charged unit = `lookedUp` base units. */
  lookedUp?: number | null,
): number {
  if (tx.currency === base) return 1;
  const book = tx.baseCurrency ?? tx.currency;
  if (book === base && tx.marketRate && tx.marketRate.rate > 0) return 1 / tx.marketRate.rate;
  if (lookedUp != null && lookedUp > 0) return lookedUp;
  if (book === base && tx.baseTotal != null && tx.total) return tx.baseTotal / tx.total;
  return 1;
}

/** What a sale is worth in `base`. */
export function baseValueOf(
  tx: Pick<Transaction, 'currency' | 'baseCurrency' | 'baseTotal' | 'total' | 'marketRate'>,
  base: string,
  lookedUp?: number | null,
): number {
  return Math.round(tx.total * toBaseFactor(tx, base, lookedUp) * 100) / 100;
}

/** Whether a rate still has to be looked up for this sale to be shown in `base` (it has none of its own). */
export function needsRateLookup(tx: Pick<Transaction, 'currency' | 'baseCurrency' | 'marketRate'>, base: string): boolean {
  if (tx.currency === base) return false;
  return !((tx.baseCurrency ?? tx.currency) === base && tx.marketRate && tx.marketRate.rate > 0);
}
