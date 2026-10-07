import { describe, expect, it } from 'vitest';
import { BOOTH_LIMITS, EventBoothSchema, boothFromOverlay, cleanBooth, eventsToMigrateBooth, planBoothCleanup, resolveBooth, safeHttpsUrl } from '../event-booth';
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
  it('reads the event only; a cleared field stays cleared', () => {
    expect(resolveBooth({ booth: { hall: '9', note: 'Mine' } })).toEqual({ hall: '9', number: '', link: '', note: 'Mine' });
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

  it('reads booth facts from the event and no longer from the overlay', () => {
    const { upcoming } = splitPublicEvents(
      [ev('a', { booth: { hall: '9', number: 'Z-1', link: 'https://con.example', note: 'Hi' } }), ev('b', { booth: { hall: '5' } })],
      { a: { hall: '3', booth: 'B-12' }, b: { hall: '4', booth: 'C-2', blurb: 'Legacy', igHandle: '@con' } },
      12,
      today,
    );
    const a = upcoming.find((e) => e.id === 'a')!;
    expect([a.hall, a.booth, a.link, a.blurb]).toEqual(['9', 'Z-1', 'https://con.example', 'Hi']);
    const b = upcoming.find((e) => e.id === 'b')!;
    expect([b.hall, b.booth, b.blurb, b.igHandle]).toEqual(['5', '', '', '@con']);
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

describe('planBoothCleanup', () => {
  const legacy = { hall: '3', booth: 'B-12', link: 'https://con.example', blurb: 'Pins', igHandle: '@x', hidden: true };

  it('copies empty fields onto the event, then removes the overlay booth fields', () => {
    const plan = planBoothCleanup([ev('a')], { a: legacy });
    expect(plan.events[0]!.booth).toEqual({ hall: '3', number: 'B-12', link: 'https://con.example', note: 'Pins' });
    expect(plan.overlays.a).toEqual({ igHandle: '@x', hidden: true });
  });

  it('removes overlay fields whose event field is set, keeping the event value', () => {
    const plan = planBoothCleanup([ev('a', { booth: { hall: '9', number: 'Z-1', link: 'https://own.example', note: 'Mine' } })], { a: legacy });
    expect(plan.events).toEqual([]);
    expect(plan.overlays.a).toEqual({ igHandle: '@x', hidden: true });
  });

  it('works per field: a field the event lacks is copied, one it has is just removed', () => {
    const plan = planBoothCleanup([ev('a', { booth: { hall: '9' } })], { a: { hall: '3', booth: 'B-12' } });
    expect(plan.events[0]!.booth).toEqual({ hall: '9', number: 'B-12' });
    expect(plan.overlays.a).toEqual({});
  });

  it('keeps a value that cannot be carried, and skips unknown and deleted events', () => {
    const plan = planBoothCleanup([ev('a'), ev('c', { deletedAt: 1 })], {
      a: { link: 'http://insecure.example', hall: '3' },
      c: { hall: '3' },
      gone: { hall: '3' },
    });
    expect(plan.overlays.a).toEqual({ link: 'http://insecure.example' });
    expect(plan.overlays).not.toHaveProperty('c');
    expect(plan.overlays).not.toHaveProperty('gone');
  });

  it('is idempotent', () => {
    const first = planBoothCleanup([ev('a')], { a: legacy });
    const events = [first.events[0]!];
    expect(planBoothCleanup(events, { a: first.overlays.a! })).toEqual({ events: [], overlays: {} });
  });
});
