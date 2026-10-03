import { describe, expect, it } from 'vitest';
import type { TxItem } from '../types';
import { countryCodeOf, resolveEventVat, saleTaxFor, vatBreakdown, type EventVat } from '../vat';

const ev = (country: string, vat?: EventVat) => ({ venue: { country }, vat });
const profile = (exemptCountries: string[] = [], extra: Record<string, string> = {}) => ({
  artist: { countryOfOrigin: 'Germany' },
  vat: { exemptCountries, exNumber: '', homeNote: '', crossBorderNote: '', ...extra },
});
const item = (lineTotal: number, qty = 1): TxItem => ({ pid: 'p', vid: null, title: 't', qty, unitPrice: lineTotal / qty, lineTotal });

describe('countryCodeOf', () => {
  it('takes names and codes alike', () => {
    expect(countryCodeOf('Germany')).toBe('DE');
    expect(countryCodeOf(' de ')).toBe('DE');
    expect(countryCodeOf('Atlantis')).toBe('');
  });
});

describe('resolveEventVat', () => {
  it('charges the country’s rates by default', () => {
    expect(resolveEventVat(ev('France'), profile())).toMatchObject({ country: 'FR', exempt: false, standard: 20, reduced: 5.5 });
    expect(resolveEventVat(ev('Switzerland'), profile())).toMatchObject({ standard: 8.1, reduced: 2.6 });
  });

  it('takes an event’s own rates over the table', () => {
    expect(resolveEventVat(ev('Italy', { reduced: 10 }), profile())).toMatchObject({ standard: 22, reduced: 10 });
  });

  it('is exempt at home with the national wording', () => {
    const r = resolveEventVat(ev('Germany'), profile(['DE']));
    expect(r).toMatchObject({ exempt: true, note: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.' });
    expect(r.exNumber).toBeUndefined();
  });

  it('is exempt abroad under the EU SME scheme, with the EX number', () => {
    const r = resolveEventVat(ev('Netherlands'), profile(['DE', 'NL'], { exNumber: 'DE123456789EX' }));
    expect(r).toMatchObject({ exempt: true, note: 'VAT exempt under the EU SME scheme', exNumber: 'DE123456789EX' });
  });

  it('charges VAT in a country not ticked, even with exemptions elsewhere', () => {
    expect(resolveEventVat(ev('Austria'), profile(['DE', 'NL'])).exempt).toBe(false);
  });

  it('lets an event force either way', () => {
    expect(resolveEventVat(ev('Germany', { mode: 'charge' }), profile(['DE'])).exempt).toBe(false);
    expect(resolveEventVat(ev('Belgium', { mode: 'exempt' }), profile()).exempt).toBe(true);
  });

  it('uses the profile’s own wording when set', () => {
    expect(resolveEventVat(ev('Germany'), profile(['DE'], { homeNote: 'Kleinunternehmer' })).note).toBe('Kleinunternehmer');
  });

  it('knows no rates for a country missing from the table', () => {
    expect(resolveEventVat(ev('Japan'), profile())).toMatchObject({ exempt: false, standard: null });
  });
});

describe('saleTaxFor and vatBreakdown', () => {
  it('applies standard and reduced by product class, and splits the VAT out of gross prices', () => {
    const tax = saleTaxFor(resolveEventVat(ev('Germany'), profile()), ['standard', 'reduced', undefined]);
    expect(tax.rates).toEqual([19, 7, 19]);
    const rows = vatBreakdown({ items: [item(40, 2), item(10.7), item(19)], total: 69.7, currency: 'EUR', discounts: [], tax });
    expect(rows).toEqual([
      { rate: 19, letter: 'A', gross: 59, net: 49.58, vat: 9.42 },
      { rate: 7, letter: 'B', gross: 10.7, net: 10, vat: 0.7 },
    ]);
  });

  it('taxes what was actually paid, after discounts and in the charged currency', () => {
    const tax = saleTaxFor(resolveEventVat(ev('Germany'), profile()), ['standard']);
    // CHF 36 of goods (after a spread discount), charged as EUR 38.
    const rows = vatBreakdown({ items: [{ ...item(36, 2), unitPrice: 20 }], total: 38, currency: 'EUR', baseCurrency: 'CHF', baseTotal: 36, discounts: [], tax });
    expect(rows).toEqual([{ rate: 19, letter: 'A', gross: 38, net: 31.93, vat: 6.07 }]);
  });

  it('taxes the local prices the till showed, so the VAT matches the printed lines', () => {
    // CHF 20 + 25 of goods, charged at hand-set EUR 21 + 26 = EUR 47.
    const tax = { country: 'IT', exempt: false, rates: [22, 10] };
    const rows = vatBreakdown({
      items: [item(20), item(25)],
      total: 47,
      currency: 'EUR',
      baseCurrency: 'CHF',
      baseTotal: 45,
      discounts: [],
      asCharged: { listTotals: [21, 26], discounts: [] },
      tax,
    });
    expect(rows).toEqual([
      { rate: 22, letter: 'A', gross: 21, net: 17.21, vat: 3.79 },
      { rate: 10, letter: 'B', gross: 26, net: 23.64, vat: 2.36 },
    ]);
  });

  it('spreads a discount over the till prices before taking the VAT out', () => {
    const rows = vatBreakdown({
      items: [item(18), item(18)],
      total: 36,
      currency: 'EUR',
      discounts: [],
      asCharged: { listTotals: [20, 20], discounts: [{ name: 'Bundle', amount: 4 }] },
      tax: { country: 'DE', exempt: false, rates: [19, 7] },
    });
    expect(rows.map((r) => r.gross)).toEqual([18, 18]);
  });

  it('has no VAT rows for an exempt sale, and keeps the note', () => {
    const tax = saleTaxFor(resolveEventVat(ev('Germany'), profile(['DE'])), ['standard']);
    expect(tax).toMatchObject({ exempt: true, rates: [null], note: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.' });
    expect(vatBreakdown({ items: [item(20)], total: 20, currency: 'EUR', discounts: [], tax })).toEqual([]);
  });
});
