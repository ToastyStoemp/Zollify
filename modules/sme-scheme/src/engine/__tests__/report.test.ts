import { describe, expect, it } from 'vitest';
import type { SaleTax, Transaction } from '@zollify/shared';
import { buildSmeReport, previousQuarter, quarterOf, quarterRange, reportCsv, schemeApplies, type QuarterRef } from '../report';

const Q3: QuarterRef = { year: 2026, quarter: 3 };
const inQ3 = new Date(2026, 7, 15, 12).getTime();

let n = 0;
function sale(total: number, tax: SaleTax | undefined, extra: Partial<Transaction> = {}): Transaction {
  n++;
  return {
    id: `tx${n}`,
    eventId: 'ev',
    deviceId: 'd',
    timestamp: inQ3,
    method: 'card',
    payments: [],
    items: [{ pid: 'p', vid: null, title: 't', qty: 1, unitPrice: total, lineTotal: total }],
    discounts: [],
    total,
    currency: 'EUR',
    ...(tax ? { tax } : {}),
    ...extra,
  } as Transaction;
}
const charged = (country: string, rate: number): SaleTax => ({ country, exempt: false, rates: [rate] });
const exempt = (country: string): SaleTax => ({ country, exempt: true, rates: [null] });

const build = (transactions: Transaction[], profile = {}) =>
  buildSmeReport({ quarter: Q3, transactions, eventOf: () => ({ venue: { country: 'Germany' } }), profile });

describe('quarters', () => {
  it('finds the quarter of a date and its bounds', () => {
    expect(quarterOf(inQ3)).toEqual(Q3);
    const { from, to } = quarterRange(Q3);
    expect(new Date(from)).toEqual(new Date(2026, 6, 1));
    expect(new Date(to)).toEqual(new Date(2026, 9, 1));
    expect(previousQuarter({ year: 2026, quarter: 1 })).toEqual({ year: 2025, quarter: 4 });
  });
});

describe('buildSmeReport', () => {
  it('reports charged sales without VAT, worked out on the quarter total', () => {
    // 100 × €20 at 19%: per receipt that rounds to 16.81 each (1681.00); on the total it is 1680.67.
    const r = build(Array.from({ length: 100 }, () => sale(20, charged('DE', 19))));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ country: 'DE', status: 'charged', sales: 100, chargedGross: 2000, vat: 319.33, reported: 1680.67 });
  });

  it('reports exempt sales in full', () => {
    const r = build([sale(1200, exempt('NL')), sale(300, exempt('NL'))]);
    expect(r.rows[0]).toMatchObject({ country: 'NL', status: 'exempt', exemptGross: 1500, vat: 0, reported: 1500 });
  });

  it('splits a country that was exempt for part of the quarter', () => {
    const r = build([sale(500, exempt('AT')), sale(120, charged('AT', 20))]);
    expect(r.rows[0]).toMatchObject({ status: 'mixed', exemptGross: 500, chargedGross: 120, vat: 20, reported: 600 });
  });

  it('keeps each rate apart', () => {
    const tx = sale(0, { country: 'DE', exempt: false, rates: [19, 7] }, {
      items: [
        { pid: 'a', vid: null, title: 'print', qty: 1, unitPrice: 119, lineTotal: 119 },
        { pid: 'b', vid: null, title: 'book', qty: 1, unitPrice: 107, lineTotal: 107 },
      ],
      total: 226,
    });
    const row = build([tx]).rows[0]!;
    expect(row.rates).toEqual([
      { rate: 19, gross: 119, vat: 19, net: 100 },
      { rate: 7, gross: 107, vat: 7, net: 100 },
    ]);
    expect(row.reported).toBe(200);
  });

  it('counts lines with no known rate in full', () => {
    const row = build([sale(50, { country: 'DE', exempt: false, rates: [null] })]).rows[0]!;
    expect(row).toMatchObject({ unrated: 50, vat: 0, reported: 50 });
  });

  it('leaves out reverted sales and other quarters', () => {
    const r = build([
      sale(100, exempt('BE'), { revertedBy: 'op1' }),
      sale(100, exempt('BE'), { timestamp: new Date(2026, 9, 1).getTime() }),
      sale(100, exempt('BE'), { timestamp: new Date(2026, 5, 30, 23, 59).getTime() }),
      sale(40, exempt('BE')),
    ]);
    expect(r.reverted).toBe(1);
    expect(r.rows[0]).toMatchObject({ sales: 1, reported: 40 });
  });

  it('counts converted sales in the book currency', () => {
    const r = build([sale(96, charged('CH', 8.1), { currency: 'CHF', baseCurrency: 'EUR', baseTotal: 108.1 })]);
    expect(r.rows[0]).toMatchObject({ country: 'CH', currency: 'EUR', eu: false, chargedGross: 108.1, vat: 8.1, reported: 100 });
  });

  it('judges sales from before VAT was tracked by today’s settings, and says so', () => {
    const r = build([sale(119, undefined)], { vat: { exemptCountries: [] } });
    expect(r.estimated).toBe(1);
    expect(r.rows[0]).toMatchObject({ country: 'DE', status: 'charged', reported: 100 });
    const ex = build([sale(119, undefined)], { vat: { exemptCountries: ['DE'] } });
    expect(ex.rows[0]).toMatchObject({ status: 'exempt', reported: 119 });
  });

  it('puts the EU first and totals per currency', () => {
    const r = build([sale(500, charged('CH', 8.1)), sale(100, exempt('FR')), sale(238, charged('DE', 19))]);
    expect(r.rows.map((x) => x.country)).toEqual(['DE', 'FR', 'CH']);
    expect(r.totals).toEqual([{ currency: 'EUR', sales: 3, gross: 838, vat: 75.47, reported: 762.53, euReported: 300 }]);
  });
});

describe('countries with no sales', () => {
  it('lists every EU country the business is exempt in, at zero', () => {
    const r = build([sale(300, exempt('BE'))], { vat: { exemptCountries: ['BE', 'NL', 'CH'] } });
    expect(r.rows.map((x) => [x.country, x.reported, x.sales])).toEqual([['BE', 300, 1], ['NL', 0, 0]]);
    expect(r.rows[1]).toMatchObject({ status: 'exempt', eu: true, currency: 'EUR' });
  });
});

describe('reportCsv', () => {
  it('writes a header block, then one semicolon row per country', () => {
    const csv = reportCsv(build([sale(2000, charged('DE', 19))]), (c) => (c === 'DE' ? 'Germany' : c), { businessName: 'Ink; Paper', exNumber: 'DE123EX', generated: new Date(Date.UTC(2026, 9, 18)) });
    const lines = csv.split('\n');
    expect(lines.slice(0, 5)).toEqual(['Business;"Ink; Paper"', 'EX number;DE123EX', 'Quarter;Q3 2026', 'Generated;2026-10-18', '']);
    expect(lines[5]).toBe('Country;Code;EU;Status;Sales;Currency;Exempt gross;Charged gross;VAT;Reported');
    expect(lines[6]).toBe('Germany;DE;yes;charged;1;EUR;0.00;2000.00;319.33;1680.67');
    expect(reportCsv(build([]), (c) => c).split('\n').slice(0, 2)).toEqual(['Business;-', 'EX number;-']);
  });
});

describe('schemeApplies', () => {
  it('is due with an EX number or an exemption abroad, not for a Kleinunternehmer at home alone', () => {
    expect(schemeApplies({ vat: { exemptCountries: ['DE'] } }, 'DE')).toBe(false);
    expect(schemeApplies({ vat: { exemptCountries: ['DE', 'AT'] } }, 'DE')).toBe(true);
    expect(schemeApplies({ vat: { exemptCountries: ['DE'], exNumber: 'DE123EX' } }, 'DE')).toBe(true);
    expect(schemeApplies({ vat: { exemptCountries: ['DE', 'CH'] } }, 'DE')).toBe(false); // Switzerland is not in the scheme
    expect(schemeApplies(null, 'DE')).toBe(false);
  });
});
