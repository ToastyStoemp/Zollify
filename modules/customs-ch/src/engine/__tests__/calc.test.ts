import { describe, expect, it } from 'vitest';
import type { CustomsProduct, CustomsState } from '../model';
import { defaultCustomsArtist, defaultCustomsEdec, defaultCustomsMeta } from '../model';
import { calcProduct, compute1174Groups, hasCustomsInfo } from '../calc';

function product(over: Partial<CustomsProduct>): CustomsProduct {
  return {
    id: 'p', title: 'Item', type: 'Other', forSale: true, unlisted: false,
    price: 10, weightG: 100, tariffNo: '4911.91.00', tariffRate: 8.1, vatRate: 8.1,
    amount: 10, soldQty: 5, soldValue: 50, variants: [], ...over,
  };
}

function state(products: CustomsProduct[], form1174: CustomsState['form1174']): CustomsState {
  return {
    meta: { ...defaultCustomsMeta(), currency: 'CHF' },
    artist: { ...defaultCustomsArtist(), fullName: 'Jane Doe' },
    edec: defaultCustomsEdec(),
    form1174,
    products,
  };
}

/** Same eligibility the goods list and both proformas use - what 11.74/11.87's totals must match. */
function eligibleTotals(products: CustomsProduct[]): { qty: number; weightKg: number; value: number } {
  let qty = 0, weightKg = 0, value = 0;
  for (const p of products) {
    if (!hasCustomsInfo(p) || calcProduct(p).amount <= 0) continue;
    const c = calcProduct(p);
    qty += c.amount;
    weightKg += c.totalWeightKg;
    if (c.totalValue != null) value += c.totalValue;
  }
  return { qty, weightKg: Math.round(weightKg * 1000) / 1000, value };
}

describe('compute1174Groups - totals match the import list / proforma', () => {
  const eligibleA = product({ id: 'a', title: 'Art Print', tariffNo: '4911.91.00', amount: 5, weightG: 100, price: 10 });
  const eligibleB = product({ id: 'b', title: 'Enamel Pin', tariffNo: '7117.19.00', amount: 3, weightG: 20, price: 8 });
  // A booth display stand: has an amount and a tariff no, but is marked
  // unlisted (not merchandise) - hasCustomsInfo excludes it, same as it's
  // excluded from the goods list and both proformas.
  const unlistedEquipment = product({ id: 'eq', title: 'Display Stand', tariffNo: '3926.90.00', amount: 2, weightG: 2000, price: 80, unlisted: true });
  // Nothing brought this event - a real product, but zero computed amount.
  const zeroStock = product({ id: 'z', title: 'Sold Out Print', tariffNo: '4911.91.00', amount: 0, soldQty: 0, soldValue: 0 });

  const products = [eligibleA, eligibleB, unlistedEquipment, zeroStock];
  const expected = eligibleTotals(products);

  it('auto mode: G1 + G2 exclude unlisted and zero-stock products', () => {
    const { g1, g2 } = compute1174Groups(state(products, { groupMode: 'auto', assignments: [] }));
    expect(g1.qty + g2.qty).toBe(expected.qty);
    expect(Math.round((g1.weightKg + g2.weightKg) * 1000) / 1000).toBe(expected.weightKg);
    expect(g1.value + g2.value).toBe(expected.value);
  });

  it('manual mode: G1 + G2 still exclude them, whichever group they were assigned to', () => {
    // Index-aligned with `products` above: the unlisted equipment and the
    // zero-stock item are explicitly assigned to a group, same as the UI
    // lets you do for any product - they must still be excluded from the sums.
    const assignments = [1, 2, 1, 2];
    const { g1, g2 } = compute1174Groups(state(products, { groupMode: 'manual', assignments }));
    expect(g1.qty + g2.qty).toBe(expected.qty);
    expect(Math.round((g1.weightKg + g2.weightKg) * 1000) / 1000).toBe(expected.weightKg);
    expect(g1.value + g2.value).toBe(expected.value);
  });

  it('manual mode: assignment indices still line up with the original product list', () => {
    // eligibleA (index 0) -> G1, eligibleB (index 1) -> G2, regardless of
    // what sits at the ineligible indices in between.
    const assignments = [1, 2, 1, 2];
    const { g1prods, g2prods } = compute1174Groups(state(products, { groupMode: 'manual', assignments }));
    expect(g1prods.map((p) => p.id)).toEqual(['a']);
    expect(g2prods.map((p) => p.id)).toEqual(['b']);
  });
});
