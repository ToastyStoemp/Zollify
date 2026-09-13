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

/** Up to 4 plausible cash amounts above the total (1-, 2-, then 3-bill sums). */
export function cashShortcutAmounts(total: number, currency: string): number[] {
  const bills = CURRENCY_BILLS[currency] || FALLBACK_BILLS;
  const candidates = new Set<number>();

  for (const b of bills) {
    if (b > total) candidates.add(b);
  }
  for (const b1 of bills) {
    for (const b2 of bills) {
      const s = b1 + b2;
      if (s > total) candidates.add(s);
    }
  }
  if (candidates.size < 4) {
    for (const b1 of bills) {
      for (const b2 of bills) {
        for (const b3 of bills) {
          const s = b1 + b2 + b3;
          if (s > total) candidates.add(s);
        }
      }
    }
  }
  return [...candidates].sort((a, b) => a - b).slice(0, 4);
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
