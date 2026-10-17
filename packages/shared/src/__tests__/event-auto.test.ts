import { describe, expect, it } from 'vitest';
import { autoEventChanges, cleanAutoEventSettings } from '../event-auto';

const ev = (id: string, status: 'planned' | 'active' | 'closed', dateStart?: string, dateEnd?: string, kind?: 'event' | 'store') => ({ id, status, dateStart, dateEnd, kind });
const both = { open: true, close: true };
const today = '2026-10-17';

describe('automatic event status', () => {
  it('opens a planned event on its first day and while it runs, not before', () => {
    const r = autoEventChanges([ev('today', 'planned', '2026-10-17', '2026-10-18'), ev('running', 'planned', '2026-10-16', '2026-10-18'), ev('future', 'planned', '2026-10-18', '2026-10-19'), ev('single', 'planned', '2026-10-17')], today, both);
    expect(r.open.map((e) => e.id)).toEqual(['today', 'running', 'single']);
  });

  it('closes an open event the day after its last day, never a store or an undated event', () => {
    const r = autoEventChanges([ev('lastday', 'active', '2026-10-15', '2026-10-17'), ev('over', 'active', '2026-10-15', '2026-10-16'), ev('store', 'active', '2026-01-01', '2026-01-02', 'store'), ev('undated', 'active')], today, both);
    expect(r.close.map((e) => e.id)).toEqual(['over']);
  });

  it('leaves a planned event whose dates passed alone, and closed or deleted events too', () => {
    const r = autoEventChanges([ev('missed', 'planned', '2026-10-01', '2026-10-02'), ev('closed', 'closed', '2026-10-17'), { ...ev('gone', 'planned', '2026-10-17'), deletedAt: 1 }], today, both);
    expect(r).toEqual({ open: [], close: [] });
  });

  it('does only what is switched on', () => {
    const list = [ev('a', 'planned', '2026-10-17'), ev('b', 'active', '2026-10-01')];
    expect(autoEventChanges(list, today, { open: true, close: false })).toMatchObject({ open: [{ id: 'a' }], close: [] });
    expect(autoEventChanges(list, today, { open: false, close: true })).toMatchObject({ open: [], close: [{ id: 'b' }] });
    expect(cleanAutoEventSettings({ open: 'yes', close: true })).toEqual({ open: false, close: true });
  });
});

import { autoEventChangesAt, eventTimeZone } from '../event-auto';

describe('on the venue clock', () => {
  const at = (iso: string) => Date.parse(iso);
  const placed = (id: string, status: 'planned' | 'active', start: string, end: string, country: string) => ({ ...ev(id, status, start, end), venue: { country } });

  it('knows single-zone countries and leaves spread-out ones unknown', () => {
    expect(eventTimeZone({ venue: { country: 'Germany' } })).toBe('Europe/Berlin');
    expect(eventTimeZone({ venue: { country: 'CH' } })).toBe('Europe/Zurich');
    expect(eventTimeZone({ venue: { country: 'United States' } })).toBeUndefined();
    expect(eventTimeZone({ venue: {} })).toBeUndefined();
  });

  it('opens and closes at local midnight in a known zone', () => {
    const list = [placed('next', 'planned', '2026-10-17', '2026-10-18', 'Germany'), placed('last', 'active', '2026-10-15', '2026-10-16', 'Germany')];
    // 21:30 UTC on the 16th is 23:30 in Berlin: still the 16th there.
    expect(autoEventChangesAt(list, at('2026-10-16T21:30:00Z'), both)).toEqual({ open: [], close: [] });
    // 22:30 UTC is 00:30 on the 17th in Berlin.
    expect(autoEventChangesAt(list, at('2026-10-16T22:30:00Z'), both)).toMatchObject({ open: [{ id: 'next' }], close: [{ id: 'last' }] });
  });

  it('with no known zone, closes only once the last day is over everywhere', () => {
    const us = [placed('con', 'active', '2026-10-15', '2026-10-16', 'United States')];
    // 03:00 UTC on the 17th is still the evening of the 16th in California.
    expect(autoEventChangesAt(us, at('2026-10-17T03:00:00Z'), both).close).toEqual([]);
    expect(autoEventChangesAt(us, at('2026-10-17T12:30:00Z'), both).close).toMatchObject([{ id: 'con' }]);
  });

  it('in a country over several zones, opens only once the first day has begun everywhere in it', () => {
    const us = [placed('con', 'planned', '2026-10-17', '2026-10-18', 'United States')];
    // 05:00 UTC on the 17th is the 17th in New York but still the evening of
    // the 16th in the west: not yet (it would lock the event before it, still selling).
    expect(autoEventChangesAt(us, at('2026-10-17T05:00:00Z'), both).open).toEqual([]);
    // 10:30 UTC is just past midnight in Honolulu, the westernmost US zone.
    expect(autoEventChangesAt(us, at('2026-10-17T10:30:00Z'), both).open).toMatchObject([{ id: 'con' }]);
  });
});
