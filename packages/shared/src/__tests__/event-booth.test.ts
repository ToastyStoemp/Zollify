import { describe, expect, it } from 'vitest';
import { BOOTH_LIMITS, EventBoothSchema, boothFromOverlay, cleanBooth, eventsToMigrateBooth, resolveBooth, safeHttpsUrl } from '../event-booth';
import { splitPublicEvents } from '../public-events';
import type { SalesEvent } from '../types';

const ev = (id: string, over: Partial<SalesEvent> = {}): SalesEvent => ({
  id,
  name: `Event ${id}`,
  dateStart: '2099-05-01',
  venue: { city: 'Zürich', country: 'Switzerland' },
  currency: 'CHF',
  status: 'planned',
  updatedAt: 1,
  ...over,
});

describe('booth validation', () => {
  it('accepts https links only', () => {
    expect(safeHttpsUrl('https://con.example/x')).toBe('https://con.example/x');
    expect(safeHttpsUrl('http://con.example')).toBe('');
    expect(safeHttpsUrl('javascript:alert(1)')).toBe('');
    expect(safeHttpsUrl('not a url')).toBe('');
    expect(EventBoothSchema.safeParse({ link: 'http://con.example' }).success).toBe(false);
    expect(EventBoothSchema.safeParse({ link: 'https://con.example' }).success).toBe(true);
    expect(EventBoothSchema.safeParse({}).success).toBe(true);
  });

  it('caps field lengths', () => {
    expect(EventBoothSchema.safeParse({ hall: 'x'.repeat(BOOTH_LIMITS.hall + 1) }).success).toBe(false);
    expect(EventBoothSchema.safeParse({ note: 'x'.repeat(BOOTH_LIMITS.note + 1) }).success).toBe(false);
    expect(EventBoothSchema.safeParse({ note: 'x'.repeat(BOOTH_LIMITS.note) }).success).toBe(true);
  });

  it('cleanBooth trims, drops empties, bad links and over-long text', () => {
    expect(cleanBooth({ hall: ' 3 ', number: '', link: 'http://x.example', note: 'x'.repeat(401) })).toEqual({ hall: '3' });
    expect(cleanBooth({ link: 'https://x.example' })).toEqual({ link: 'https://x.example' });
    expect(cleanBooth({ hall: 5 })).toBeUndefined();
    expect(cleanBooth(undefined)).toBeUndefined();
    expect(cleanBooth('nope')).toBeUndefined();
  });
});

describe('resolveBooth', () => {
  it('event field wins, overlay fills only the empty ones', () => {
    const r = resolveBooth({ booth: { hall: '9', note: 'Mine' } }, { hall: '3', booth: 'B-12', link: 'https://old.example', blurb: 'Old' });
    expect(r).toEqual({ hall: '9', number: 'B-12', link: 'https://old.example', note: 'Mine' });
  });

  it('is empty with neither', () => {
    expect(resolveBooth({})).toEqual({ hall: '', number: '', link: '', note: '' });
  });

  it('ignores an unsafe link on the event rather than publishing it', () => {
    expect(resolveBooth({ booth: { link: 'javascript:alert(1)' } }).link).toBe('');
  });
});

describe('public output', () => {
  const today = new Date('2026-09-13T00:00:00');

  it('reads booth facts from the event, falling back to the overlay', () => {
    const { upcoming } = splitPublicEvents(
      [ev('a', { booth: { hall: '9', number: 'Z-1', link: 'https://con.example', note: 'Hi' } }), ev('b')],
      { a: { hall: '3', booth: 'B-12' }, b: { hall: '4', booth: 'C-2', blurb: 'Legacy' } },
      12,
      today,
    );
    const a = upcoming.find((e) => e.id === 'a')!;
    expect([a.hall, a.booth, a.link, a.blurb]).toEqual(['9', 'Z-1', 'https://con.example', 'Hi']);
    const b = upcoming.find((e) => e.id === 'b')!;
    expect([b.hall, b.booth, b.blurb]).toEqual(['4', 'C-2', 'Legacy']);
  });

  it('still honours the overlay hidden flag', () => {
    const { upcoming } = splitPublicEvents([ev('a', { booth: { hall: '9' } })], { a: { hidden: true } }, 12, today);
    expect(upcoming).toEqual([]);
  });
});

describe('eventsToMigrateBooth', () => {
  const overlays = { a: { hall: '3', booth: 'B-12', link: 'https://con.example', blurb: 'Pins', igHandle: '@x' } };

  it('fills empty event fields from the overlay and leaves the rest alone', () => {
    const out = eventsToMigrateBooth([ev('a'), ev('b'), ev('c', { deletedAt: 1 })], { ...overlays, c: overlays.a });
    expect(out.map((e) => e.id)).toEqual(['a']);
    expect(out[0]!.booth).toEqual({ hall: '3', number: 'B-12', link: 'https://con.example', note: 'Pins' });
  });

  it('never overwrites a field that is already set', () => {
    const out = eventsToMigrateBooth([ev('a', { booth: { hall: '9', note: 'Mine' } })], overlays);
    expect(out[0]!.booth).toEqual({ hall: '9', note: 'Mine', number: 'B-12', link: 'https://con.example' });
  });

  it('is idempotent', () => {
    const first = eventsToMigrateBooth([ev('a')], overlays);
    expect(eventsToMigrateBooth(first, overlays)).toEqual([]);
  });

  it('does nothing for an overlay with no booth facts or an unsafe link only', () => {
    expect(eventsToMigrateBooth([ev('a')], { a: { igHandle: '@x', hidden: true } })).toEqual([]);
    expect(boothFromOverlay({ link: 'http://insecure.example' })).toBeUndefined();
  });
});
