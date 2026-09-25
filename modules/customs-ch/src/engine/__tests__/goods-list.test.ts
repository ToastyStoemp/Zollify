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
  it('shows "Title (Year) - Artist" on the Sold and Return lists', () => {
    for (const doc of [2, 3] as GoodsDocNum[]) {
      const html = buildGoodsListHtml(state([artPrint]), doc, 'detailed');
      expect(html, `doc ${doc}`).toContain('Sunset (2024) - Jane Doe');
    }
  });
});
