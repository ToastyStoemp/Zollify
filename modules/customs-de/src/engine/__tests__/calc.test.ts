import { describe, expect, it } from 'vitest';
import { calcDeProduct } from '../calc';
import type { CustomsDeProduct } from '../model';

const product = (over: Partial<CustomsDeProduct> = {}): CustomsDeProduct => ({
  amount: 10,
  soldQty: 0,
  soldValue: 0,
  price: 20,
  weightG: 100,
  ...over,
});

describe('calcDeProduct', () => {
  it('re-import quantity is what was brought minus what sold', () => {
    const c = calcDeProduct(product({ amount: 10, soldQty: 4, price: 20, weightG: 100 }));
    expect(c.reimportQty).toBe(6);
    expect(c.reimportWeightKg).toBe(0.6);
    expect(c.reimportValue).toBe(120);
    expect(c.totalWeightKg).toBe(1);
    expect(c.totalValue).toBe(200);
  });

  it('never goes negative when more sold than brought (a correction mid-event)', () => {
    const c = calcDeProduct(product({ amount: 5, soldQty: 8 }));
    expect(c.reimportQty).toBe(0);
    expect(c.reimportWeightKg).toBe(0);
    expect(c.reimportValue).toBe(0);
  });

  it('has no value when the product has no price', () => {
    const c = calcDeProduct(product({ price: null }));
    expect(c.totalValue).toBeNull();
    expect(c.reimportValue).toBeNull();
  });

  it('excludes unlisted variants from the total - same rule as an unlisted product, so the proforma invoice and packing list agree', () => {
    const c = calcDeProduct(
      product({
        amount: 0,
        variants: [
          { name: 'Listed', price: 20, weightG: 100, amount: 5, soldQty: 0, soldValue: 0 },
          { name: 'Hidden', price: 20, weightG: 100, amount: 5, soldQty: 0, soldValue: 0, unlisted: true },
        ],
      }),
    );
    expect(c.amount).toBe(5);
    expect(c.totalValue).toBe(100);
    expect(c.reimportQty).toBe(5);
  });

  it('sold quantity/weight/value are what was actually sold - the definitive-export figure', () => {
    const c = calcDeProduct(product({ amount: 10, soldQty: 4, price: 20, weightG: 100 }));
    expect(c.soldQty).toBe(4);
    expect(c.soldWeightKg).toBe(0.4);
    expect(c.soldValue).toBe(80);
  });

  it('sums sold quantity across variants, same as the re-import figure', () => {
    const c = calcDeProduct(
      product({
        amount: 0,
        variants: [
          { name: 'A', price: 20, weightG: 100, amount: 10, soldQty: 4, soldValue: 80 },
          { name: 'B', price: 20, weightG: 100, amount: 10, soldQty: 4, soldValue: 80, unlisted: true },
        ],
      }),
    );
    expect(c.soldQty).toBe(4);
    expect(c.soldValue).toBe(80);
  });
});
