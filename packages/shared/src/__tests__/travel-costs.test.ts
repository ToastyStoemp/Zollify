import { describe, expect, it } from 'vitest';
import { TravelRatesSchema, defaultTravelRates, describeDetail, mileage, perDiem, perDiemRateFor, splitShared } from '../travel-costs';

describe('per diems', () => {
  const rate = { full: 28, reduced: 14 };
  it('pay arrival and departure at the reduced rate and the days between in full, per person', () => {
    expect(perDiem({ start: '2026-05-01', end: '2026-05-03', people: 2, rate })).toEqual({ days: 3, fullDays: 1, reducedDays: 2, perPerson: 56, amount: 112 });
    expect(perDiem({ start: '2026-05-01', end: '2026-05-02', people: 1, rate })).toMatchObject({ days: 2, fullDays: 0, reducedDays: 2, amount: 28 });
    // A one-day trip over 8 hours: once, reduced.
    expect(perDiem({ start: '2026-05-01', end: '2026-05-01', people: 1, rate })).toMatchObject({ days: 1, fullDays: 0, reducedDays: 1, amount: 14 });
    expect(perDiem({ start: '2026-05-03', end: '2026-05-01', people: 1, rate })).toBeNull();
    expect(perDiem({ start: '', end: '2026-05-01', people: 1, rate })).toBeNull();
    expect(perDiem({ start: '2026-05-01', end: '2026-05-03', people: 0, rate })!.amount).toBe(0);
  });

  it('picks the destination rate: home, listed, or the fallback', () => {
    const de = defaultTravelRates('DE');
    expect(perDiemRateFor(de, 'DE')).toEqual({ rate: { full: 28, reduced: 14 }, where: 'domestic' });
    expect(perDiemRateFor(de, '')).toMatchObject({ where: 'domestic' });
    expect(perDiemRateFor(de, 'Denmark')).toEqual({ rate: { full: 75, reduced: 50 }, where: 'listed' });
    expect(perDiemRateFor(de, 'nl')).toMatchObject({ where: 'listed' });
    expect(perDiemRateFor(de, 'JP')).toEqual({ rate: de.fallback, where: 'fallback' });
    const be = defaultTravelRates('Belgium');
    expect(be.homeCountry).toBe('BE');
    expect(perDiemRateFor(be, 'BE').rate.full).toBe(20.8);
    expect(perDiemRateFor(be, 'DE').rate).toEqual({ full: 97, reduced: 48.5 });
  });

  it('a country without a table starts from Germany\'s shape with its own code', () => {
    const fr = defaultTravelRates('FR');
    expect(fr.homeCountry).toBe('FR');
    expect(fr.abroad).toEqual({});
    expect(TravelRatesSchema.safeParse(fr).success).toBe(true);
    expect(defaultTravelRates('DE')).not.toBe(defaultTravelRates('DE'));
  });
});

describe('mileage', () => {
  it('doubles for there and back, times the trips, at the rate', () => {
    expect(mileage({ km: 120.5, roundTrip: true, trips: 1, ratePerKm: 0.3 })).toEqual({ km: 241, amount: 72.3 });
    expect(mileage({ km: 100, roundTrip: false, trips: 2, ratePerKm: 0.4316 })).toEqual({ km: 200, amount: 86.32 });
    expect(mileage({ km: -5, roundTrip: true, trips: 1, ratePerKm: 0.3 })).toEqual({ km: 0, amount: 0 });
  });
});

describe('splitShared', () => {
  it('splits by days or evenly, in whole cents, the remainder on the last', () => {
    const events = [{ id: 'a', days: 3 }, { id: 'b', days: 1 }, { id: 'c', days: 0 }];
    expect(splitShared(100, events, 'days')).toEqual([{ id: 'a', amount: 60 }, { id: 'b', amount: 20 }, { id: 'c', amount: 20 }]);
    expect(splitShared(100, events, 'even')).toEqual([{ id: 'a', amount: 33.33 }, { id: 'b', amount: 33.33 }, { id: 'c', amount: 33.34 }]);
    expect(splitShared(100, [], 'even')).toEqual([]);
    expect(splitShared(0.01, [{ id: 'a', days: 1 }, { id: 'b', days: 1 }], 'even')).toEqual([{ id: 'a', amount: 0.01 }, { id: 'b', amount: 0 }]);
  });
});

describe('describeDetail', () => {
  it('says how the figure came about', () => {
    expect(describeDetail({ kind: 'perdiem', country: 'DK', start: '2026-05-01', end: '2026-05-03', people: 2, rate: { full: 75, reduced: 50 }, year: 2025 }, 'EUR')).toBe('Per diems 2026-05-01 to 2026-05-03 (DK, 2025 rates): 1 × 75.00 EUR + 2 × 50.00 EUR, 2 people');
    expect(describeDetail({ kind: 'mileage', km: 240, roundTrip: true, trips: 1, ratePerKm: 0.3 }, 'EUR')).toBe('Mileage: 240 km there and back at 0.30 EUR/km');
    expect(describeDetail({ kind: 'shared', groupId: 'g', method: 'days', total: 1200, of: 4 }, 'EUR')).toBe('Share of 1200.00 EUR split by days over 4 events');
  });
});
