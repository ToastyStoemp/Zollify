import { describe, expect, it } from 'vitest';
import type { Transaction } from '@zollify/shared';
import { computeRestock, type Dossier } from '../engine';

const dossier = (id: string, pid: string, vid: string | null): Dossier => ({
  id, pid, vid, title: id, supplierId: null, specs: {} as Dossier['specs'], lastUnitPrice: null, currency: 'EUR', targetCoverMonths: 3, recipe: [],
});
const DAY = 86400000;
// 30 sold over the last 90 days: 10 a month.
const sales = (vid: string | null): Transaction[] =>
  [90, 60, 30].map((daysAgo, i) => ({
    id: `t${i}${vid}`, eventId: 'e', deviceId: 'd', timestamp: Date.now() - daysAgo * DAY, method: 'cash', payments: [], discounts: [], total: 10, currency: 'EUR',
    items: [{ pid: 'print', vid, title: 'Print', qty: 10, unitPrice: 1, lineTotal: 10 }],
  }));

describe('restock', () => {
  it('works from what is here now, not the last count', () => {
    // Counted 40, sold 30 since: 10 left, one month of cover, order 20 for three.
    const [row] = computeRestock([dossier('d', 'print', '')], sales(null), () => 10);
    expect(row).toMatchObject({ soldPerMonth: 10, onHand: 10, monthsCover: 1, due: true, suggestQty: 20 });
  });

  it('a dossier saved without a variant counts every variant’s sales', () => {
    const [row] = computeRestock([dossier('d', 'print', null)], [...sales('a4'), ...sales('a5')], () => 0);
    expect(row!.soldPerMonth).toBe(20);
  });
});
