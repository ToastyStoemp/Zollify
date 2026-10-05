import { describe, expect, it } from 'vitest';
import type { CustomsProduct, CustomsState } from '../model';
import { defaultCustomsArtist, defaultCustomsEdec, defaultCustomsForm1174, defaultCustomsMeta } from '../model';
import { buildEdecXml } from '../edec-xml';

function product(over: Partial<CustomsProduct>): CustomsProduct {
  return {
    id: 'p', title: 'Item', type: 'Other', forSale: true, unlisted: false,
    price: 10, weightG: 100, tariffNo: '7117.19.00', tariffRate: 8.1, vatRate: 8.1,
    amount: 10, soldQty: 5, soldValue: 50, variants: [], ...over,
  };
}

function state(products: CustomsProduct[]): CustomsState {
  return {
    meta: { ...defaultCustomsMeta(), event: 'Con', currency: 'CHF' },
    artist: { ...defaultCustomsArtist(), fullName: 'Jane Doe', countryOfOrigin: 'Switzerland' },
    edec: defaultCustomsEdec(),
    form1174: defaultCustomsForm1174(),
    products,
  };
}

/** Pulls out how many <GoodsItemType> positions the XML declares. */
function positionCount(xml: string): number {
  return (xml.match(/<GoodsItemType>/g) ?? []).length;
}

describe('buildEdecXml - Positionsdaten merged by HS code + material', () => {
  it('merges two different products sharing the same HS code and material into one position', () => {
    const xml = buildEdecXml(
      state([
        product({ id: 'a', title: 'Dragon Pin', tariffNo: '7117.19.00', material: 'Zinc alloy', soldQty: 10, soldValue: 100 }),
        product({ id: 'b', title: 'Wolf Pin', tariffNo: '7117.19.00', material: 'Zinc alloy', soldQty: 4, soldValue: 40 }),
      ]),
    )!.xml;
    expect(positionCount(xml)).toBe(1);
    expect(xml).toContain('<description>14 Dragon Pin, Wolf Pin (Zinc alloy)</description>');
    // Value and quantity both add up across the merged products.
    expect(xml).toContain('<statisticalValue>140</statisticalValue>');
  });

  it('keeps products with the same HS code but different materials apart', () => {
    const xml = buildEdecXml(
      state([
        product({ id: 'a', title: 'Zinc Pin', tariffNo: '7117.19.00', material: 'Zinc alloy', soldQty: 10, soldValue: 100 }),
        product({ id: 'b', title: 'Gold Pin', tariffNo: '7117.19.00', material: 'Gold plate', soldQty: 2, soldValue: 40 }),
      ]),
    )!.xml;
    expect(positionCount(xml)).toBe(2);
  });

  it('keeps the same material apart when the HS code differs', () => {
    const xml = buildEdecXml(
      state([
        product({ id: 'a', title: 'Print', tariffNo: '4911.91.00', material: '', soldQty: 5, soldValue: 100 }),
        product({ id: 'b', title: 'Sticker', tariffNo: '3919.90.00', material: '', soldQty: 20, soldValue: 60 }),
      ]),
    )!.xml;
    expect(positionCount(xml)).toBe(2);
  });

  it('still splits one product\'s own variants across materials, even while merging with other products', () => {
    const mixed = product({
      id: 'a', title: 'Enamel Pin', tariffNo: '7117.19.00', amount: 0, soldQty: 0, soldValue: 0,
      variants: [
        { name: 'Dragon', material: 'Zinc alloy', amount: 10, soldQty: 6, soldValue: 60 },
        { name: 'Gold Edition', material: 'Gold plate', amount: 5, soldQty: 2, soldValue: 40 },
      ],
    });
    const other = product({ id: 'b', title: 'Wolf Pin', tariffNo: '7117.19.00', material: 'Zinc alloy', soldQty: 4, soldValue: 40 });
    const xml = buildEdecXml(state([mixed, other]))!.xml;
    // Zinc: Enamel Pin's Dragon variant (6) + Wolf Pin (4) merge -> one position.
    // Gold: Enamel Pin's Gold Edition variant stays its own position.
    expect(positionCount(xml)).toBe(2);
    expect(xml).toContain('<description>10 Enamel Pin, Wolf Pin (Zinc alloy)</description>');
    expect(xml).toContain('<description>2 Enamel Pin (Gold plate)</description>');
  });
});

describe('buildEdecXml - commodity code detail', () => {
  it('cuts the tariff number to the 6-digit HS subheading', () => {
    const xml = buildEdecXml(state([product({ id: 'a', title: 'Bag', tariffNo: '4202.22.10', material: 'Canvas' })]))!.xml;
    expect(xml).toContain('<commodityCode>4202.2200</commodityCode>');
    expect(xml).not.toContain('4202.2210');
  });

  it('merges products that only differ past the subheading', () => {
    const xml = buildEdecXml(
      state([
        product({ id: 'a', title: 'Tote', tariffNo: '4202.22.10', material: 'Canvas', soldQty: 3, soldValue: 60 }),
        product({ id: 'b', title: 'Pouch', tariffNo: '4202.22.90', material: 'Canvas', soldQty: 2, soldValue: 20 }),
      ]),
    )!.xml;
    expect(positionCount(xml)).toBe(1);
    expect(xml).toContain('<statisticalValue>80</statisticalValue>');
  });

  it('keeps a permit obligation when merging with a product that has none', () => {
    const xml = buildEdecXml(
      state([
        product({ id: 'a', title: 'Tote', tariffNo: '4202.22.10', material: 'Canvas', permitOverride: 0 }),
        product({ id: 'b', title: 'Pouch', tariffNo: '4202.22.90', material: 'Canvas', permitOverride: 2 }),
      ]),
    )!.xml;
    expect(xml).toContain('<permitObligation>2</permitObligation>');
  });
});

describe('buildEdecXml - description', () => {
  it('names the material of each position', () => {
    const xml = buildEdecXml(
      state([
        product({ id: 'a', title: 'Zinc Pin', material: 'Zinc alloy', soldQty: 10, soldValue: 100 }),
        product({ id: 'b', title: 'Gold Pin', material: 'Gold plate', soldQty: 2, soldValue: 40 }),
      ]),
    )!.xml;
    expect(xml).toContain('<description>10 Zinc Pin (Zinc alloy)</description>');
    expect(xml).toContain('<description>2 Gold Pin (Gold plate)</description>');
  });

  it('leaves the description alone when there is no material', () => {
    const xml = buildEdecXml(state([product({ id: 'a', title: 'Print', tariffNo: '4911.91.00', material: '', soldQty: 5 })]))!.xml;
    expect(xml).toContain('<description>5 Print</description>');
  });
});

describe('buildEdecXml - permit and non-customs-law obligations', () => {
  // As e-dec accepted them on a real declaration.
  it('keychains (3926.90): permit 2, non-customs law 0', () => {
    const xml = buildEdecXml(state([product({ id: 'k', title: 'Keychain', tariffNo: '3926.90.00', material: 'Acrylic' })]))!.xml;
    expect(xml).toContain('<permitObligation>2</permitObligation>');
    expect(xml).toContain('<nonCustomsLawObligation>0</nonCustomsLawObligation>');
  });

  it('enamel pins (7117.19): 2 for both', () => {
    const xml = buildEdecXml(state([product({ id: 'p', title: 'Pin', tariffNo: '7117.19.00', material: 'Zinc alloy' })]))!.xml;
    expect(xml).toContain('<permitObligation>2</permitObligation>');
    expect(xml).toContain('<nonCustomsLawObligation>2</nonCustomsLawObligation>');
  });

  it('art prints (4911.91): 0 for both', () => {
    const xml = buildEdecXml(state([product({ id: 'a', title: 'Print', tariffNo: '4911.91.00', material: 'Paper' })]))!.xml;
    expect(xml).toContain('<permitObligation>0</permitObligation>');
    expect(xml).toContain('<nonCustomsLawObligation>0</nonCustomsLawObligation>');
  });

  it('a product\'s own override still sets both', () => {
    const xml = buildEdecXml(state([product({ id: 'k', title: 'Keychain', tariffNo: '3926.90.00', material: 'Acrylic', permitOverride: 0 })]))!.xml;
    expect(xml).toContain('<permitObligation>0</permitObligation>');
    expect(xml).toContain('<nonCustomsLawObligation>0</nonCustomsLawObligation>');
  });
});
