import { describe, expect, it } from 'vitest';
import type { Product, SalesEvent } from '@boothly/shared';
import { buildCustomsState } from '../adapter';

const event: SalesEvent = {
  id: 'ev1', name: 'Con', venue: {}, currency: 'CHF', status: 'active', updatedAt: 1,
};

function product(over: Partial<Product>): Product {
  return {
    id: 'p1', title: 'Thing', forSale: true, unlisted: false, price: 10,
    variants: [], sortOrder: 0, updatedAt: 1, ...over,
  };
}

const rateOf = (p: Product) => {
  const cp = buildCustomsState(event, [p], [], []).products[0]!;
  return { vatRate: cp.vatRate, tariffRate: cp.tariffRate };
};

describe('buildCustomsState — HS-code-derived rates', () => {
  it('fills VAT + duty rate from the HS code when the product has no override', () => {
    // 4901.99.00 (books) is the reduced-rate line: 2.6%.
    expect(rateOf(product({ tariffNo: '4901.99.00' }))).toEqual({ vatRate: 2.6, tariffRate: 2.6 });
    // 4911.91.00 (art prints) is the standard line: 8.1%.
    expect(rateOf(product({ tariffNo: '4911.91.00' }))).toEqual({ vatRate: 8.1, tariffRate: 8.1 });
  });

  it('keeps an explicit override instead of the HS-code value', () => {
    expect(rateOf(product({ tariffNo: '4911.91.00', vatRate: 3.7, tariffRate: 0 }))).toEqual({
      vatRate: 3.7,
      tariffRate: 0,
    });
  });

  it('leaves rates unset when there is no (or an unknown) HS code', () => {
    expect(rateOf(product({}))).toEqual({ vatRate: undefined, tariffRate: undefined });
    expect(rateOf(product({ tariffNo: '9999.99.99' }))).toEqual({ vatRate: undefined, tariffRate: undefined });
  });
});
