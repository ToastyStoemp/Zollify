/**
 * The calendar day of a moment as the device sees it (YYYY-MM-DD).
 *
 * NOT `toISOString().slice(0, 10)`: that converts to UTC first, so between
 * local midnight and UTC midnight "today" would be yesterday. Use `localDay`
 * from consignment-books when a specific store time zone is known instead.
 */
export function localIsoDay(d: Date | number = Date.now()): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * An event's dates the way people read them - "17–18 Oct", "31 Oct – 2 Nov",
 * with the year only when it is not this one - in the device's language.
 * Empty when there are no dates.
 */
export function fmtDayRange(start?: string, end?: string, thisYear = new Date().getFullYear()): string {
  const a = start || end;
  const b = end || start;
  if (!a || !b) return '';
  const at = (s: string) => new Date(`${s}T12:00:00`);
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', ...(at(a).getFullYear() !== thisYear || at(b).getFullYear() !== thisYear ? { year: 'numeric' } : {}) };
  const one = (s: string) => at(s).toLocaleDateString(undefined, opts);
  if (a === b) return one(a);
  try {
    return new Intl.DateTimeFormat(undefined, opts).formatRange(at(a), at(b));
  } catch {
    return `${one(a)} – ${one(b)}`;
  }
}

/** Days an event runs, first and last day included; 0 without both dates. */
export function eventDays(start?: string, end?: string): number {
  if (!start || !end) return 0;
  return Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000) + 1;
}
