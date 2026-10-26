import { describe, expect, it } from 'vitest';
import { materialOnHand, materialTotals, materialWaste, outstandingOf, pricePerUnit, receivedOf, recipeCostChanges, type Material } from '../engine';

/** Paper ordered in boxes that arrive when the supplier has them. */

const a3 = (purchases: Material['purchases']): Material => ({ id: 'a3', name: 'A3', type: 'paper', unit: 'sheet', packSize: 25, packName: 'box', purchases });

describe('an order that comes in parts', () => {
  it('counts only what arrived as on hand, and the rest as on order', () => {
    const m = a3([{ id: 'o1', qty: 75, cost: 30, deliveries: [{ id: 'd1', qty: 25, date: '2026-10-22' }] }]);
    expect(receivedOf(m.purchases[0]!)).toBe(25);
    expect(outstandingOf(m.purchases[0]!)).toBe(50);
    expect(materialTotals(m)).toMatchObject({ qty: 75, received: 25, onOrder: 50, spent: 30, unitCost: 0.4 });
    expect(materialOnHand(m, { used: 10, wasted: 0, recent: [] })).toBe(15);
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

describe('what paper costs, and what it makes a print cost', () => {
  const dossier = (over: Record<string, unknown> = {}) =>
    ({ id: 'd1', pid: 'p-harbour', vid: null, title: 'Harbour print A3', supplierId: null, specs: {}, lastUnitPrice: null, currency: 'EUR', targetCoverMonths: null, recipe: [{ materialId: 'a3', qty: 1 }], ...over }) as never;

  it('prices each order per sheet', () => {
    expect(pricePerUnit({ id: 'o1', qty: 75, cost: 60 })).toBe(0.8);
  });

  it('lists products whose recipe now costs something else', () => {
    // 50 sheets for 40, then 75 for 60: 100 / 125 = 0.80 a sheet.
    const paper = a3([{ id: 'o1', qty: 50, cost: 40 }, { id: 'o2', qty: 75, cost: 60, deliveries: [{ id: 'd', qty: 25, date: '2026-10-26' }] }]);
    const costs: Record<string, number | null> = { 'p-harbour': 0.85, 'p-fox': 0.8 };
    const changes = recipeCostChanges([dossier(), dossier({ id: 'd2', pid: 'p-fox', title: 'Fox' }), dossier({ id: 'd3', pid: null })], [paper], (pid) => costs[pid]);
    expect(changes).toEqual([{ dossierId: 'd1', pid: 'p-harbour', vid: null, title: 'Harbour print A3', was: 0.85, now: 0.8 }]);
  });

  it('leaves out products no longer in the catalogue', () => {
    expect(recipeCostChanges([dossier()], [a3([{ id: 'o1', qty: 10, cost: 10 }])], () => undefined)).toEqual([]);
  });
});

describe('waste', () => {
  it('is the misprints as a share of all use, at the average price paid', () => {
    const m = a3([{ id: 'o1', qty: 50, cost: 100 }]);
    expect(materialWaste(m, { used: 10, wasted: 1, recent: [] })).toEqual({ qty: 1, rate: 0.1, cost: 2 });
    expect(materialWaste(m, { used: 0, wasted: 0, recent: [] })).toEqual({ qty: 0, rate: 0, cost: 0 });
    expect(materialWaste(m, undefined)).toEqual({ qty: 0, rate: 0, cost: 0 });
  });
});
