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

describe('goods list - art-print artist attribution', () => {
  it('shows "Title (Year) - Artist" on the Import, Sold and Return lists', () => {
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

describe('import document - excludes zero-stock products', () => {
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

describe('goods list - by-type grouping', () => {
  it('never repeats the HS code in the name column - it already has its own column', () => {
    const html = buildGoodsListHtml(
      state([
        product({ id: 'c1', title: 'Cotton cap', type: 'Cap', tariffNo: '6505.00.30' }),
        product({ id: 'c2', title: 'Print cap', type: 'Cap', tariffNo: '4911.91.00' }),
      ]),
      1,
      'bytype',
    );
    expect(html).not.toContain('Cap (6505.00.30)');
    expect(html).not.toContain('Cap (4911.91.00)');
    expect(html).toContain('6505.00.30');
    expect(html).toContain('4911.91.00');
  });

  it('names a single-product group by the product, not the shared type', () => {
    const html = buildGoodsListHtml(
      state([
        product({ id: 'c1', title: 'Cotton cap', type: 'Cap', tariffNo: '6505.00.30' }),
        product({ id: 'c2', title: 'Print cap', type: 'Cap', tariffNo: '4911.91.00' }),
      ]),
      1,
      'bytype',
    );
    // Different tariff codes split them into two single-product groups -
    // each names itself after the product, not the type they both share.
    expect(html).toContain('Cotton cap');
    expect(html).toContain('Print cap');
    expect(html).not.toContain('<strong>Cap</strong>');
  });

  it('names a multi-product group by the shared type', () => {
    const html = buildGoodsListHtml(
      state([
        product({ id: 't1', title: 'Cotton cap', type: 'Cap', tariffNo: '6505.00.30' }),
        product({ id: 't2', title: 'Wool cap', type: 'Cap', tariffNo: '6505.00.30' }),
      ]),
      1,
      'bytype',
    );
    // Same type AND tariff code - one group, two products, so it falls back
    // to the type name since no single product name could speak for both.
    expect(html).toContain('<strong>Cap</strong>');
    expect(html).not.toContain('Cotton cap');
    expect(html).not.toContain('Wool cap');
  });

  it('shows material as its own column even when every product of a type shares the same one', () => {
    const html = buildGoodsListHtml(
      state([
        product({ id: 'r1', title: 'Rubber duck', type: 'Toy', material: 'Rubber' }),
        product({ id: 'r2', title: 'Rubber ball', type: 'Toy', material: 'Rubber' }),
      ]),
      1,
      'bytype',
    );
    // One group for the type (same material too) - still shows the material,
    // not just when there's a second group to disambiguate from.
    expect(html).toContain('<strong>Toy</strong>');
    expect(html).toContain('<td class="mat">Rubber</td>');
  });

  it('splits a type into separate rows when material differs across products', () => {
    const html = buildGoodsListHtml(
      state([
        product({ id: 'p1', title: 'Zinc pin', type: 'Pin', material: 'Zinc alloy' }),
        product({ id: 'p2', title: 'Silver pin', type: 'Pin', material: 'Sterling silver' }),
      ]),
      1,
      'bytype',
    );
    expect(html).toContain('<td class="mat">Zinc alloy</td>');
    expect(html).toContain('<td class="mat">Sterling silver</td>');
  });

  it('splits a type into separate rows when one product\'s own VARIANTS differ in material', () => {
    const html = buildGoodsListHtml(
      state([
        product({
          id: 'p3', title: 'Enamel Pin', type: 'Pin', material: undefined, sku: undefined,
          amount: 0, variants: [
            { name: 'Dragon', sku: 'PIN-DRG', amount: 30, soldQty: 0, soldValue: 0, material: 'Zinc alloy' },
            { name: 'Gold Edition', sku: 'PIN-GLD', amount: 5, soldQty: 0, soldValue: 0, material: 'Gold plate' },
          ],
        }),
      ]),
      1,
      'bytype',
    );
    // One product, two variant materials - the by-type table splits it into
    // two rows (one per material), each carrying only that variant's amount.
    const rows = html.split('<tr>');
    const zincRow = rows.find((r) => r.includes('Zinc alloy'));
    const goldRow = rows.find((r) => r.includes('Gold plate'));
    expect(zincRow).toContain('<td class="r">30</td>');
    expect(goldRow).toContain('<td class="r">5</td>');
  });
});
