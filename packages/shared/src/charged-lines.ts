import type { Transaction } from './types';

/**
 * A sale's line amounts in the currency the customer actually paid.
 *
 * A sale charged in a converted local currency records its lines in the
 * booth's book currency (`baseCurrency`) and only its total in the charged
 * one - the lines are what the books count, the total is what the terminal
 * took. Anything shown to the customer has to be in what they paid, so each
 * line is scaled by total/baseTotal, and the rounding remainder goes on the
 * largest line so the lines add up to exactly the charged total.
 *
 * Scaling, rather than reconverting each line at the exchange rate, is what
 * keeps a hand-set local price or rounding honest: a print charged as an
 * even EUR 50 prints as EUR 50, not as whatever CHF 47.85 reconverts to.
 *
 * An unconverted sale's amounts come back unchanged.
 */
export function chargedLineTotals(
  tx: Pick<Transaction, 'items' | 'total' | 'currency' | 'baseCurrency' | 'baseTotal' | 'discounts'>,
): number[] {
  const converted = Boolean(tx.baseCurrency) && tx.baseCurrency !== tx.currency && (tx.baseTotal ?? 0) > 0;
  if (!converted) return tx.items.map((i) => i.lineTotal);
  // Separately listed discounts are already in the charged currency; the
  // lines must add up to the total before them, or they would be taken twice.
  const discounts = (tx.discounts ?? []).reduce((s, d) => s + toMinor(d.amount), 0);
  const target = toMinor(tx.total) + discounts;
  return spreadTo(tx.items.map((i) => toMinor(i.lineTotal)), target).map((m) => m / 100);
}

const toMinor = (n: number): number => Math.round(n * 100);

export interface ReceiptBreakdown {
  /** Per item (paired with `tx.items`), at the price on the till, in the charged currency. */
  lines: number[];
  /** To subtract from the lines' sum to reach the total, in the charged currency. */
  discounts: { name: string; amount: number }[];
}

/**
 * How a receipt lists a sale: lines at list price, then each discount, adding
 * up to the total - in the currency the customer paid.
 *
 * Three kinds of sale reach here:
 *  - recorded with `asCharged` (the till's own snapshot): printed exactly as
 *    the screen showed it, discount names and all;
 *  - older sales with discounts listed separately from their lines (ZollTool
 *    imports): lines and discounts as recorded;
 *  - older sales whose discounts were spread into the lines with no record
 *    of them: lines go back to list price and the difference shows as one
 *    "Discount", so the receipt still adds up instead of showing a line that
 *    disagrees with its own unit price.
 */
export function receiptBreakdown(
  tx: Pick<Transaction, 'items' | 'total' | 'currency' | 'baseCurrency' | 'baseTotal' | 'discounts' | 'asCharged'>,
): ReceiptBreakdown {
  const snap = tx.asCharged;
  if (snap && snap.listTotals.length === tx.items.length) {
    return { lines: [...snap.listTotals], discounts: snap.discounts.map((d) => ({ name: d.name, amount: d.amount })) };
  }
  if (tx.discounts?.length) {
    return { lines: chargedLineTotals(tx), discounts: tx.discounts.map((d) => ({ name: d.name, amount: d.amount })) };
  }
  const listBase = tx.items.map((i) => Math.round(toMinor(i.unitPrice) * i.qty));
  const spread = listBase.reduce((a, b) => a + b, 0) - tx.items.reduce((s, i) => s + toMinor(i.lineTotal), 0);
  if (spread <= 0) return { lines: chargedLineTotals(tx), discounts: [] };
  const converted = Boolean(tx.baseCurrency) && tx.baseCurrency !== tx.currency && (tx.baseTotal ?? 0) > 0;
  const discount = converted ? Math.round((spread * toMinor(tx.total)) / toMinor(tx.baseTotal!)) : spread;
  return {
    lines: spreadTo(listBase, toMinor(tx.total) + discount).map((m) => m / 100),
    discounts: [{ name: 'Discount', amount: discount / 100 }],
  };
}

/** Scales whole-cent amounts to sum to `target`, the remainder on the largest. */
function spreadTo(minor: number[], target: number): number[] {
  const sum = minor.reduce((a, b) => a + b, 0);
  if (!minor.length || sum <= 0) return minor;
  const out = minor.map((m) => Math.round((m * target) / sum));
  const biggest = out.indexOf(Math.max(...out));
  out[biggest] = out[biggest]! + target - out.reduce((a, b) => a + b, 0);
  return out;
}
