/**
 * Splits `amount` over parts in proportion to `weights`, so the shares add
 * up to `amount` exactly.
 *
 * Whole currency units whenever the amount and every weight are whole
 * (a 15 bundle discount on three 40 prints is 5 / 5 / 5, never 5.00 /
 * 4.99 / 5.01), otherwise cents. Each share is rounded down and the units
 * left over go to the parts with the largest remainders - ties to the
 * earlier part - so the result is stable and as even as possible.
 *
 * Customs documents read these shares straight into declared values, which
 * is why they should not carry cents a booth never charged.
 */
export function splitAmount(amount: number, weights: number[], opts: { wholeUnits?: boolean } = {}): number[] {
  if (!weights.length) return [];
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0 || amount === 0) return weights.map(() => 0);
  // `wholeUnits` forces whole units for a whole amount even when a price has
  // cents - customs declares whole units whatever the till charged.
  const whole = Number.isInteger(amount) && (opts.wholeUnits || weights.every((w) => Number.isInteger(w)));
  const unit = whole ? 1 : 100;
  const target = Math.round(amount * unit);
  const exact = weights.map((w) => (Math.max(0, w) * target) / total);
  const out = exact.map((v) => Math.floor(v + 1e-9));
  let left = target - out.reduce((s, v) => s + v, 0);
  const order = exact.map((v, i) => ({ i, rem: v - out[i]! })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) out[order[k]!.i]! += 1;
  return out.map((v) => v / unit);
}
