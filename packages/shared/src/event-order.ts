import { localIsoDay } from './day';
import type { SalesEvent } from './types';

type Dated = Pick<SalesEvent, 'dateStart' | 'dateEnd' | 'status' | 'name'>;

/** Closed, or its last day is behind us. Undated events never end on their own. */
export function eventHasEnded(e: Pick<SalesEvent, 'dateStart' | 'dateEnd' | 'status'>, today = localIsoDay()): boolean {
  if (e.status === 'closed') return true;
  const end = e.dateEnd || e.dateStart;
  return Boolean(end && end < today);
}

/**
 * The one order every event list uses: what is on or still to come first
 * (stores and undated events, then by start date, soonest first), then what
 * has ended, most recent first. Name breaks ties.
 */
export function compareEvents(today = localIsoDay()): (a: Dated, b: Dated) => number {
  return (a, b) => {
    const aEnded = eventHasEnded(a, today);
    const bEnded = eventHasEnded(b, today);
    if (aEnded !== bEnded) return aEnded ? 1 : -1;
    const key = (e: Dated): string => (aEnded ? e.dateEnd || e.dateStart : e.dateStart || e.dateEnd) || '';
    const byDate = aEnded ? key(b).localeCompare(key(a)) : key(a).localeCompare(key(b));
    return byDate || a.name.localeCompare(b.name);
  };
}

export function sortEvents<T extends Dated>(events: Iterable<T>, today = localIsoDay()): T[] {
  return [...events].sort(compareEvents(today));
}
