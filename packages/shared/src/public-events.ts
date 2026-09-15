import { z } from 'zod';
import { countryFlag } from './flags';
import type { SalesEvent } from './types';

/**
 * The public face of the events list: a "where to find us" page, a widget for
 * a shop, a calendar feed and an Instagram bio, all derived from the events
 * the booth already keeps. Only safe display fields ever leave - never sales.
 *
 * Ported from ZollEvents. Pure functions here so the server renders and the
 * app previews from the same code.
 */

// ── Per-event extras the booth adds on top of the event record ──────────────

export const EventOverlaySchema = z.object({
  /** Link to the convention's own site. */
  link: z.string().max(500).default(''),
  hall: z.string().max(40).default(''),
  booth: z.string().max(40).default(''),
  /** The convention's Instagram handle, with or without the @. */
  igHandle: z.string().max(60).default(''),
  blurb: z.string().max(400).default(''),
  /** Keep this event off every public output. */
  hidden: z.boolean().default(false),
});
export type EventOverlay = z.infer<typeof EventOverlaySchema>;

export const PublicEventsConfigSchema = z.object({
  /** Path segment the page lives at; null = not published. */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/, 'Use 3-40 letters, digits and dashes.')
    .nullable()
    .default(null),
  orgName: z.string().trim().max(80).default(''),
  tagline: z.string().trim().max(120).default('Where to find us'),
  showPast: z.boolean().default(true),
  pastLimit: z.number().int().min(0).max(100).default(12),
  igTemplate: z.string().max(600).default(''),
  igFallback: z.string().max(200).default(''),
});
export type PublicEventsConfig = z.infer<typeof PublicEventsConfigSchema>;

// ── The sanitised public shape ──────────────────────────────────────────────

export interface PublicEvent {
  id: string;
  name: string;
  start: string;
  end: string;
  city: string;
  country: string;
  flag: string;
  link: string;
  hall: string;
  booth: string;
  igHandle: string;
  blurb: string;
  past: boolean;
  /** Today falls within [start, end]. */
  ongoing: boolean;
  /** Starts within the next two weeks. */
  soon: boolean;
}

/** How many days ahead still counts as "soon". */
const SOON_DAYS = 14;

function toDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function publicOne(e: SalesEvent, ov: Partial<EventOverlay>, today: Date): PublicEvent {
  const start = e.dateStart ?? '';
  const end = e.dateEnd || start;
  const startD = toDate(start);
  const endD = toDate(end);
  return {
    id: e.id,
    name: e.name || 'Event',
    start,
    end,
    city: e.venue?.city ?? '',
    country: e.venue?.country ?? '',
    flag: countryFlag(e.venue?.country),
    link: ov.link ?? '',
    hall: ov.hall ?? '',
    booth: ov.booth ?? '',
    igHandle: ov.igHandle ?? '',
    blurb: ov.blurb ?? '',
    past: endD ? endD < today : false,
    ongoing: startD && endD ? startD <= today && today <= endD : false,
    soon: startD ? startD > today && startD.getTime() - today.getTime() <= SOON_DAYS * 86_400_000 : false,
  };
}

export interface SplitEvents {
  upcoming: PublicEvent[];
  past: PublicEvent[];
}

/**
 * Upcoming ascending, past descending and truncated; hidden, deleted and
 * undated events dropped. `today` is injectable so the split is testable.
 */
export function splitPublicEvents(
  events: SalesEvent[],
  overlays: Record<string, Partial<EventOverlay>>,
  pastLimit = 12,
  today: Date = startOfToday(),
): SplitEvents {
  const list = events
    .filter((e) => !e.deletedAt && e.dateStart)
    .map((e) => ({ ev: publicOne(e, overlays[e.id] ?? {}, today), hidden: overlays[e.id]?.hidden === true }))
    .filter((x) => !x.hidden)
    .map((x) => x.ev);

  const upcoming = list.filter((e) => !e.past).sort((a, b) => a.start.localeCompare(b.start));
  const past = list
    .filter((e) => e.past)
    .sort((a, b) => b.start.localeCompare(a.start))
    .slice(0, pastLimit);
  return { upcoming, past };
}

export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// ── iCalendar ───────────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (s: string): string => s.replace(/-/g, '');

/** All-day DTEND is exclusive, so the block ends the day after. */
function ymdPlusDay(s: string): string {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Lines over 75 octets fold onto continuation lines that start with a space. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    out.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  out.push(` ${rest}`);
  return out.join('\r\n');
}

export function buildIcs(
  events: PublicEvent[],
  opts: { calName: string; host: string; now?: Date },
): string {
  const now = opts.now ?? new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Zollify//Public events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(opts.calName)}`,
    'X-PUBLISHED-TTL:PT6H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
  ];
  for (const e of events) {
    const loc = [e.city, e.country].filter(Boolean).join(', ');
    const desc = [e.blurb, e.booth && `Booth: ${e.booth}`, e.link].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${e.id}@${opts.host}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${ymd(e.start)}`);
    lines.push(`DTEND;VALUE=DATE:${ymdPlusDay(e.end)}`);
    lines.push(`SUMMARY:${icsEscape(e.name)}`);
    if (loc) lines.push(`LOCATION:${icsEscape(loc)}`);
    if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    if (e.link) lines.push(`URL:${icsEscape(e.link)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ── Instagram bio ───────────────────────────────────────────────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function ordinal(n: number): string {
  const v = n % 100;
  const suffix = ['th', 'st', 'nd', 'rd'][(v - 20) % 10] ?? ['th', 'st', 'nd', 'rd'][v] ?? 'th';
  return `${n}${suffix}`;
}

/**
 * Instagram-style date range, ordinal on the closing day:
 *   "17th July" · "17-19th July" · "30th July - 2nd August" ·
 *   "30th December 2026 - 2nd January 2027"
 */
export function formatBioDateRange(start: string, end?: string): string {
  const s = toDate(start);
  const e = toDate(end || start);
  if (!s) return '';
  if (!e || s.getTime() === e.getTime()) return `${ordinal(s.getDate())} ${MONTHS[s.getMonth()]}`;
  const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
  if (sameMonth) return `${s.getDate()}-${ordinal(e.getDate())} ${MONTHS[e.getMonth()]}`;
  const sameYear = s.getFullYear() === e.getFullYear();
  const part = (d: Date): string => `${ordinal(d.getDate())} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`;
  return `${part(s)} - ${part(e)}`;
}

const handleAt = (v: string): string => (v ? `@${v.trim().replace(/^@+/, '')}` : '');

/** "@animemesse, hall 3 booth 5823, 17-19th July" */
export function bioEventLine(ev: PublicEvent | null): string {
  if (!ev) return '';
  const who = ev.igHandle ? handleAt(ev.igHandle) : ev.name;
  const loc = [ev.hall && `hall ${ev.hall}`, ev.booth && `booth ${ev.booth}`].filter(Boolean).join(' ');
  const dates = formatBioDateRange(ev.start, ev.end);
  return [who, loc, dates].filter(Boolean).join(', ');
}

export const DEFAULT_BIO_TEMPLATE = 'Artist\n📍 {event}\nShop open 🟢';

/**
 * Instagram has no API to set a bio, so this only composes the text; the app
 * shows it to copy and `/instagram.txt` lets a phone Shortcut fetch it.
 */
export function buildBio(upcoming: PublicEvent[], template: string, fallback: string): string {
  const ev = upcoming[0] ?? null;
  const line = bioEventLine(ev) || fallback;
  const tokens: Record<string, string> = {
    event: line,
    event_name: ev?.name ?? '',
    event_handle: ev ? handleAt(ev.igHandle) : '',
    event_booth: ev?.booth ?? '',
    event_hall: ev?.hall ?? '',
    event_dates: ev ? formatBioDateRange(ev.start, ev.end) : '',
    event_city: ev?.city ?? '',
    event_country: ev?.country ?? '',
  };
  return (template || DEFAULT_BIO_TEMPLATE)
    .replace(/\{(\w+)\}/g, (m, key: string) => (key in tokens ? tokens[key]! : m))
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
