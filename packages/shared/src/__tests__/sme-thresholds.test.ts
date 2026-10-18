import { describe, expect, it } from 'vitest';
import type { Transaction } from '../types';
import { buildSmeYear } from '../sme-report';
import { thresholdDismissKey, thresholdFor, thresholdRatePairs, thresholdWarnings, SME_THRESHOLDS } from '../sme-thresholds';

let n = 0;
/** One exempt sale of `total` in `country`, in `year`. */
function sale(country: string, total: number, year = 2026, currency = 'EUR'): Transaction {
  n++;
  return {
    id: `t${n}`, eventId: 'ev', deviceId: 'd', timestamp: new Date(year, 5, 15).getTime(), method: 'cash', payments: [],
    items: [{ pid: 'p', vid: null, title: 'print', qty: 1, unitPrice: total, lineTotal: total }],
    discounts: [], total, currency, tax: { country, exempt: true, rates: [null] },
  } as Transaction;
}

function warn(sales: Transaction[], vat: Record<string, unknown>, home = 'BE', rate = (_f: string, _t: string): number | null => null) {
  const input = { transactions: sales, eventOf: () => undefined, profile: { vat } };
  return thresholdWarnings({ thisYear: buildSmeYear(2026, input), lastYear: buildSmeYear(2025, input), profile: { vat }, home, rate });
}

describe('national thresholds', () => {
  it('says nothing well under the threshold', () => {
    expect(warn([sale('BE', 10_000)], { exemptCountries: ['BE'] })).toEqual([]);
  });

  it('warns from 80% of the threshold, with what is left', () => {
    const [w] = warn([sale('BE', 21_000)], { exemptCountries: ['BE'] });
    expect(w).toMatchObject({ country: 'BE', level: 'near', used: 21_000, limit: 25_000 });
    expect(w!.title).toBe('Belgium: 84% of the threshold');
    expect(w!.text).toContain('EUR 4,000 to go');
  });

  it('is over at once where the country allows no margin', () => {
    const [w] = warn([sale('BE', 26_000)], { exemptCountries: ['BE'] });
    expect(w).toMatchObject({ level: 'over' });
    expect(w!.text).toContain("charge Belgium's VAT from now on");
  });

  it('lets Germany run to the end of the year up to EUR 100,000, then stops at once', () => {
    expect(warn([sale('DE', 40_000)], { exemptCountries: ['DE'] }, 'DE')[0]).toMatchObject({ level: 'over-year-end' });
    expect(warn([sale('DE', 101_000)], { exemptCountries: ['DE'] }, 'DE')[0]).toMatchObject({ level: 'over', limit: 25_000 });
  });

  it("keeps Austria's 10% margin and counts only this year there", () => {
    expect(warn([sale('AT', 58_000)], { exemptCountries: ['AT'] }, 'AT')[0]).toMatchObject({ level: 'over-year-end' });
    expect(warn([sale('AT', 61_000)], { exemptCountries: ['AT'] }, 'AT')[0]).toMatchObject({ level: 'over' });
    expect(warn([sale('AT', 70_000, 2025)], { exemptCountries: ['AT'] }, 'AT')).toEqual([]);
  });

  it('flags last year over the threshold where both years count', () => {
    const [w] = warn([sale('NL', 22_000, 2025), sale('NL', 1_000)], { exemptCountries: ['NL'] }, 'NL');
    expect(w).toMatchObject({ level: 'last-year', used: 22_000 });
  });

  it('flags an exemption in a country that has none', () => {
    expect(warn([], { exemptCountries: ['ES'] }, 'ES')[0]).toMatchObject({ level: 'no-scheme', country: 'ES' });
  });

  it('converts to the threshold currency, and leaves the country out without a rate', () => {
    const vat = { exemptCountries: ['DK'] };
    expect(warn([sale('DK', 6_000)], vat, 'DK')).toEqual([]);
    const [w] = warn([sale('DK', 6_000)], vat, 'DK', (f, t) => (f === 'EUR' && t === 'DKK' ? 7.46 : null));
    expect(w).toMatchObject({ level: 'near', currency: 'DKK', used: 44_760 });
  });

  it("uses the business's own figure over the default", () => {
    expect(thresholdFor('BE', { BE: 30_000 })).toMatchObject({ amount: 30_000, checked: false });
    expect(warn([sale('BE', 26_000)], { exemptCountries: ['BE'], thresholds: { BE: 40_000 } })).toEqual([]);
    // An in-year cap scales with an own figure.
    expect(thresholdFor('DE', { DE: 22_000 })!.inYearCap).toBe(88_000);
  });
});

describe('EU-wide threshold', () => {
  it('only applies to a business using the exemption abroad', () => {
    expect(warn([sale('BE', 24_000)], { exemptCountries: ['BE'] })).toEqual(expect.not.arrayContaining([expect.objectContaining({ country: 'EU' })]));
  });

  it('warns near EUR 100,000 across the EU and when over it', () => {
    const vat = { exemptCountries: ['BE', 'NL', 'DE', 'FR'] };
    const near = warn([sale('FR', 60_000), sale('DE', 22_000)], vat).find((w) => w.country === 'EU');
    expect(near).toMatchObject({ level: 'near', used: 82_000 });
    const over = warn([sale('FR', 80_000), sale('DE', 21_000)], vat).find((w) => w.country === 'EU');
    expect(over).toMatchObject({ level: 'over' });
  });

  it('lists the most serious first', () => {
    const ws = warn([sale('BE', 26_000), sale('NL', 17_000)], { exemptCountries: ['BE', 'NL'] });
    expect(ws.map((w) => [w.country, w.level])).toEqual([['BE', 'over'], ['NL', 'near']]);
  });
});

describe('rate pairs', () => {
  it('asks for each book currency to each threshold currency', () => {
    const r = buildSmeYear(2026, { transactions: [sale('DK', 100)], eventOf: () => undefined, profile: { vat: { exemptCountries: ['DK'] } } });
    expect(thresholdRatePairs([r], { vat: { exemptCountries: ['DK', 'SE'] } })).toEqual([['EUR', 'DKK'], ['EUR', 'SEK']]);
  });
});

describe('the table', () => {
  it('covers every EU country with an exemption, in a three-letter currency', () => {
    for (const [code, t] of Object.entries(SME_THRESHOLDS)) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(t.currency).toMatch(/^[A-Z]{3}$/);
      expect(t.amount).toBeGreaterThan(0);
    }
    expect(Object.keys(SME_THRESHOLDS)).toHaveLength(26);
  });
});

describe('dismissing', () => {
  const key = (level: 'near' | 'over' | 'over-year-end', share: number, year = 2026) => thresholdDismissKey({ country: 'BE', level, share }, year);
  it('keeps a dismissal while the warning stays the same', () => {
    expect(key('near', 0.81)).toBe(key('near', 0.88));
  });
  it('brings it back at the next 10%, when it gets worse, and in a new year', () => {
    expect(key('near', 0.91)).not.toBe(key('near', 0.88));
    expect(key('over', 1.02)).not.toBe(key('near', 0.98));
    expect(key('over-year-end', 1.1)).not.toBe(key('over', 1.1));
    expect(key('near', 0.85, 2027)).not.toBe(key('near', 0.85, 2026));
  });
  it('does not nag again past the threshold', () => {
    expect(key('over', 1.05)).toBe(key('over', 1.4));
  });
});
