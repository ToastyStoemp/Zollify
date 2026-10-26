import { describe, expect, it } from 'vitest';
import { materialOnHand, materialTotals, outstandingOf, receivedOf, type Material } from '../engine';

/** Paper ordered in boxes that arrive when the supplier has them. */

const a3 = (purchases: Material['purchases']): Material => ({ id: 'a3', name: 'A3', type: 'paper', unit: 'sheet', packSize: 25, packName: 'box', purchases });

describe('an order that comes in parts', () => {
  it('counts only what arrived as on hand, and the rest as on order', () => {
    const m = a3([{ id: 'o1', qty: 75, cost: 30, deliveries: [{ id: 'd1', qty: 25, date: '2026-10-22' }] }]);
    expect(receivedOf(m.purchases[0]!)).toBe(25);
    expect(outstandingOf(m.purchases[0]!)).toBe(50);
    expect(materialTotals(m)).toMatchObject({ qty: 75, received: 25, onOrder: 50, spent: 30, unitCost: 0.4 });
    expect(materialOnHand(m, { used: 10, recent: [] })).toBe(15);
  });

  it('is on order in full until the first box arrives', () => {
    const m = a3([{ id: 'o1', qty: 75, cost: 30, deliveries: [] }]);
    expect(materialTotals(m)).toMatchObject({ received: 0, onOrder: 75 });
  });

  it('treats a purchase without deliveries as arrived in full, as before', () => {
    const m = a3([{ id: 'o1', qty: 50, cost: 20 }]);
    expect(materialTotals(m)).toMatchObject({ received: 50, onOrder: 0 });
    expect(materialOnHand(m, undefined)).toBe(50);
  });
});
