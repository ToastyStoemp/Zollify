import { describe, expect, it } from 'vitest';
import { buildPackingListHtml } from '../packing-list';
import { defaultCustomsDeDeclarant, defaultCustomsDeMeta, type CustomsDeState } from '../model';

function state(): CustomsDeState {
  return {
    meta: { ...defaultCustomsDeMeta(), event: 'Zurich Pop Con', currency: 'EUR' },
    declarant: { ...defaultCustomsDeDeclarant(), companyName: 'Phuong Ninjin' },
    products: [
      {
        id: 'p1',
        title: 'Art Print',
        sku: 'AP-000',
        type: 'Print',
        forSale: true,
        tariffNo: '4911910000',
        originCountry: 'Germany',
        amount: 10,
        soldQty: 3,
        soldValue: 75,
        variants: [
          { name: 'A1', sku: 'AP-A1', price: 25, weightG: 100, amount: 6, soldQty: 2, soldValue: 50 },
          { name: 'A2', sku: 'AP-A2', price: 30, weightG: 120, amount: 4, soldQty: 1, soldValue: 30 },
        ],
      },
      {
        id: 'p2',
        title: 'Sticker',
        sku: 'ST-000',
        type: 'Sticker',
        forSale: false,
        tariffNo: '4911910000',
        originCountry: 'Germany',
        weightG: 10,
        price: 3,
        amount: 20,
        soldQty: 20,
        soldValue: 60,
      },
    ],
  };
}

describe('buildPackingListHtml', () => {
  it('detailed format gives each variant its own row', () => {
    const html = buildPackingListHtml(state(), 'export', 'detailed');
    expect(html).toContain('AP-A1');
    expect(html).toContain('AP-A2');
    expect(html).toContain('Art Print - A1');
    expect(html).toContain('Art Print - A2');
  });

  it('compressed format collapses variants into one row with a count', () => {
    const html = buildPackingListHtml(state(), 'export', 'compressed');
    expect(html).toContain('Art Print (2 variants)');
    expect(html).not.toContain('Art Print - A1');
  });

  it('by-type format groups products sharing a type and HS code into one row', () => {
    const html = buildPackingListHtml(state(), 'export', 'bytype');
    // Both products share tariffNo 4911910000 but differ in type, so they stay separate groups.
    expect(html).toContain('Print');
    expect(html).toContain('Sticker');
    expect(html).toContain('By type');
  });

  it('names a single-product group by the product, not the shared type - same as customs-ch', () => {
    const twoTypesState: CustomsDeState = {
      meta: { ...defaultCustomsDeMeta(), event: 'Zurich Pop Con', currency: 'EUR' },
      declarant: { ...defaultCustomsDeDeclarant(), companyName: 'Phuong Ninjin' },
      products: [
        { id: 't1', title: 'Cotton cap', type: 'Cap', tariffNo: '6505000000', originCountry: 'Germany', amount: 10, soldQty: 0, soldValue: 0 },
        { id: 't2', title: 'Wool cap', type: 'Cap', tariffNo: '6505000000', originCountry: 'Germany', amount: 5, soldQty: 0, soldValue: 0 },
      ],
    };
    const html = buildPackingListHtml(twoTypesState, 'export', 'bytype');
    // Same type and tariff code - one group, two products, falls back to the type name.
    expect(html).toContain('<strong>Cap</strong>');
    expect(html).not.toContain('Cotton cap');
    expect(html).not.toContain('Wool cap');
  });

  it('re-import list uses amount minus sold, not the brought amount', () => {
    const html = buildPackingListHtml(state(), 'reimport', 'compressed');
    // Sticker: 20 brought - 20 sold = 0, so it drops out entirely.
    expect(html).not.toContain('Sticker');
    // Art Print: (6-2)+(4-1) = 4+3 = 7 remaining.
    expect(html).toMatch(/Art Print[\s\S]*?<td class="r">7<\/td>/);
  });

  it('sold goods list uses what was actually sold, not brought or remaining', () => {
    const html = buildPackingListHtml(state(), 'sold', 'compressed');
    expect(html).toContain('Sold goods list');
    // Sticker: sold 20 of 20 brought - stays in, unlike the re-import list.
    expect(html).toMatch(/Sticker[\s\S]*?<td class="r">20<\/td>/);
    // Art Print: 2 + 1 = 3 sold across its variants.
    expect(html).toMatch(/Art Print[\s\S]*?<td class="r">3<\/td>/);
  });

  it("detailed format's per-variant sold row uses the variant's own soldValue, not price × qty", () => {
    // Real bug: the detailed format's per-variant loop computed value inline
    // as price * qty (undiscounted) instead of routing through
    // calcDeProduct/calcDeProductByMaterial like every other row - deliberately
    // different numbers here (25 * 2 = 50, but actually charged 44) so a
    // regression can't pass by the fixture's own coincidence.
    const discounted: CustomsDeState = {
      meta: { ...defaultCustomsDeMeta(), event: 'Con', currency: 'EUR' },
      declarant: { ...defaultCustomsDeDeclarant(), companyName: 'Studio' },
      products: [
        {
          id: 'p1', title: 'Art Print', type: 'Print', forSale: true, tariffNo: '4911910000', amount: 0, soldQty: 0, soldValue: 0,
          variants: [{ name: 'A1', sku: 'AP-A1', price: 25, weightG: 100, amount: 6, soldQty: 2, soldValue: 44 }],
        },
      ],
    };
    const html = buildPackingListHtml(discounted, 'sold', 'detailed');
    expect(html).toMatch(/Art Print - A1[\s\S]*?<td class="r">44\.00<\/td>/);
    expect(html).not.toContain('<td class="r">50.00</td>');
  });

  it('rounds a floating-point-noisy soldValue instead of leaking it raw, and the table total keeps 2 decimals too', () => {
    // A discount-adjusted soldValue can land on something like
    // 464.90999999999997 instead of 464.91 - that must never reach the
    // rendered document unrounded, in either the row or the table's own
    // TOTALS footer (which used to floor to a bare integer with no decimals
    // at all, e.g. showing 5146 instead of 5146.88 - the "couple cents off"
    // symptom).
    const noisy: CustomsDeState = {
      meta: { ...defaultCustomsDeMeta(), event: 'Con', currency: 'EUR' },
      declarant: { ...defaultCustomsDeDeclarant(), companyName: 'Studio' },
      products: [
        {
          id: 'p1', title: 'Sushi Bar', type: 'Print', forSale: true, tariffNo: '4911910000',
          weightG: 100, price: 40, amount: 12, soldQty: 12, soldValue: 464.90999999999997,
        },
      ],
    };
    const html = buildPackingListHtml(noisy, 'sold', 'compressed');
    expect(html).not.toContain('464.90999999999997');
    expect(html).toMatch(/Sushi Bar[\s\S]*?<td class="r">464\.91<\/td>/);
    expect(html).toMatch(/<tfoot>[\s\S]*?<td class="r">464\.91<\/td>/);
  });

  it('shows SKU and omits Swiss-only tariff/VAT rate columns', () => {
    const html = buildPackingListHtml(state(), 'export', 'compressed');
    expect(html).toContain('<th>SKU</th>');
    expect(html).not.toContain('Tariff Rate');
    expect(html).not.toContain('VAT Rate');
  });

  it('flags not-for-sale items', () => {
    const html = buildPackingListHtml(state(), 'export', 'compressed');
    expect(html).toContain('Not for sale');
  });

  it('identifies art prints by year and the declarant name - same rule as customs-ch', () => {
    const artState: CustomsDeState = {
      meta: { ...defaultCustomsDeMeta(), event: 'Zurich Pop Con', currency: 'EUR' },
      declarant: { ...defaultCustomsDeDeclarant(), fullName: 'Phuong Ninjin' },
      products: [{ id: 'p1', title: 'Sunset', type: 'Art Print', year: 2024, originCountry: 'Germany', price: 25, amount: 3, soldQty: 0, soldValue: 0 }],
    };
    const html = buildPackingListHtml(artState, 'export', 'compressed');
    expect(html).toContain('Sunset (2024) - Phuong Ninjin');
  });

  it('shows material as its own column - same as customs-ch', () => {
    const matState: CustomsDeState = {
      meta: { ...defaultCustomsDeMeta(), event: 'Zurich Pop Con', currency: 'EUR' },
      declarant: { ...defaultCustomsDeDeclarant(), fullName: 'Phuong Ninjin' },
      products: [{ id: 'p2', title: 'Tote', type: 'Purse', material: 'Genuine leather', originCountry: 'Germany', price: 40, amount: 2, soldQty: 0, soldValue: 0 }],
    };
    const html = buildPackingListHtml(matState, 'export', 'compressed');
    expect(html).toContain('<td>Tote</td>');
    expect(html).not.toContain('Tote - Genuine leather');
    expect(html).toContain('<td class="mat">Genuine leather</td>');
  });

  it('splits a by-type group when a product\'s own variants differ in material', () => {
    const varState: CustomsDeState = {
      meta: { ...defaultCustomsDeMeta(), event: 'Zurich Pop Con', currency: 'EUR' },
      declarant: { ...defaultCustomsDeDeclarant(), fullName: 'Phuong Ninjin' },
      products: [
        {
          id: 'p3', title: 'Enamel Pin', type: 'Pin', originCountry: 'Germany', amount: 0, soldQty: 0, soldValue: 0,
          variants: [
            { name: 'Dragon', amount: 30, soldQty: 0, soldValue: 0, material: 'Zinc alloy' },
            { name: 'Gold Edition', amount: 5, soldQty: 0, soldValue: 0, material: 'Gold plate' },
          ],
        },
      ],
    };
    const html = buildPackingListHtml(varState, 'export', 'bytype');
    const rows = html.split('<tr>');
    const zincRow = rows.find((r) => r.includes('Zinc alloy'));
    const goldRow = rows.find((r) => r.includes('Gold plate'));
    expect(zincRow).toContain('<td class="r">30</td>');
    expect(goldRow).toContain('<td class="r">5</td>');
  });
});
