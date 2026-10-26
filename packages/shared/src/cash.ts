/** Real note denominations per currency (smallest → largest). Port of pos.html. */
export const CURRENCY_BILLS: Record<string, number[]> = {
  CHF: [10, 20, 50, 100, 200],
  EUR: [5, 10, 20, 50, 100, 200],
  USD: [1, 5, 10, 20, 50, 100],
  GBP: [5, 10, 20, 50],
  SGD: [5, 10, 20, 50, 100],
  JPY: [1000, 2000, 5000, 10000],
  AUD: [5, 10, 20, 50, 100],
  CAD: [5, 10, 20, 50, 100],
  DKK: [50, 100, 200, 500, 1000],
  NOK: [50, 100, 200, 500, 1000],
  SEK: [20, 50, 100, 200, 500, 1000],
  HKD: [10, 20, 50, 100, 500],
};

const FALLBACK_BILLS = [5, 10, 20, 50, 100, 200];

/** Coins in circulation per currency, for counting a cash box. */
export const CURRENCY_COINS: Record<string, number[]> = {
  CHF: [0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  EUR: [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2],
  USD: [0.01, 0.05, 0.1, 0.25, 0.5, 1],
  GBP: [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2],
  SGD: [0.05, 0.1, 0.2, 0.5, 1],
  JPY: [1, 5, 10, 50, 100, 500],
  AUD: [0.05, 0.1, 0.2, 0.5, 1, 2],
  CAD: [0.05, 0.1, 0.25, 1, 2],
  DKK: [0.5, 1, 2, 5, 10, 20],
  NOK: [1, 5, 10, 20],
  SEK: [1, 2, 5, 10],
  HKD: [0.1, 0.2, 0.5, 1, 2, 5, 10],
};

/** Every denomination for a currency, largest first - the order a box is counted in. */
export function denominationsFor(currency: string): number[] {
  const all = [...(CURRENCY_BILLS[currency] ?? FALLBACK_BILLS), ...(CURRENCY_COINS[currency] ?? [])];
  return all.sort((a, b) => b - a);
}

/** Most notes a customer is taken to hand over at once, and most coins with them. */
const MAX_BILLS = 5;
const MAX_COINS = 2;
/** Suggestions shown at most, beside Exact. */
const MAX_SUGGESTIONS = 5;

/**
 * The coins people round a payment up with: whole units and up, and at least
 * a fifth of the smallest note - a 1 and 2 euro, a 2 and 5 franc, a 10 and 20
 * krone - never the small change. A coin a note already covers is left out.
 */
function roundingCoins(currency: string, bills: number[]): number[] {
  const floor = Math.max(1, Math.min(...bills) / 5);
  return (CURRENCY_COINS[currency] ?? []).filter((c) => c >= floor && !bills.includes(c));
}

/**
 * Up to 5 amounts a customer plausibly hands over for `total`, smallest
 * first; paying exactly has its own button.
 *
 * A hand is notes, and up to two of the larger coins to round it. Plausible
 * means nothing in the hand is spare: take the smallest piece away and the
 * rest no longer pays. For 15 that is a 20, a 50, a 100 - never 20 + 5 (the
 * 20 alone pays) nor 20 + 20; for 35 it is 20 + 20 = 40 too, and for 12.50
 * 10 + 2 + 1, 10 + 2 + 2 and 10 + 5. Past what five notes cover, the total
 * rounded up to each of the three largest notes.
 */
export function cashShortcutAmounts(total: number, currency: string): number[] {
  const notes = CURRENCY_BILLS[currency] || FALLBACK_BILLS;
  const bills = notes.map((b) => Math.round(b * 100));
  // Notes and coins together, smallest first; a hand takes them largest first.
  const pieces = [...bills.map((value) => ({ value, coin: false })), ...roundingCoins(currency, notes).map((c) => ({ value: Math.round(c * 100), coin: true }))].sort((a, b) => a.value - b.value);
  const due = Math.round(total * 100);
  const found = new Set<number>();
  // Every hand, largest piece first, so `smallest` is the piece just added.
  const hand = (from: number, sum: number, notesIn: number, coinsIn: number, smallest: number): void => {
    if (notesIn + coinsIn > 0 && sum > due) {
      if (sum - smallest < due) found.add(sum);
      return; // A further piece would be spare.
    }
    for (let i = from; i >= 0; i--) {
      const p = pieces[i]!;
      if (p.coin ? coinsIn === MAX_COINS : notesIn === MAX_BILLS) continue;
      hand(i, sum + p.value, notesIn + (p.coin ? 0 : 1), coinsIn + (p.coin ? 1 : 0), p.value);
    }
  };
  hand(pieces.length - 1, 0, 0, 0, 0);
  if (!found.size) {
    for (const b of bills.slice(-3)) {
      const up = Math.ceil(due / b) * b;
      found.add(up > due ? up : up + b);
    }
  }
  return [...found].sort((a, b) => a - b).slice(0, MAX_SUGGESTIONS).map((c) => c / 100);
}

/** Cash-portion suggestions for split payments: bills below total + 25/50/75%. */
export function splitCashPortionAmounts(total: number, currency: string): number[] {
  const bills = CURRENCY_BILLS[currency] || FALLBACK_BILLS;
  const candidates = new Set<number>();
  bills.forEach((b) => {
    if (b > 0 && b < total) candidates.add(b);
  });
  [0.25, 0.5, 0.75].forEach((part) => {
    const amount = Math.round(total * part * 100) / 100;
    if (amount > 0 && amount < total) candidates.add(amount);
  });
  return [...candidates].sort((a, b) => a - b).slice(0, 5);
}
