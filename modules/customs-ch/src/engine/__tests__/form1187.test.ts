import { describe, expect, it } from 'vitest';
import type { CustomsProduct, CustomsState } from '../model';
import { defaultCustomsArtist, defaultCustomsEdec, defaultCustomsForm1174, defaultCustomsMeta } from '../model';
import { build1187Html } from '../form1187';

function product(over: Partial<CustomsProduct>): CustomsProduct {
  return {
    id: 'p', title: 'Item', type: 'Other', forSale: true, unlisted: false,
    price: 10, weightG: 100, tariffNo: '4911.91.00', tariffRate: 8.1, vatRate: 8.1,
    amount: 10, soldQty: 5, soldValue: 50, variants: [], ...over,
  };
}

function state(products: CustomsProduct[]): CustomsState {
  return {
    meta: { ...defaultCustomsMeta(), currency: 'CHF' },
    artist: { ...defaultCustomsArtist(), fullName: 'Jane Doe' },
    edec: defaultCustomsEdec(),
    form1174: { ...defaultCustomsForm1174(), groupMode: 'auto' },
    products,
  };
}

describe('form 11.87 field 14 - return goods description', () => {
  it('includes a variant product with real remaining stock, not just flat-amount products', () => {
    // Stock and sales live on the variant, not the parent - amount/soldQty are
    // both 0 at the product's own top level, same shape as a real Art Print
    // or T-Shirt with sizes.
    const flat = product({ id: 'flat', title: 'Sticker', tariffNo: '3919.90.00', amount: 20, soldQty: 15 });
    const variant = product({
      id: 'var', title: 'Art Print', tariffNo: '4911.91.00', amount: 0, soldQty: 0, soldValue: 0,
      variants: [{ name: 'A2', amount: 40, soldQty: 6, soldValue: 60 }],
    });
    const html = build1187Html(state([flat, variant]));
    expect(html).toContain('Sticker');
    expect(html).toContain('Art Print');
  });

  it('still omits a variant product that is genuinely fully sold out', () => {
    const soldOut = product({
      id: 'gone', title: 'Sold Out Print', amount: 0, soldQty: 0, soldValue: 0,
      variants: [{ name: 'A4', amount: 10, soldQty: 10, soldValue: 100 }],
    });
    const html = build1187Html(state([soldOut]));
    expect(html).not.toContain('Sold Out Print');
  });
});
