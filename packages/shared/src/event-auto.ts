import type { SalesEvent } from './types';
import { localDay } from './consignment-books';
import { zoneOfCountry } from './locale-guess';
import { countryCodeOf } from './vat';

/**
 * Opening and closing events by their dates, when the owner switches it on
 * (Events → Automatic). An event opens on its first day and closes the day
 * after its last, so a till is never left on last weekend's convention and a
 * new one never waits for someone to tap Open. Stores have no end and are
 * never closed this way; an event without dates is left alone.
 */

export interface AutoEventSettings {
  /** Open a planned event on its first day. */
  open: boolean;
  /** Close an open event the day after its last day. */
  close: boolean;
}

export const AUTO_EVENT_DEFAULTS: AutoEventSettings = { open: false, close: false };

export function cleanAutoEventSettings(v: unknown): AutoEventSettings {
  const src = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { open: src.open === true, close: src.close === true };
}

type Dated = Pick<SalesEvent, 'id' | 'status' | 'kind' | 'dateStart' | 'dateEnd' | 'deletedAt'>;

/** What should change today: events to open and events to close. Pure - the caller writes them. */
export function autoEventChanges<T extends Dated>(events: Iterable<T>, today: string, settings: AutoEventSettings): { open: T[]; close: T[] } {
  const open: T[] = [];
  const close: T[] = [];
  for (const e of events) {
    if (e.deletedAt) continue;
    const start = e.dateStart || e.dateEnd;
    const end = e.dateEnd || e.dateStart;
    if (!start || !end) continue;
    if (settings.open && e.status === 'planned' && start <= today && end >= today) open.push(e);
    else if (settings.close && e.kind !== 'store' && e.status === 'active' && end < today) close.push(e);
  }
  return { open, close };
}

type Placed = Dated & { venue?: { country?: string } };

/** The time zone of an event's venue, when its country keeps a single one. */
export function eventTimeZone(e: { venue?: { country?: string } }, at = Date.now()): string | undefined {
  const code = countryCodeOf(e.venue?.country) || (e.venue?.country ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? zoneOfCountry(code, at) : undefined;
}

/**
 * As autoEventChanges, judged at the moment `now` on each event's own clock:
 * the venue's time zone where its country has one. Where it is not known an
 * event opens by the UTC date (a few hours early at worst - harmless) and
 * closes only once its last day is over everywhere (UTC-12), so a seller is
 * never closed while still selling on the last evening.
 */
export function autoEventChangesAt<T extends Placed>(events: Iterable<T>, now: number, settings: AutoEventSettings): { open: T[]; close: T[] } {
  const open: T[] = [];
  const close: T[] = [];
  for (const e of events) {
    const zone = eventTimeZone(e, now);
    const openDay = localDay(now, zone ?? 'UTC');
    const closeDay = zone ? openDay : localDay(now - 12 * 3600_000, 'UTC');
    open.push(...autoEventChanges([e], openDay, { open: settings.open, close: false }).open);
    close.push(...autoEventChanges([e], closeDay, { open: false, close: settings.close }).close);
  }
  return { open, close };
}
