import { describe, expect, it } from 'vitest';
import type { EventOverlay, SalesEvent } from '@zollify/shared';
import { migrateBoothToEvents } from '../migrate';

const ev = (id: string, over: Partial<SalesEvent> = {}): SalesEvent => ({
  id,
  name: id,
  venue: {},
  currency: 'CHF',
  status: 'planned',
  updatedAt: 1,
  ...over,
});

function deps(events: SalesEvent[], overlays: Record<string, Partial<EventOverlay>>) {
  const store = new Map(events.map((e) => [e.id, e]));
  const upserts: string[] = [];
  return {
    store,
    upserts,
    deps: {
      overlays: async () => overlays as Record<string, EventOverlay>,
      events: () => [...store.values()],
      upsert: async (e: SalesEvent) => {
        upserts.push(e.id);
        store.set(e.id, e);
      },
    },
  };
}

describe('migrateBoothToEvents', () => {
  it('copies overlay booth facts onto events, and is idempotent', async () => {
    const t = deps([ev('a'), ev('b')], { a: { hall: '3', booth: 'B-12', blurb: 'Pins' } });
    expect(await migrateBoothToEvents(t.deps)).toBe(1);
    expect(t.store.get('a')?.booth).toEqual({ hall: '3', number: 'B-12', note: 'Pins' });
    expect(t.store.get('b')?.booth).toBeUndefined();
    expect(await migrateBoothToEvents(t.deps)).toBe(0);
    expect(t.upserts).toEqual(['a']);
  });

  it('never overwrites a field the event already has', async () => {
    const t = deps([ev('a', { booth: { hall: '9' } })], { a: { hall: '3', booth: 'B-12' } });
    await migrateBoothToEvents(t.deps);
    expect(t.store.get('a')?.booth).toEqual({ hall: '9', number: 'B-12' });
  });

  it('swallows a failed overlay fetch so the app keeps loading', async () => {
    const t = deps([ev('a')], {});
    const n = await migrateBoothToEvents({ ...t.deps, overlays: async () => { throw new Error('offline'); } });
    expect(n).toBe(0);
  });
});
