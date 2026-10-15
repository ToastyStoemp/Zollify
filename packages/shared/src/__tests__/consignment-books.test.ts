import { describe, expect, it } from 'vitest';
import {
  BooksSettingsSchema,
  cardFeeOf,
  consignmentLines,
  consignmentStatements,
  feesDue,
  localDay,
  recentPeriods,
  reportCsv,
  reportPeriod,
  storeReport,
  type ConsignmentRental,
  type Transaction,
} from '../index';

const ana = { id: 'ana', name: 'Ana', commissionPct: 40, storeCommission: {} };
const at = (iso: string): number => Date.parse(iso);
function tx(id: string, when: string, items: Partial<Transaction['items'][number]>[], extra: Partial<Transaction> = {}): Transaction {
  const full = items.map((i, n) => ({ pid: `p${n}`, vid: null, title: 'Item', qty: 1, unitPrice: i.lineTotal ?? 0, lineTotal: 0, ...i }));
  const total = full.reduce((s, i) => s + i.lineTotal, 0);
  return { id, eventId: 'zh', deviceId: 'd', timestamp: at(when), method: 'cash', payments: [], items: full, discounts: [], total, currency: 'CHF', ...extra };
}

describe('report periods', () => {
  it('runs monthly by calendar month', () => {
    expect(reportPeriod({ reportPeriod: 'monthly', biweeklyAnchor: '2024-01-01' }, '2026-02-17')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('runs two-weekly from the anchor, before and after it', () => {
    const s = { reportPeriod: 'biweekly', biweeklyAnchor: '2026-01-05' } as const;
    expect(reportPeriod(s, '2026-01-18')).toEqual({ from: '2026-01-05', to: '2026-01-18' });
    expect(reportPeriod(s, '2026-01-19')).toEqual({ from: '2026-01-19', to: '2026-02-01' });
    expect(reportPeriod(s, '2026-01-04')).toEqual({ from: '2025-12-22', to: '2026-01-04' });
    expect(recentPeriods(s, '2026-01-19', 3).map((p) => p.from)).toEqual(['2026-01-19', '2026-01-05', '2025-12-22']);
  });

  it('puts a late sale on the store’s own day', () => {
    expect(localDay(at('2026-03-31T22:30:00Z'), 'Europe/Zurich')).toBe('2026-04-01');
    expect(localDay(at('2026-03-31T22:30:00Z'), 'Not/AZone')).toBe('2026-03-31');
  });
});

describe('card costs and fees', () => {
  it('costs a percentage plus a fixed amount per card payment', () => {
    const t = tx('t', '2026-03-02T10:00:00Z', [{ lineTotal: 100 }], { method: 'split', payments: [{ kind: 'card', amount: 60 }, { kind: 'cash', amount: 40 }] });
    expect(cardFeeOf(t, { pct: 2, fixed: 0.3 })).toBe(1.5);
  });

  it('passes the artist their part of the card cost, and fees come off the balance', () => {
    const t = tx('t', '2026-03-02T10:00:00Z', [{ lineTotal: 100, consignorId: 'ana' }], { method: 'card' });
    const lines = consignmentLines([t], [ana], { pct: 2, fixed: 0.3 });
    expect(lines[0]!.cardFees).toBe(1.38); // 2.30 × the artist's 60%
    const [st] = consignmentStatements(lines, [], ['ana'], [], feesDue([{ consignorId: 'ana', amount: 20, currency: 'CHF', status: 'charged' }, { consignorId: 'ana', amount: 99, currency: 'CHF', status: 'waived' }]));
    expect(st!.totals[0]).toMatchObject({ artistShare: 60, cardFees: 1.38, fees: 20, balance: 38.62 });
  });
});

describe('the store report', () => {
  const settings = { ...BooksSettingsSchema.parse({ timeZone: 'Europe/Zurich', cardFeePct: 2, cardFeeFixed: 0 }) };
  const rental: ConsignmentRental = {
    id: 'r', consignorId: 'ana', storeId: 'zh', spaceId: 's', startDate: '2026-02-10', months: 3, monthlyFee: 50, currency: 'CHF', deductFromSales: true, note: '', endedOn: null, upgradedFromId: null, createdAt: 0, updatedAt: 0,
  };
  const txs = [
    // February: before the period - only counts towards the opening balance.
    tx('feb', '2026-02-20T10:00:00Z', [{ lineTotal: 50, consignorId: 'ana' }]),
    // March: an artist's print with 10% off, by card, at 8.1% VAT; and the store's own mug in cash.
    tx('m1', '2026-03-05T10:00:00Z', [{ lineTotal: 90, unitPrice: 100, consignorId: 'ana' }, { lineTotal: 20 }], {
      method: 'split',
      payments: [{ kind: 'card', amount: 90 }, { kind: 'cash', amount: 20 }],
      discounts: [{ name: 'Artist of the month', amount: 10 }],
      tax: { country: 'CH', exempt: false, rates: [8.1, 8.1] },
    }),
    tx('void', '2026-03-06T10:00:00Z', [{ lineTotal: 500, consignorId: 'ana' }], { revertedAt: 1 }),
    // 23:30 on 31 March in Zurich is 1 April: next period.
    tx('apr', '2026-03-31T22:30:00Z', [{ lineTotal: 70, consignorId: 'ana' }]),
  ];
  const report = storeReport({
    period: { from: '2026-03-01', to: '2026-03-31' },
    settings,
    transactions: txs,
    consignors: [ana, { id: 'ben', name: 'Ben', commissionPct: 30, storeCommission: {} }],
    payouts: [{ consignorId: 'ana', amount: 30, currency: 'CHF', date: '2026-03-01' }, { consignorId: 'ben', amount: 10, currency: 'CHF', date: '2026-01-01' }],
    fees: [{ consignorId: 'ana', amount: 15, currency: 'CHF', date: '2026-03-12', status: 'charged' }],
    rentals: [rental],
  });

  it('sums the period’s sales, discounts, VAT and payment methods', () => {
    expect(report.totals).toEqual([
      expect.objectContaining({ currency: 'CHF', sales: 1, units: 2, gross: 110, discounts: 10, vat: 8.24, net: 101.76, cash: 20, card: 90, other: 0, cardFees: 1.8, consigned: 90, commission: 36, artistShare: 54, cardFeesPassed: 0, own: 20 }),
    ]);
    expect(report.vat).toEqual([{ currency: 'CHF', rate: 8.1, gross: 110, net: 101.76, vat: 8.24 }]);
    expect(report.discountsByName).toEqual([{ name: 'Artist of the month', currency: 'CHF', amount: 10, sales: 1 }]);
  });

  it('shows each artist what the period earned and what is owed at its end', () => {
    const a = report.artists.find((r) => r.consignorId === 'ana')!;
    // Earned: 54 share − 50 rent (the March month) − 15 fee. Balance: + February's 30 share − 30 paid − February's rent.
    expect(a).toMatchObject({ units: 1, gross: 90, discounts: 10, commission: 36, artistShare: 54, rent: 50, fees: 15, paid: 30, earned: -11, balance: -61 });
    // Ben sold nothing, but was paid ahead: he still shows.
    expect(report.artists.find((r) => r.consignorId === 'ben')).toMatchObject({ units: 0, balance: -10 });
  });

  it('exports as a spreadsheet', () => {
    const csv = reportCsv(report, () => 'Zurich shop');
    expect(csv).toContain('Ana,CHF,1,90,10,36,54,0,50,15,-11,30,-61');
    expect(csv).toContain('Zurich shop,CHF,1,2,110,10,8.24,101.76,20,90,0,1.80,90,36,20');
  });
});
