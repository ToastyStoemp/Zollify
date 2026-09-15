import type { CostBatch, CostBatchLine } from '@zollify/shared';

export interface CostLineResult extends CostBatchLine {
  /** Weight used to split the overhead across lines. */
  weight: number;
  /** Final per-unit cost = known unit cost + this line's share of overhead. */
  final: number;
  /** final × qty. */
  lineTotal: number;
}
export interface CostComputation {
  lines: CostLineResult[];
  /** Σ known unit costs × qty. */
  productionSum: number;
  /** total − productionSum, clamped to ≥ 0 (the shipping/import/fees to spread). */
  overhead: number;
  /** Σ line totals - should land on `total` once fully allocated. */
  allocated: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Distribute a batch's single lump total across its units. Any per-line unit
 * cost that's already known is kept as-is; the remainder (shipping + import +
 * fees, or the whole total when no unit costs are given) is spread by the chosen
 * weighting - evenly per unit, or by each line's sell value (price × qty) so
 * pricier items carry more of the overhead.
 */
export function computeBatch(batch: CostBatch, priceOf: (pid: string, vid: string) => number): CostComputation {
  const lines = batch.lines.filter((l) => l.qty > 0);
  const productionSum = lines.reduce((s, l) => s + (l.unitCost ?? 0) * l.qty, 0);
  const overhead = Math.max(0, (batch.total || 0) - productionSum);
  const weightOf = (l: CostBatchLine): number =>
    batch.weighting === 'value' ? Math.max(0, priceOf(l.pid, l.vid)) * l.qty : l.qty;
  const weights = lines.map(weightOf);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const results: CostLineResult[] = lines.map((l, i) => {
    const share = weightSum > 0 ? (overhead * weights[i]!) / weightSum : 0;
    const final = round2((l.unitCost ?? 0) + share / l.qty);
    return { ...l, weight: weights[i]!, final, lineTotal: round2(final * l.qty) };
  });
  return {
    lines: results,
    productionSum: round2(productionSum),
    overhead: round2(overhead),
    allocated: round2(results.reduce((s, r) => s + r.lineTotal, 0)),
  };
}

/**
 * Current per-unit cost for every product/variant that appears in any batch:
 * the value from the most recent batch (by date, then edit time) that includes
 * it. So a later, cheaper order wins, and editing an old batch only changes a
 * product's cost when that batch is still its latest source.
 */
export function resolveCurrentCosts(
  batches: CostBatch[],
  priceOf: (pid: string, vid: string) => number,
): { pid: string; vid: string; cost: number }[] {
  const sorted = [...batches]
    .filter((b) => !b.deletedAt)
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.updatedAt - b.updatedAt);
  const out = new Map<string, { pid: string; vid: string; cost: number }>();
  for (const b of sorted) {
    for (const l of computeBatch(b, priceOf).lines) out.set(`${l.pid}:${l.vid}`, { pid: l.pid, vid: l.vid, cost: l.final });
  }
  return [...out.values()];
}
