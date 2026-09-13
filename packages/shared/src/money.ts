export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fmtAmount(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toFixed(2);
}

export function fmtPrice(n: number | null | undefined, currency: string): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `${currency} ${n.toFixed(2)}`;
}

/** Rounds to the nearest `increment` (e.g. 5/10/20/50). 0/negative falls back to cents. */
export function roundToIncrement(n: number, increment: number): number {
  if (!increment || increment <= 0) return round2(n);
  return Math.round(n / increment) * increment;
}

/** Converts a base-currency amount to a local currency, rounded to `increment`. */
export function toLocalPrice(baseAmount: number, rate: number, increment: number): number {
  return roundToIncrement(baseAmount * rate, increment);
}
