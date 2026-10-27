import { describe, expect, it } from 'vitest';
import { TravelRatesSchema, coveredByPerDiem, defaultTravelRates, describeDetail, mileage, perDiem, perDiemRateFor, perDiemsDue, splitShared, type PerDiemEvent } from '../travel-costs';

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

describe('perDiemsDue', () => {
  const ev = (id: string, extra: Partial<PerDiemEvent> = {}): PerDiemEvent => ({ id, status: 'closed', dateStart: '2026-05-01', dateEnd: '2026-05-03', venue: { country: 'Germany' }, currency: 'EUR', ...extra });
  const rates = { ...defaultTravelRates('DE'), auto: { on: true, people: 2, travelDays: true, from: '2026-01-01' } };

  it('gives a closed event with dates its per diem, a travel day either side, for the people set', () => {
    const due = perDiemsDue([ev('a')], new Set(), rates);
    // 30 April to 4 May: 3 full days at 28 and two travel days at 14, twice.
    expect(due).toEqual([
      expect.objectContaining({ eventId: 'a', currency: 'EUR', date: '2026-04-30', amount: 224, detail: { kind: 'perdiem', country: 'DE', start: '2026-04-30', end: '2026-05-04', people: 2, rate: { full: 28, reduced: 14 }, year: 2025, auto: true } }),
    ]);
    expect(due[0]!.note).toBe('Per diems 2026-04-30 to 2026-05-04 (DE, 2025 rates): 3 × 28.00 EUR + 2 × 14.00 EUR, 2 people');
    expect(perDiemsDue([ev('a')], new Set(), { ...rates, auto: { ...rates.auto, travelDays: false, people: 1 } })[0]).toMatchObject({ date: '2026-05-01', amount: 56, detail: { start: '2026-05-01', end: '2026-05-03' } });
  });

  it('takes the venue\'s rate, and the end date alone when that is all the event has', () => {
    expect(perDiemsDue([ev('dk', { venue: { country: 'Denmark' } })], new Set(), rates)[0]).toMatchObject({ amount: 650, detail: { country: 'DK', rate: { full: 75, reduced: 50 } } });
    expect(perDiemsDue([ev('one', { dateStart: undefined, dateEnd: '2026-05-01' })], new Set(), rates)[0]).toMatchObject({ detail: { start: '2026-04-30', end: '2026-05-02' }, amount: 112 });
  });

  it('leaves out what is not due: off, done, open, a store, the test event, no dates, before the start', () => {
    expect(perDiemsDue([ev('a')], new Set(), { ...rates, auto: { ...rates.auto, on: false } })).toEqual([]);
    expect(perDiemsDue([ev('a')], new Set(['a']), rates)).toEqual([]);
    expect(perDiemsDue([ev('a', { status: 'active' }), ev('b', { status: 'planned' })], new Set(), rates)).toEqual([]);
    expect(perDiemsDue([ev('s', { kind: 'store' }), ev('t', { test: true }), ev('gone', { deletedAt: 1 })], new Set(), rates)).toEqual([]);
    expect(perDiemsDue([ev('nodate', { dateStart: undefined, dateEnd: undefined })], new Set(), rates)).toEqual([]);
    expect(perDiemsDue([ev('old', { dateStart: '2025-12-30', dateEnd: '2025-12-31' })], new Set(), rates)).toEqual([]);
    // Ending on the start day counts; an empty start takes every closed event.
    expect(perDiemsDue([ev('edge', { dateStart: '2025-12-30', dateEnd: '2026-01-01' })], new Set(), rates)).toHaveLength(1);
    expect(perDiemsDue([ev('old', { dateStart: '2025-12-30', dateEnd: '2025-12-31' })], new Set(), { ...rates, auto: { ...rates.auto, from: '' } })).toHaveLength(1);
  });

  it('the setting is off, for one person with travel days, until it is set', () => {
    expect(TravelRatesSchema.parse({ homeCountry: 'DE' }).auto).toEqual({ on: false, people: 1, travelDays: true, from: '' });
    expect(TravelRatesSchema.safeParse({ homeCountry: 'DE', auto: { on: true, people: 0 } }).success).toBe(false);
    expect(TravelRatesSchema.safeParse({ homeCountry: 'DE', auto: { on: true, from: '1.1.2026' } }).success).toBe(false);
  });
});

describe('coveredByPerDiem', () => {
  const perdiem = { id: 'pd', eventId: 'a', category: 'perdiem', date: '2026-04-30', detail: { kind: 'perdiem' as const, country: 'DE', start: '2026-04-30', end: '2026-05-04', people: 1, rate: { full: 28, reduced: 14 }, year: 2025 } };
  it('marks food bought on the days a per diem on the same event covers, and nothing else', () => {
    const lunch = { id: 'l', eventId: 'a', category: 'food', date: '2026-05-02', detail: null };
    const later = { id: 'x', eventId: 'a', category: 'food', date: '2026-05-05' };
    const elsewhere = { id: 'e', eventId: 'b', category: 'food', date: '2026-05-02' };
    const hotel = { id: 'h', eventId: 'a', category: 'accommodation', date: '2026-05-02' };
    const undated = { id: 'u', eventId: 'a', category: 'food', date: '' };
    expect(coveredByPerDiem([perdiem, lunch, later, elsewhere, hotel, undated])).toEqual([lunch]);
    expect(coveredByPerDiem([lunch])).toEqual([]);
  });
});
