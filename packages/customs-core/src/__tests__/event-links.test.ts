import { describe, expect, it } from 'vitest';
import type { SalesEvent } from '@zollify/shared';
import { setEventLink, type EventStore } from '../event-links';

function event(id: string, over: Partial<SalesEvent> = {}): SalesEvent {
  return { id, name: id, venue: {}, currency: 'CHF', ...over } as SalesEvent;
}

function store(...events: SalesEvent[]): EventStore & { all: Map<string, SalesEvent> } {
  const all = new Map(events.map((e) => [e.id, e]));
  return {
    all,
    get: (id) => all.get(id),
    upsert: async (e) => {
      all.set(e.id, e);
    },
  };
}

const ids = (s: ReturnType<typeof store>, id: string, key: 'customs' | 'customsDe') =>
  s.all.get(id)?.[key]?.combinedEventIds;

describe('setEventLink', () => {
  it('one link writes four lists: both events, both countries', async () => {
    const s = store(event('a'), event('b'));
    await setEventLink(s, 'a', 'b', true);
    expect(ids(s, 'a', 'customs')).toEqual(['b']);
    expect(ids(s, 'a', 'customsDe')).toEqual(['b']);
    expect(ids(s, 'b', 'customs')).toEqual(['a']);
    expect(ids(s, 'b', 'customsDe')).toEqual(['a']);
  });

  it('unlinking removes all four', async () => {
    const s = store(event('a'), event('b'));
    await setEventLink(s, 'a', 'b', true);
    await setEventLink(s, 'b', 'a', false);
    for (const id of ['a', 'b']) {
      expect(ids(s, id, 'customs')).toEqual([]);
      expect(ids(s, id, 'customsDe')).toEqual([]);
    }
  });

  it('keeps other links and the rest of the customs record', async () => {
    const s = store(
      event('a', { customs: { combinedEventIds: ['c'], meta: { companyCode: 'PN' } }, customsDe: { meta: { eori: 'DE1' } } }),
      event('b'),
      event('c'),
    );
    await setEventLink(s, 'a', 'b', true);
    expect(ids(s, 'a', 'customs')).toEqual(['c', 'b']);
    expect(s.all.get('a')?.customs?.meta).toEqual({ companyCode: 'PN' });
    expect(s.all.get('a')?.customsDe?.meta).toEqual({ eori: 'DE1' });
  });

  it('does not duplicate an existing link or link an event to itself', async () => {
    const s = store(event('a', { customs: { combinedEventIds: ['b'] } }), event('b'));
    await setEventLink(s, 'a', 'b', true);
    expect(ids(s, 'a', 'customs')).toEqual(['b']);
    await setEventLink(s, 'a', 'a', true);
    expect(ids(s, 'a', 'customs')).toEqual(['b']);
  });
});
