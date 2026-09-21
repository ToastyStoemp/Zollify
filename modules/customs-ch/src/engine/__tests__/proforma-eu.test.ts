import { describe, expect, it } from 'vitest';
import { buildProformaEuHtml } from '../proforma-eu';
import { defaultCustomsArtist, defaultCustomsEdec, defaultCustomsForm1174, defaultCustomsMeta, type CustomsState } from '../model';

function state(overrides: Partial<CustomsState['meta']> = {}, artistOverrides: Partial<CustomsState['artist']> = {}): CustomsState {
  return {
    meta: { ...defaultCustomsMeta(), event: 'Fantasy Basel 2026', documentNumber: 7, venueName: 'Messe Basel', venueCountry: 'Switzerland', venueTIN: 'CHE222251936', incoterms: 'EXW Berlin', ...overrides },
    artist: { ...defaultCustomsArtist(), companyName: 'Phuong Ninjin', street: 'Buckower Damm 83', postCodeCity: '12349 Berlin', countryOfOrigin: 'Germany', vatId: 'DE123456789', ...artistOverrides },
    edec: defaultCustomsEdec(),
    form1174: defaultCustomsForm1174(),
    products: [
      { id: 'p1', title: 'Art Print', tariffNo: '4911.91.00', originCountry: 'DE', weightG: 100, price: 25, amount: 10, soldQty: 3, soldValue: 75, variants: [] },
    ],
  };
}

describe('buildProformaEuHtml', () => {
  it('includes the mandatory EN 16931-style identifiers: invoice number, seller VAT ID, ISO country codes', () => {
    const html = buildProformaEuHtml(state(), new Date('2026-09-21T10:00:00Z'));
    expect(html).toContain('PF-20260921');
    expect(html).toContain('VAT/Tax ID: DE123456789');
    expect(html).toContain('(DE)');
    expect(html).toContain('(CH)');
  });

  it('shows the agreed delivery term (Incoterms), the field the broker mail asks for on the invoice', () => {
    const html = buildProformaEuHtml(state());
    expect(html).toContain('EXW Berlin');
  });

  it('flags a missing Incoterms value instead of silently leaving the box blank', () => {
    const html = buildProformaEuHtml(state({ incoterms: '' }));
    expect(html).toContain('not set');
  });

  it('states VAT is not charged, since this is a temporary-export proforma not a real sale', () => {
    const html = buildProformaEuHtml(state());
    expect(html).toMatch(/VAT.*not applicable/);
  });

  it('still totals goods correctly', () => {
    const html = buildProformaEuHtml(state());
    expect(html).toContain('250'); // 10 * 25
  });
});
