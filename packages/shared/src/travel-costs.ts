import { z } from 'zod';
import { round2 } from './money';
import type { SalesEvent } from './types';
import { countryCodeOf } from './vat';

/**
 * Travel costs the ledger works out from an event rather than asks for:
 * per diems (meal allowances) from the event's dates and country, mileage
 * from a distance, and a cost that covers several events split across
 * them. Pure rules and default rate tables, so the app and the server agree
 * and a new year is one more table.
 *
 * The rates are what the tax rules of the business's own country allow as a
 * flat expense; they change by year and by destination, so each account
 * keeps its own copy (started from the defaults below) that an admin can
 * correct under the ledger's Rates. Check them against the current letter:
 * Germany's BMF publishes the Verpflegungspauschalen each autumn, Belgium's
 * per diems and the kilometre rate move with the index.
 */

/** A full day away, and the day of arrival or departure (or a one-day trip of more than 8 hours). */
export interface PerDiemRate {
  full: number;
  reduced: number;
}

export const PerDiemRateSchema = z.object({ full: z.number().finite().min(0).max(1000), reduced: z.number().finite().min(0).max(1000) });

/**
 * Per diems added by themselves when an event closes, so nobody has to
 * remember the button after every show: for the people who always go, with
 * the day before and after as travel days when `travelDays` is on, for
 * events ending on or after `from` (empty: any). An event that already has
 * a per diem, a store, a test event or one without dates gets none.
 */
export const AutoPerDiemSchema = z.object({
  on: z.boolean().default(false),
  people: z.number().int().min(1).max(100).default(1),
  travelDays: z.boolean().default(true),
  from: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).default(''),
});
export type AutoPerDiem = z.infer<typeof AutoPerDiemSchema>;
export const AUTO_PER_DIEM_OFF: AutoPerDiem = { on: false, people: 1, travelDays: true, from: '' };

export const TravelRatesSchema = z.object({
  /** Which country's rules: the business's own. */
  homeCountry: z.string().trim().toUpperCase().length(2).default('DE'),
  currency: z.string().trim().toUpperCase().length(3).default('EUR'),
  /** The year the table is from, for the note on the expense. */
  year: z.number().int().min(2020).max(2100).default(2025),
  domestic: PerDiemRateSchema.default({ full: 28, reduced: 14 }),
  /** By destination country code; a country not listed gets `fallback`. */
  abroad: z.record(z.string(), PerDiemRateSchema).default({}),
  /** For a destination not in the table. Germany's own rule: Luxembourg's rate. */
  fallback: PerDiemRateSchema.default({ full: 63, reduced: 42 }),
  /** Per kilometre, by car. */
  mileagePerKm: z.number().finite().min(0).max(10).default(0.3),
  auto: AutoPerDiemSchema.default({ ...AUTO_PER_DIEM_OFF }),
});
export type TravelRates = z.infer<typeof TravelRatesSchema>;

/**
 * Defaults per home country. Germany: BMF letter for 2025 (domestic rates
 * unchanged since 2024), the destinations a booth most often drives to.
 * Belgium: the domestic daily allowance and the country list for short
 * missions, with the departure and return days at half, and the
 * kilometre rate for 2025. Check both against the current letters.
 */
export const TRAVEL_RATE_DEFAULTS: Record<string, TravelRates> = {
  DE: {
    homeCountry: 'DE',
    currency: 'EUR',
    year: 2025,
    domestic: { full: 28, reduced: 14 },
    abroad: {
      AT: { full: 50, reduced: 33 },
      BE: { full: 59, reduced: 40 },
      CH: { full: 64, reduced: 43 },
      CZ: { full: 32, reduced: 21 },
      DK: { full: 75, reduced: 50 },
      ES: { full: 34, reduced: 23 },
      FI: { full: 54, reduced: 36 },
      FR: { full: 53, reduced: 36 },
      GB: { full: 52, reduced: 35 },
      HU: { full: 32, reduced: 21 },
      IE: { full: 58, reduced: 39 },
      IT: { full: 42, reduced: 28 },
      LU: { full: 63, reduced: 42 },
      NL: { full: 47, reduced: 32 },
      NO: { full: 75, reduced: 50 },
      PL: { full: 34, reduced: 23 },
      PT: { full: 32, reduced: 21 },
      SE: { full: 66, reduced: 44 },
      US: { full: 59, reduced: 40 },
    },
    fallback: { full: 63, reduced: 42 },
    mileagePerKm: 0.3,
    auto: { ...AUTO_PER_DIEM_OFF },
  },
  BE: {
    homeCountry: 'BE',
    currency: 'EUR',
    year: 2025,
    domestic: { full: 20.8, reduced: 20.8 },
    abroad: {
      AT: { full: 109, reduced: 54.5 },
      CH: { full: 107, reduced: 53.5 },
      CZ: { full: 80, reduced: 40 },
      DE: { full: 97, reduced: 48.5 },
      DK: { full: 103, reduced: 51.5 },
      ES: { full: 87, reduced: 43.5 },
      FR: { full: 102, reduced: 51 },
      GB: { full: 119, reduced: 59.5 },
      IT: { full: 95, reduced: 47.5 },
      LU: { full: 92, reduced: 46 },
      NL: { full: 104, reduced: 52 },
      NO: { full: 99, reduced: 49.5 },
      PL: { full: 68, reduced: 34 },
      SE: { full: 97, reduced: 48.5 },
    },
    fallback: { full: 80, reduced: 40 },
    mileagePerKm: 0.4316,
    auto: { ...AUTO_PER_DIEM_OFF },
  },
};

/** The account's starting table for its home country; Germany's shape with no destinations elsewhere. */
export function defaultTravelRates(homeCountry: string): TravelRates {
  const code = countryCodeOf(homeCountry) || homeCountry.toUpperCase();
  const base = TRAVEL_RATE_DEFAULTS[code];
  if (base) return structuredClone(base);
  return TravelRatesSchema.parse({ homeCountry: code.length === 2 ? code : 'DE' });
}

/** The rate for a destination: the home country's own, a listed country's, or the fallback. */
export function perDiemRateFor(rates: TravelRates, destinationCountry: string): { rate: PerDiemRate; where: 'domestic' | 'listed' | 'fallback' } {
  const code = countryCodeOf(destinationCountry) || destinationCountry.trim().toUpperCase();
  if (!code || code === rates.homeCountry) return { rate: rates.domestic, where: 'domestic' };
  const listed = rates.abroad[code];
  return listed ? { rate: listed, where: 'listed' } : { rate: rates.fallback, where: 'fallback' };
}

const DAY = 86_400_000;
const daysInclusive = (start: string, end: string): number => Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / DAY) + 1;
const shiftDay = (day: string, by: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + by * DAY).toISOString().slice(0, 10);

export interface PerDiemInput {
  /** The trip, both days included - by default the event's dates, a day either side for travel. */
  start: string;
  end: string;
  people: number;
  rate: PerDiemRate;
}

export interface PerDiemResult {
  days: number;
  /** Days paid at the full rate: those between arrival and departure. */
  fullDays: number;
  /** Days paid at the reduced rate: arrival and departure (a one-day trip is one such day). */
  reducedDays: number;
  perPerson: number;
  amount: number;
}

/**
 * Meal allowances for a trip: the day of arrival and the day of departure at
 * the reduced rate, every day in between at the full rate; a one-day trip
 * (over 8 hours away) at the reduced rate once. Times the people who went.
 */
export function perDiem(input: PerDiemInput): PerDiemResult | null {
  if (!input.start || !input.end || input.end < input.start) return null;
  const days = daysInclusive(input.start, input.end);
  const people = Math.max(0, Math.floor(input.people));
  const reducedDays = days === 1 ? 1 : 2;
  const fullDays = Math.max(0, days - 2);
  const perPerson = round2(fullDays * input.rate.full + reducedDays * input.rate.reduced);
  return { days, fullDays, reducedDays, perPerson, amount: round2(perPerson * people) };
}

export interface MileageInput {
  /** One way. */
  km: number;
  roundTrip: boolean;
  /** How many times the trip was made (two cars, a second run for stock). */
  trips: number;
  ratePerKm: number;
}

export function mileage(input: MileageInput): { km: number; amount: number } {
  const km = round2(Math.max(0, input.km) * (input.roundTrip ? 2 : 1) * Math.max(0, Math.floor(input.trips)));
  return { km, amount: round2(km * Math.max(0, input.ratePerKm)) };
}

export type SplitMethod = 'days' | 'even';

/**
 * A cost that covers several events (a year's insurance, a van for two
 * conventions) split across them: by the days each one runs, or evenly.
 * Whole cents, the remainder on the last. An event without dates gets one
 * day's share when splitting by days.
 */
export function splitShared(amount: number, events: { id: string; days: number }[], method: SplitMethod): { id: string; amount: number }[] {
  if (!events.length) return [];
  const weights = events.map((e) => (method === 'days' ? Math.max(1, e.days) : 1));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const minor = Math.round(amount * 100);
  let given = 0;
  return events.map((e, i) => {
    const share = i === events.length - 1 ? minor - given : Math.round((minor * weights[i]!) / totalWeight);
    given += share;
    return { id: e.id, amount: share / 100 };
  });
}

/** What a computed expense remembers, so it can be read and recomputed later. `auto` marks a per diem the account added by itself. */
export type ExpenseDetail =
  | { kind: 'perdiem'; country: string; start: string; end: string; people: number; rate: PerDiemRate; year: number; auto?: boolean }
  | { kind: 'mileage'; km: number; roundTrip: boolean; trips: number; ratePerKm: number }
  | { kind: 'shared'; groupId: string; method: SplitMethod; total: number; of: number };

export const ExpenseDetailSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('perdiem'), country: z.string().max(2), start: z.string().max(10), end: z.string().max(10), people: z.number().int().min(0).max(100), rate: PerDiemRateSchema, year: z.number().int(), auto: z.boolean().optional() }),
  z.object({ kind: z.literal('mileage'), km: z.number().finite().min(0), roundTrip: z.boolean(), trips: z.number().int().min(0).max(100), ratePerKm: z.number().finite().min(0) }),
  z.object({ kind: z.literal('shared'), groupId: z.string().max(64), method: z.enum(['days', 'even']), total: z.number().finite().min(0), of: z.number().int().min(1).max(500) }),
]);

/** The one-line note a computed expense carries, so the ledger and the books read how the figure came about. */
export function describeDetail(d: ExpenseDetail, currency: string): string {
  const money = (n: number) => `${n.toFixed(2)} ${currency}`;
  switch (d.kind) {
    case 'perdiem': {
      const r = perDiem({ start: d.start, end: d.end, people: d.people, rate: d.rate });
      if (!r) return 'Per diems';
      return `Per diems ${d.start} to ${d.end} (${d.country || 'home'}, ${d.year} rates): ${r.fullDays} × ${money(d.rate.full)} + ${r.reducedDays} × ${money(d.rate.reduced)}, ${d.people} ${d.people === 1 ? 'person' : 'people'}`;
    }
    case 'mileage':
      return `Mileage: ${d.km} km${d.roundTrip ? ' there and back' : ''}${d.trips !== 1 ? ` × ${d.trips}` : ''} at ${d.ratePerKm.toFixed(2)} ${currency}/km`;
    case 'shared':
      return `Share of ${money(d.total)} split ${d.method === 'days' ? 'by days' : 'evenly'} over ${d.of} events`;
  }
}

/** What the automatic per diems need to know of an event. */
export type PerDiemEvent = Pick<SalesEvent, 'id' | 'kind' | 'status' | 'dateStart' | 'dateEnd' | 'venue' | 'currency' | 'test' | 'deletedAt'>;

/** A per diem expense an event is due, ready to store. */
export interface DuePerDiem {
  eventId: string;
  currency: string;
  /** The first day of the trip. */
  date: string;
  amount: number;
  detail: Extract<ExpenseDetail, { kind: 'perdiem' }>;
  note: string;
}

/**
 * The per diems to add by themselves: one per closed event (not a store,
 * not the test event) with dates, ending on or after the setting's `from`,
 * that is not in `done` - the events that have a per diem already or had
 * their automatic one once (deleting it is a decision, not a gap). The trip
 * is the event's dates with a travel day either side when the setting says,
 * at the rate for the venue's country, for the people set. Pure; the
 * caller stores them.
 */
export function perDiemsDue(events: Iterable<PerDiemEvent>, done: ReadonlySet<string>, rates: TravelRates): DuePerDiem[] {
  const auto = rates.auto ?? AUTO_PER_DIEM_OFF;
  if (!auto.on) return [];
  const out: DuePerDiem[] = [];
  for (const e of events) {
    if (e.deletedAt || e.test || e.kind === 'store' || e.status !== 'closed' || done.has(e.id)) continue;
    const first = e.dateStart || e.dateEnd;
    const last = e.dateEnd || e.dateStart;
    if (!first || !last || last < first) continue;
    if (auto.from && last < auto.from) continue;
    const start = auto.travelDays ? shiftDay(first, -1) : first;
    const end = auto.travelDays ? shiftDay(last, 1) : last;
    const country = e.venue?.country ?? '';
    const { rate } = perDiemRateFor(rates, country);
    const r = perDiem({ start, end, people: auto.people, rate });
    if (!r || !(r.amount > 0)) continue;
    const code = countryCodeOf(country) || country.trim().slice(0, 2).toUpperCase();
    const detail: DuePerDiem['detail'] = { kind: 'perdiem', country: code, start, end, people: auto.people, rate: { ...rate }, year: rates.year, auto: true };
    out.push({ eventId: e.id, currency: e.currency || rates.currency, date: start, amount: r.amount, detail, note: describeDetail(detail, e.currency || rates.currency) });
  }
  return out;
}

/** The least an expense must carry to be matched against the per diems on its event. */
export interface CoverableExpense {
  eventId: string;
  category: string;
  /** YYYY-MM-DD; an expense without a date is never covered. */
  date: string;
  detail?: ExpenseDetail | null;
}

/**
 * Food bought on a day a per diem on the same event covers. It stays in the
 * event's profit - the money went - but for income tax the flat rate already
 * stands for the traveller's meals (Germany: §4 Abs. 5 Nr. 5 EStG), so the
 * accountant leaves these out, or cuts the per diem by the meal when the
 * business fed a helper. The same objects back, so the caller can mark them.
 */
export function coveredByPerDiem<T extends CoverableExpense>(expenses: readonly T[]): T[] {
  const ranges = new Map<string, { start: string; end: string }[]>();
  for (const e of expenses) {
    if (e.detail?.kind !== 'perdiem' || !e.eventId || !e.detail.start || !e.detail.end) continue;
    const list = ranges.get(e.eventId) ?? [];
    list.push({ start: e.detail.start, end: e.detail.end });
    ranges.set(e.eventId, list);
  }
  return expenses.filter((e) => e.category === 'food' && e.date && (ranges.get(e.eventId) ?? []).some((r) => e.date >= r.start && e.date <= r.end));
}
