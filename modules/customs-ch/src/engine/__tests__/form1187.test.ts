import { describe, expect, it } from 'vitest';
import type { CustomsProduct, CustomsState } from '../model';
import { defaultCustomsArtist, defaultCustomsEdec, defaultCustomsForm1174, defaultCustomsMeta } from '../model';
import { build1187Html } from '../form1187';
import { calcReturnStats, compute1174Groups, hasCustomsInfo } from '../calc';

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

describe('form 11.87 / 11.74 return totals match the return goods list', () => {
  /** What the return goods list totals: per product, per listed variant at its own price. */
  function returnListTotals(products: CustomsProduct[]) {
    let qty = 0, value = 0, weightKg = 0;
    for (const p of products) {
      if (!hasCustomsInfo(p)) continue;
      const r = calcReturnStats(p);
      if (r.retQty <= 0) continue;
      qty += r.retQty;
      weightKg += r.retWkg;
      value += r.retVal ?? 0;
    }
    return { qty, value, weightKg };
  }

  const mixedPrices = product({
    id: 'mix', title: 'Print', amount: 0, soldQty: 0, soldValue: 0,
    variants: [
      // Sells out at 10 each; the 20-each variant comes home untouched.
      { name: 'Small', price: 10, weightG: 50, amount: 5, soldQty: 5, soldValue: 50 },
      { name: 'Large', price: 20, weightG: 200, amount: 5, soldQty: 0, soldValue: 0 },
      // Unlisted: left off customs documents entirely.
      { name: 'Proof', price: 99, weightG: 500, amount: 3, soldQty: 0, soldValue: 0, unlisted: true },
    ],
  });
  const flat = product({ id: 'flat', title: 'Sticker', tariffNo: '3919.90.00', price: 3, amount: 20, soldQty: 15, soldValue: 45 });
  const hidden = product({ id: 'hid', title: 'Secret', unlisted: true, price: 50, amount: 4, soldQty: 0, soldValue: 0 });

  it('sums the same return quantity, value and weight', () => {
    const products = [mixedPrices, flat, hidden];
    const { g1, g2 } = compute1174Groups(state(products));
    const list = returnListTotals(products);
    expect(g1.retQty + g2.retQty).toBe(list.qty);
    expect(g1.retValue + g2.retValue).toBe(list.value);
    expect(Math.round((g1.retWeightKg + g2.retWeightKg) * 1000)).toBe(Math.round(list.weightKg * 1000));
  });

  it('leaves unlisted products and variants out', () => {
    const html = build1187Html(state([mixedPrices, flat, hidden]));
    expect(html).not.toContain('Secret');
    const { g1, g2 } = compute1174Groups(state([mixedPrices]));
    expect(g1.retQty + g2.retQty).toBe(5);
    expect(g1.retValue + g2.retValue).toBe(100);
  });
});

describe('form 11.87 purpose', () => {
  it('states the purpose in German and French', () => {
    const html = build1187Html(state([product({ id: 'a' })]));
    expect(html).toContain('<span class="fv">ungewisser Verkauf · vente incertaine</span>');
    expect(html).not.toContain('Verkauf an Ausstellungen');
  });
});
