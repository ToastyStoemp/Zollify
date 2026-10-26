import { z } from 'zod';
import { round2 } from './money';
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

/** What a computed expense remembers, so it can be read and recomputed later. */
export type ExpenseDetail =
  | { kind: 'perdiem'; country: string; start: string; end: string; people: number; rate: PerDiemRate; year: number }
  | { kind: 'mileage'; km: number; roundTrip: boolean; trips: number; ratePerKm: number }
  | { kind: 'shared'; groupId: string; method: SplitMethod; total: number; of: number };

export const ExpenseDetailSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('perdiem'), country: z.string().max(2), start: z.string().max(10), end: z.string().max(10), people: z.number().int().min(0).max(100), rate: PerDiemRateSchema, year: z.number().int() }),
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
