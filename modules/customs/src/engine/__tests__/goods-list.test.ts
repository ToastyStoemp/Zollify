import { describe, expect, it } from 'vitest';
import type { CustomsProduct, CustomsState } from '../model';
import { defaultCustomsArtist, defaultCustomsEdec, defaultCustomsForm1174, defaultCustomsMeta } from '../model';
import { buildGoodsListHtml, type GoodsDocNum } from '../goods-list';

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
    form1174: defaultCustomsForm1174(),
    products,
  };
}

const artPrint = product({ id: 'a', title: 'Sunset', type: 'Art Print', year: 2024 });

describe('goods list — art-print artist attribution', () => {
  it('shows "Title (Year) — Artist" on the Import, Sold and Return lists', () => {
    for (const doc of [1, 2, 3] as GoodsDocNum[]) {
      const html = buildGoodsListHtml(state([artPrint]), doc, 'detailed');
      expect(html, `doc ${doc}`).toContain('Sunset (2024) - Jane Doe');
    }
  });

  it('leaves non-art-print titles untouched', () => {
    const html = buildGoodsListHtml(state([product({ title: 'Enamel Pin', type: 'Pin' })]), 1, 'detailed');
    expect(html).toContain('Enamel Pin');
    expect(html).not.toContain('Enamel Pin -');
  });
});

describe('import document — excludes zero-stock products', () => {
  it('omits products with no brought stock, keeps stocked ones', () => {
    const html = buildGoodsListHtml(
      state([
        product({ id: 'real', title: 'Stocked Item', amount: 8 }),
        product({ id: 'ghost', title: 'Zero Stock Item', amount: 0, soldQty: 0, soldValue: 0 }),
      ]),
      1,
      'detailed',
    );
    expect(html).toContain('Stocked Item');
    expect(html).not.toContain('Zero Stock Item');
  });

  it('keeps a product whose stock lives only in its variants', () => {
    const p: CustomsProduct = product({
      id: 'v', title: 'Variant Product', amount: 0, soldQty: 0, soldValue: 0,
      variants: [{ name: 'Blue', amount: 3, soldQty: 0, soldValue: 0 }],
    });
    const html = buildGoodsListHtml(state([p]), 1, 'detailed');
    expect(html).toContain('Variant Product');
  });

  it('omits an individual zero-stock variant (detailed) while keeping stocked ones', () => {
    const p: CustomsProduct = product({
      id: 'v2', title: 'Pins', type: 'Pin', amount: 0, soldQty: 0, soldValue: 0,
      variants: [
        { name: 'Dragon', amount: 5, soldQty: 0, soldValue: 0 },
        { name: 'Wolf', amount: 0, soldQty: 0, soldValue: 0 },
      ],
    });
    const html = buildGoodsListHtml(state([p]), 1, 'detailed');
    expect(html).toContain('Dragon');
    expect(html).not.toContain('Wolf');
  });
});

describe('goods list — by-type HS disambiguation', () => {
  it('appends the HS code only when two groups share a type', () => {
    const html = buildGoodsListHtml(
      state([
        product({ id: 'c1', title: 'Cotton cap', type: 'Cap', tariffNo: '6505.00.30' }),
        product({ id: 'c2', title: 'Print cap', type: 'Cap', tariffNo: '4911.91.00' }),
        product({ id: 'b1', title: 'Artbook', type: 'Book', tariffNo: '4901.99.00', tariffRate: 2.6, vatRate: 2.6 }),
      ]),
      1,
      'bytype',
    );
    // Same type, different HS → each group name carries its code.
    expect(html).toContain('Cap (6505.00.30)');
    expect(html).toContain('Cap (4911.91.00)');
    // Unique type → shown plainly, no HS suffix in the name column.
    expect(html).toContain('<strong>Book</strong>');
    expect(html).not.toContain('Book (4901.99.00)');
  });
});
