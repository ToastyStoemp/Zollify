import { describe, expect, it } from 'vitest';
import { averageUnitCost, currentLot, currentUnitCost, materialLots, recipeCost, type CostedMaterial } from '../material-cost';

/**
 * What a print costs follows the batch being used up: the 50 box until it
 * runs out, then the 60 one - and ink the same, cartridge by cartridge.
 */

const paper: CostedMaterial = {
  id: 'a3',
  purchases: [
    { id: 'box1', qty: 25, cost: 50, date: '2026-09-01' },
    { id: 'box2', qty: 25, cost: 60, date: '2026-10-01' },
  ],
};
// Cartridges of 70 ml: the second one dearer.
const ink: CostedMaterial = {
  id: 'ink',
  purchases: [
    { id: 'c1', qty: 70, cost: 35, date: '2026-08-01' },
    { id: 'c2', qty: 70, cost: 42, date: '2026-10-10' },
  ],
};

describe('first in, first out', () => {
  it('prices the next sheet at the batch now being used', () => {
    expect(currentUnitCost(paper, 0)).toBe(2);
    expect(currentUnitCost(paper, 24)).toBe(2);
    // The first box is used up: the second one's price.
    expect(currentUnitCost(paper, 25)).toBe(2.4);
    expect(currentLot(paper, 30)).toMatchObject({ purchaseId: 'box2', remaining: 20 });
  });

  it('keeps the last price once everything is used, and is nothing before anything was bought', () => {
    expect(currentUnitCost(paper, 80)).toBe(2.4);
    expect(currentLot(paper, 80)).toBeNull();
    expect(currentUnitCost({ id: 'x', purchases: [] }, 0)).toBe(0);
  });

  it('takes batches in the order they arrived, deliveries of a part-sent order each on their date', () => {
    const m: CostedMaterial = {
      id: 'a4',
      purchases: [
        { id: 'late', qty: 50, cost: 30, date: '2026-10-20', deliveries: [{ qty: 25, date: '2026-10-21' }, { qty: 25, date: '2026-11-05' }] },
        { id: 'early', qty: 10, cost: 10, date: '2026-10-01' },
      ],
    };
    expect(materialLots(m, 12).map((l) => [l.purchaseId, l.remaining])).toEqual([
      ['early', 0],
      ['late', 23],
      ['late', 25],
    ]);
    expect(currentUnitCost(m, 12)).toBe(0.6);
  });

  it('gives back what a recount found as unused', () => {
    expect(currentUnitCost(paper, -5)).toBe(2);
  });

  it('keeps the average apart, for comparison', () => {
    expect(averageUnitCost(paper)).toBe(2.2);
  });
});

describe('a print from its recipe', () => {
  it('costs each material at its current batch', () => {
    const recipe = [{ materialId: 'a3', qty: 1 }, { materialId: 'ink', qty: 2 }];
    // 2.00 for the sheet + 2 ml at 0.50.
    expect(recipeCost(recipe, [paper, ink], () => 0).total).toBe(3);
    // Box 1 used up, cartridge 1 empty: 2.40 + 2 × 0.60.
    const used: Record<string, number> = { a3: 25, ink: 70 };
    expect(recipeCost(recipe, [paper, ink], (id) => used[id] ?? 0).total).toBe(3.6);
  });
});
