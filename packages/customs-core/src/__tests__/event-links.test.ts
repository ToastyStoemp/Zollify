import { describe, expect, it } from 'vitest';
import type { SalesEvent } from '@zollify/shared';
import { eventGroup, setEventLink, type EventStore } from '../event-links';

function event(id: string, over: Partial<SalesEvent> = {}): SalesEvent {
  return { id, name: id, venue: {}, currency: 'CHF', ...over } as SalesEvent;
}

function store(...events: SalesEvent[]): EventStore & { all: Map<string, SalesEvent> } {
  const all = new Map(events.map((e) => [e.id, e]));
  return {
    all,
    list: () => [...all.values()],
    get: (id) => all.get(id),
    upsert: async (e) => {
      all.set(e.id, e);
    },
  };
}

const ids = (s: ReturnType<typeof store>, id: string, key: 'customs' | 'customsDe') =>
  (s.all.get(id)?.[key]?.combinedEventIds as string[] | undefined)?.slice().sort();

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

  it('keeps the rest of the customs record', async () => {
    const s = store(
      event('a', { customs: { combinedEventIds: ['c'], meta: { companyCode: 'PN' } }, customsDe: { meta: { eori: 'DE1' } } }),
      event('b'),
      event('c'),
    );
    await setEventLink(s, 'a', 'b', true);
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

  it('joining an event to a linked pair links all three', async () => {
    const s = store(event('a'), event('b'), event('c'));
    await setEventLink(s, 'a', 'b', true);
    const fromC = await setEventLink(s, 'c', 'b', true);
    expect(fromC.sort()).toEqual(['a', 'b']);
    for (const [id, others] of [['a', ['b', 'c']], ['b', ['a', 'c']], ['c', ['a', 'b']]] as const) {
      expect(ids(s, id, 'customs')).toEqual(others);
      expect(ids(s, id, 'customsDe')).toEqual(others);
    }
  });

  it('linking two groups merges them', async () => {
    const s = store(event('a'), event('b'), event('c'), event('d'));
    await setEventLink(s, 'a', 'b', true);
    await setEventLink(s, 'c', 'd', true);
    await setEventLink(s, 'a', 'd', true);
    expect(ids(s, 'b', 'customs')).toEqual(['a', 'c', 'd']);
    expect(ids(s, 'c', 'customsDe')).toEqual(['a', 'b', 'd']);
  });

  it('unlinking takes one event out and leaves the rest linked', async () => {
    const s = store(event('a'), event('b'), event('c'));
    await setEventLink(s, 'a', 'b', true);
    await setEventLink(s, 'a', 'c', true);
    const left = await setEventLink(s, 'a', 'c', false);
    expect(left).toEqual(['b']);
    expect(ids(s, 'c', 'customs')).toEqual([]);
    expect(ids(s, 'b', 'customs')).toEqual(['a']);
    expect(ids(s, 'b', 'customsDe')).toEqual(['a']);
  });

  it('unticking an event from another group leaves that group alone', async () => {
    const s = store(event('a'), event('b'), event('c'), event('d'));
    await setEventLink(s, 'a', 'b', true);
    await setEventLink(s, 'c', 'd', true);
    await setEventLink(s, 'a', 'c', false);
    expect(ids(s, 'a', 'customs')).toEqual(['b']);
    expect(ids(s, 'c', 'customs')).toEqual(['d']);
  });

  it('finds a group through links saved one-way, in either country', () => {
    const events = [
      event('a', { customs: { combinedEventIds: ['b'] } }),
      event('b'),
      event('c', { customsDe: { combinedEventIds: ['b'] } }),
      event('d'),
    ];
    expect(eventGroup(events, 'b').sort()).toEqual(['a', 'b', 'c']);
  });
});
