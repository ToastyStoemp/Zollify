import type { SalesEvent } from '@zollify/shared';

/**
 * Linking events whose sales fold into one declaration ("combine sales from
 * other events"). A link is one fact about a trip - the same stock taken
 * across the border once and sold at back-to-back shows - so it is written
 * everywhere it applies rather than only on the page it was ticked on:
 * both events, and both the Swiss (`customs`) and German (`customsDe`)
 * records. One tick, four lists.
 */

/** The customs record keys that carry a `combinedEventIds` list. */
const CUSTOMS_KEYS = ['customs', 'customsDe'] as const;

export interface EventStore {
  get(id: string): SalesEvent | undefined;
  upsert(event: SalesEvent): Promise<void>;
}

function linkedIds(blob: Record<string, unknown> | undefined): string[] {
  const ids = blob?.combinedEventIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

/** `event` with `otherId` added to (or removed from) both customs records' lists. */
export function withEventLink(event: SalesEvent, otherId: string, linked: boolean): SalesEvent {
  const next: SalesEvent = { ...event, updatedAt: Date.now() };
  for (const key of CUSTOMS_KEYS) {
    const blob = event[key];
    const ids = linkedIds(blob).filter((id) => id !== otherId);
    if (linked) ids.push(otherId);
    next[key] = { ...(blob ?? {}), combinedEventIds: ids };
  }
  return next;
}

/** Links (or unlinks) two events in both directions, for both countries. */
export async function setEventLink(events: EventStore, aId: string, bId: string, linked: boolean): Promise<void> {
  if (aId === bId) return;
  for (const [self, other] of [[aId, bId], [bId, aId]] as const) {
    const ev = events.get(self);
    if (ev) await events.upsert(withEventLink(ev, other, linked));
  }
}
