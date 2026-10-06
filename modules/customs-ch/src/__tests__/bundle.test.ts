import { describe, expect, it } from 'vitest';
import type { CustomsProduct, CustomsState } from '../engine/model';
import { defaultCustomsArtist, defaultCustomsEdec, defaultCustomsForm1174, defaultCustomsMeta } from '../engine/model';
import { EDEC_WEB_URL, autoCompanyCode, swissDocuments } from '../bundle';

function state(soldQty: number): CustomsState {
  const product: CustomsProduct = {
    id: 'p', title: 'Pin', type: 'Other', forSale: true, unlisted: false,
    price: 10, weightG: 100, tariffNo: '7117.19.00', tariffRate: 8.1, vatRate: 8.1,
    amount: 10, soldQty, soldValue: soldQty * 10, variants: [],
  };
  return {
    meta: { ...defaultCustomsMeta(), event: 'Con', currency: 'CHF' },
    artist: { ...defaultCustomsArtist(), fullName: 'Jane Doe', countryOfOrigin: 'Switzerland' },
    edec: defaultCustomsEdec(),
    form1174: defaultCustomsForm1174(),
    products: [product],
  };
}

describe('swissDocuments', () => {
  it('before: import packing list, proforma and forms 11.74/11.87, in the event currency', () => {
    const b = swissDocuments(state(0), 'before', 'Con');
    expect(b.currency).toBe('CHF');
    expect(b.docs.map((d) => d.title)).toEqual(['Packing list (import)', 'Proforma invoice', 'Form 11.74', 'Form 11.87']);
    expect(b.files).toEqual([]);
    expect(b.links).toEqual([]);
  });

  it('after: return and sold goods lists, forms 11.74/11.87, the e-dec XML and the e-dec web link', () => {
    const b = swissDocuments(state(3), 'after', 'Con');
    expect(b.docs.map((d) => d.title)).toEqual(['Return goods list', 'Sold goods list', 'Form 11.74', 'Form 11.87']);
    expect(b.files).toHaveLength(1);
    expect(b.files[0]!.mimeType).toBe('application/xml');
    expect(b.files[0]!.content).toContain('<commodityCode>7117.1900</commodityCode>');
    expect(b.links).toEqual([{ label: 'Open e-dec web', url: EDEC_WEB_URL }]);
  });

  it('after, nothing sold: no XML, says why, still links the portal', () => {
    const b = swissDocuments(state(0), 'after', 'Con');
    expect(b.files).toEqual([]);
    expect(b.notes).toHaveLength(1);
    expect(b.links).toHaveLength(1);
  });
});

describe('autoCompanyCode', () => {
  it('takes initials, or the first letters of a single word', () => {
    expect(autoCompanyCode({ companyName: '', fullName: 'Phuong Ninjin' })).toBe('PN');
    expect(autoCompanyCode({ companyName: 'Studio', fullName: 'Jane Doe' })).toBe('STU');
    expect(autoCompanyCode({ companyName: '', fullName: '' })).toBe('');
  });
});
