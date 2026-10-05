import type { SalesEvent } from '@zollify/shared';

/**
 * Linking events whose sales fold into one declaration ("combine sales from
 * other events"). A link describes a trip - the same stock taken across the
 * border once and sold at back-to-back shows - so linked events form a
 * group, and every event in a group lists every other one, in both the
 * Swiss (`customs`) and German (`customsDe`) records.
 *
 * Linking two events joins their groups: A-B linked to C makes A, B and C
 * all linked. Unlinking takes one event out of its group; the rest stay
 * linked to each other.
 */

/** The customs record keys that carry a `combinedEventIds` list. */
const CUSTOMS_KEYS = ['customs', 'customsDe'] as const;

export interface EventStore {
  list(): SalesEvent[];
  get(id: string): SalesEvent | undefined;
  upsert(event: SalesEvent): Promise<void>;
}

function linkedIds(blob: Record<string, unknown> | undefined): string[] {
  const ids = blob?.combinedEventIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Who is linked to whom. An edge counts if either event lists the other in
 * either country's record, so links saved one-way before groups existed are
 * still found - and written both ways the next time the group changes.
 */
function adjacency(events: SalesEvent[]): Map<string, Set<string>> {
  const known = new Set(events.map((e) => e.id));
  const adj = new Map<string, Set<string>>();
  const edge = (a: string, b: string): void => {
    if (a === b || !known.has(a) || !known.has(b)) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const e of events) {
    for (const key of CUSTOMS_KEYS) for (const other of linkedIds(e[key])) edge(e.id, other);
  }
  return adj;
}

/** Every event in `id`'s group, itself included. */
export function eventGroup(events: SalesEvent[], id: string): string[] {
  const adj = adjacency(events);
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    for (const next of adj.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen];
}

/** `event` with both customs records' lists set to `ids`, if that changes anything. */
function withLinks(event: SalesEvent, ids: string[]): SalesEvent | null {
  const want = [...ids].sort().join('\n');
  if (CUSTOMS_KEYS.every((key) => [...linkedIds(event[key])].sort().join('\n') === want)) return null;
  const next: SalesEvent = { ...event, updatedAt: Date.now() };
  for (const key of CUSTOMS_KEYS) next[key] = { ...(event[key] ?? {}), combinedEventIds: [...ids] };
  return next;
}

/**
 * Links `otherId` into `id`'s group (joining the two groups), or takes
 * `otherId` out of it. Returns the events `id` is now linked to.
 */
export async function setEventLink(events: EventStore, id: string, otherId: string, linked: boolean): Promise<string[]> {
  const all = events.list();
  if (id === otherId) return eventGroup(all, id).filter((x) => x !== id);

  const group = eventGroup(all, id);
  // Linking joins the two groups; unlinking only ever touches `id`'s own.
  const members = linked ? [...new Set([...group, ...eventGroup(all, otherId)])] : group.filter((x) => x !== otherId);
  const lists = new Map<string, string[]>(members.map((m) => [m, members.filter((x) => x !== m)]));
  // Leaving the group: the departing event keeps no links.
  if (!linked && group.includes(otherId)) lists.set(otherId, []);

  for (const [eventId, ids] of lists) {
    const ev = events.get(eventId);
    const next = ev && withLinks(ev, ids);
    if (next) await events.upsert(next);
  }
  return lists.get(id) ?? [];
}
