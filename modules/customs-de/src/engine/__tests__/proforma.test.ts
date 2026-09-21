import { describe, expect, it } from 'vitest';
import { buildProformaHtml } from '../proforma';
import { defaultCustomsDeDeclarant, defaultCustomsDeMeta, type CustomsDeState } from '../model';

function state(overrides: Partial<CustomsDeState['meta']> = {}): CustomsDeState {
  return {
    meta: {
      ...defaultCustomsDeMeta(),
      event: 'Zurich Pop Con',
      currency: 'EUR',
      incoterms: 'EXW Berlin',
      eori: 'DE607109170504586',
      consigneeName: 'Phuong Ninjin',
      consigneeStreet: 'Wallisellenstrasse 49',
      consigneePostcode: '8050',
      consigneeCity: 'Zürich',
      consigneeCountry: 'Switzerland',
      destinationCountry: 'Switzerland',
      ...overrides,
    },
    declarant: {
      ...defaultCustomsDeDeclarant(),
      companyName: 'Phuong Ninjin',
      street: 'Buckower Damm 83',
      postCodeCity: '12349 Berlin',
      countryOfOrigin: 'Germany',
      vatId: 'DE123456789',
    },
    products: [{ title: 'Art Print', tariffNo: '4911910000', originCountry: 'Germany', weightG: 100, price: 25, amount: 10, soldQty: 3, soldValue: 75 }],
  };
}

describe('buildProformaHtml (customs-de)', () => {
  it('includes a date-based invoice number, seller VAT ID, and ISO country codes', () => {
    const html = buildProformaHtml(state(), new Date('2026-09-21T10:00:00Z'));
    expect(html).toContain('PF-20260921');
    expect(html).toContain('VAT/Tax ID: DE123456789');
    expect(html).toContain('(DE)');
    expect(html).toContain('(CH)');
  });

  it('shows the agreed delivery term (Incoterms)', () => {
    const html = buildProformaHtml(state());
    expect(html).toContain('EXW Berlin');
  });

  it('flags a missing Incoterms value instead of leaving it blank', () => {
    const html = buildProformaHtml(state({ incoterms: '' }));
    expect(html).toContain('not set');
  });

  it('falls back to "c/o event name" for the buyer box when no consignee is set', () => {
    const html = buildProformaHtml(state({ consigneeName: '', consigneeStreet: '', consigneePostcode: '', consigneeCity: '', consigneeCountry: '', destinationCountry: '' }));
    expect(html).toContain('c/o Zurich Pop Con');
  });

  it('flags a genuinely missing buyer box when there is no consignee and no event name either', () => {
    const html = buildProformaHtml(state({ event: '', consigneeName: '', consigneeStreet: '', consigneePostcode: '', consigneeCity: '', consigneeCountry: '', destinationCountry: '' }));
    expect(html).toContain('missing');
  });

  it('states VAT is not charged - this is a temporary-export proforma, not a real sale', () => {
    const html = buildProformaHtml(state());
    expect(html).toMatch(/VAT.*not applicable/);
  });

  it('totals goods correctly', () => {
    const html = buildProformaHtml(state());
    expect(html).toContain('250'); // 10 * 25
  });
});
