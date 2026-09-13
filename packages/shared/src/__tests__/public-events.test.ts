import { describe, expect, it } from 'vitest';
import { countryFlag } from '../flags';
import { buildBio, buildIcs, formatBioDateRange, splitPublicEvents } from '../public-events';
import type { SalesEvent } from '../types';

const ev = (id: string, dateStart?: string, dateEnd?: string, over: Partial<SalesEvent> = {}): SalesEvent => ({
  id,
  name: `Event ${id}`,
  dateStart,
  dateEnd,
  venue: { city: 'Zürich', country: 'Switzerland' },
  currency: 'CHF',
  status: 'planned',
  updatedAt: 1,
  ...over,
});

const today = new Date('2026-09-13T00:00:00');

describe('splitPublicEvents', () => {
  it('sorts upcoming ascending and past descending, and truncates past', () => {
    const { upcoming, past } = splitPublicEvents(
      [ev('a', '2026-10-03'), ev('b', '2026-09-20'), ev('c', '2026-01-01'), ev('d', '2026-03-01'), ev('e', '2025-12-01')],
      {},
      2,
      today,
    );
    expect(upcoming.map((e) => e.id)).toEqual(['b', 'a']);
    expect(past.map((e) => e.id)).toEqual(['d', 'c']);
  });

  it('drops hidden, deleted and undated events', () => {
    const { upcoming } = splitPublicEvents(
      [ev('a', '2026-10-03'), ev('b', '2026-10-04', undefined, { deletedAt: 5 }), ev('c'), ev('d', '2026-10-05')],
      { d: { hidden: true } },
      12,
      today,
    );
    expect(upcoming.map((e) => e.id)).toEqual(['a']);
  });

  it('flags ongoing and soon by date, not by status', () => {
    const { upcoming } = splitPublicEvents(
      [ev('now', '2026-09-12', '2026-09-14'), ev('soon', '2026-09-20'), ev('later', '2026-12-01')],
      {},
      12,
      today,
    );
    expect(upcoming.map((e) => [e.id, e.ongoing, e.soon])).toEqual([
      ['now', true, false],
      ['soon', false, true],
      ['later', false, false],
    ]);
  });

  it('exposes only display fields, never the record', () => {
    // A sale-bearing field on the event must not leak through.
    const { upcoming } = splitPublicEvents(
      [ev('a', '2026-10-03', undefined, { exchangeRate: 1.1, customs: { secret: 1 } } as Partial<SalesEvent>)],
      { a: { booth: 'B-12', hall: '3' } },
      12,
      today,
    );
    const row = upcoming[0]!;
    expect(row).not.toHaveProperty('exchangeRate');
    expect(row).not.toHaveProperty('customs');
    expect(row.booth).toBe('B-12');
    expect(row.flag).toBe(countryFlag('CH'));
  });
});

describe('countryFlag', () => {
  it('resolves names and codes, and gives nothing for the unknown', () => {
    expect(countryFlag('Switzerland')).toBe(countryFlag('ch'));
    expect(countryFlag('Switzerland').length).toBe(4); // two surrogate pairs
    expect(countryFlag('Narnia')).toBe('');
  });
});

describe('buildIcs', () => {
  it('emits all-day events with an exclusive end and folded long lines', () => {
    const { upcoming } = splitPublicEvents(
      [ev('a', '2026-10-03', '2026-10-04', { name: 'A'.repeat(90) })],
      { a: { link: 'https://example.test/con' } },
      12,
      today,
    );
    const ics = buildIcs(upcoming, { calName: 'Test events', host: 'zollify.test/p/x', now: new Date('2026-09-13T10:00:00Z') });
    expect(ics).toContain('DTSTART;VALUE=DATE:20261003');
    expect(ics).toContain('DTEND;VALUE=DATE:20261005');
    expect(ics).toContain('UID:a@zollify.test/p/x');
    expect(ics).toContain('URL:https://example.test/con');
    // No line may exceed 75 octets; the long SUMMARY was folded.
    for (const line of ics.split('\r\n')) expect(line.length).toBeLessThanOrEqual(75);
  });
});

describe('Instagram bio', () => {
  it('formats date ranges the Instagram way', () => {
    expect(formatBioDateRange('2026-07-17')).toBe('17th July');
    expect(formatBioDateRange('2026-07-17', '2026-07-19')).toBe('17-19th July');
    expect(formatBioDateRange('2026-07-30', '2026-08-02')).toBe('30th July - 2nd August');
    expect(formatBioDateRange('2026-12-30', '2027-01-02')).toBe('30th December 2026 - 2nd January 2027');
  });

  it('fills the template from the next event, falling back when there is none', () => {
    const { upcoming } = splitPublicEvents([ev('a', '2026-09-20', '2026-09-21')], { a: { igHandle: 'animemesse', booth: '5823' } }, 12, today);
    expect(buildBio(upcoming, 'Artist\n📍 {event}\nShop open', '')).toBe('Artist\n📍 @animemesse, booth 5823, 20-21st September\nShop open');
    expect(buildBio([], 'Artist\n📍 {event}\nShop open', 'Next dates soon')).toBe('Artist\n📍 Next dates soon\nShop open');
    // An empty {event} with no fallback collapses the blank it leaves.
    expect(buildBio([], 'Artist\n\n{event}\n\nShop open', '')).toBe('Artist\n\nShop open');
  });
});
