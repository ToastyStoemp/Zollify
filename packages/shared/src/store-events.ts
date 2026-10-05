import { z } from 'zod';

/**
 * A store's programme: what happens in the shop besides selling.
 *
 * - A **feature** puts an artist in the spotlight at one or more stores for
 *   a stretch of dates - "artist of the month" - optionally with a discount
 *   on their work, which the till applies by itself inside those dates.
 * - A **workshop** is a session people sign up for on a public page, with a
 *   capacity and a waitlist.
 *
 * The rules that decide who gets a seat live here, pure, so the server can
 * apply them inside one transaction and the tests can pin them.
 */

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const FeatureInputSchema = z
  .object({
    consignorId: z.string().min(1).max(80),
    storeIds: z.array(z.string().min(1).max(80)).min(1).max(50),
    /** Shown on the public page; blank = "Artist of the month". */
    title: z.string().trim().max(120).default(''),
    description: z.string().max(2000).default(''),
    startDate: IsoDate,
    /** Inclusive. */
    endDate: IsoDate,
    /** Percent off the artist's items at the till during the feature; 0 = none. */
    discountPct: z.number().min(0).max(90).default(0),
    published: z.boolean().default(true),
  })
  .refine((f) => f.endDate >= f.startDate, { message: 'The feature ends before it starts.', path: ['endDate'] });
export type FeatureInput = z.infer<typeof FeatureInputSchema>;
export interface StoreFeature extends FeatureInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** The discount rule a feature drives is found by this id - one rule per feature, never orphaned or doubled. */
export const featureRuleId = (featureId: string): string => `feature-${featureId}`;

export const WorkshopInputSchema = z.object({
  storeId: z.string().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(''),
  date: IsoDate,
  /** Store-local wall-clock time, HH:MM. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMin: z.number().int().min(10).max(24 * 60).default(120),
  /** Seats. */
  capacity: z.number().int().min(1).max(1000),
  /** Per seat; 0 = free. Paid at the store - Zollify never takes the money. */
  price: z.number().min(0).max(100_000).default(0),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  /** An artist running it, who is told and sees it on their side. */
  hostConsignorId: z.string().min(1).max(80).nullable().default(null),
  /**
   * The host's share of each place sold at the till, in percent; the store
   * keeps the rest. 0 = all the store's. Shows on the host's statement.
   */
  hostSharePct: z.number().min(0).max(100).default(0),
  /** Listed on the public page. */
  published: z.boolean().default(true),
  /** Taking sign-ups right now. */
  signupsOpen: z.boolean().default(true),
  /** When full, people can join a waitlist and move up when someone cancels. */
  waitlist: z.boolean().default(true),
});
export type WorkshopInput = z.infer<typeof WorkshopInputSchema>;
export interface Workshop extends WorkshopInput {
  id: string;
  /** Called off: shown as cancelled, everyone signed up was told. */
  cancelledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type SignupStatus = 'booked' | 'waitlist' | 'cancelled';
export interface Signup {
  id: string;
  workshopId: string;
  name: string;
  email: string;
  seats: number;
  note: string;
  status: SignupStatus;
  paid: boolean;
  /** 'public' = the sign-up page; 'store' = added by the store. */
  source: 'public' | 'store';
  /** Paid through the till: a recorded, not reverted, sale settles this sign-up. Derived, never stored. */
  paidAtTill?: boolean;
  createdAt: number;
  cancelledAt: number | null;
}

/** What someone fills in on the sign-up page. `website` is a honeypot: people never see it, bots fill it. */
export const SignupInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  seats: z.number().int().min(1).max(10).default(1),
  note: z.string().trim().max(500).default(''),
  website: z.string().max(200).optional(),
});
export type SignupInput = z.infer<typeof SignupInputSchema>;

/** Seats held by booked sign-ups. */
export const seatsTaken = (signups: Pick<Signup, 'status' | 'seats'>[]): number =>
  signups.reduce((n, s) => (s.status === 'booked' ? n + s.seats : n), 0);

export const seatsWaiting = (signups: Pick<Signup, 'status' | 'seats'>[]): number =>
  signups.reduce((n, s) => (s.status === 'waitlist' ? n + s.seats : n), 0);

/**
 * Where a new sign-up lands. Nobody jumps the queue: while anyone is waiting,
 * a newcomer waits too, even if their party would fit in a gap.
 */
export function placeSignup(
  workshop: Pick<Workshop, 'capacity' | 'waitlist'>,
  signups: Pick<Signup, 'status' | 'seats'>[],
  seats: number,
): 'booked' | 'waitlist' | 'full' {
  const free = workshop.capacity - seatsTaken(signups);
  if (seats <= free && seatsWaiting(signups) === 0) return 'booked';
  if (!workshop.waitlist || seats > workshop.capacity) return 'full';
  return 'waitlist';
}

/**
 * Who moves up from the waitlist after seats free up: first come, first
 * served, a whole party at a time. A party too big for the gap waits, and so
 * does everyone behind it - otherwise a big group would never get in.
 */
export function promoteFromWaitlist(
  workshop: Pick<Workshop, 'capacity'>,
  signups: Pick<Signup, 'id' | 'status' | 'seats' | 'createdAt'>[],
): string[] {
  let free = workshop.capacity - seatsTaken(signups);
  const out: string[] = [];
  for (const s of signups.filter((x) => x.status === 'waitlist').sort((a, b) => a.createdAt - b.createdAt)) {
    if (s.seats > free) break;
    free -= s.seats;
    out.push(s.id);
  }
  return out;
}

/** What a till sale line for a sign-up refers to (TxItem.ref.kind). */
export const SIGNUP_REF_KIND = 'workshop-signup';

/** The split a workshop place sold at the till carries: who shares it, and what the store keeps. */
export function workshopLineSplit(w: Pick<Workshop, 'hostConsignorId' | 'hostSharePct'>): { consignorId?: string; commissionPct?: number } {
  return w.hostConsignorId && w.hostSharePct > 0 ? { consignorId: w.hostConsignorId, commissionPct: 100 - w.hostSharePct } : {};
}

/** Whether a feature is running on a day. */
export const featureOn = (f: Pick<StoreFeature, 'startDate' | 'endDate'>, day: string): boolean => f.startDate <= day && day <= f.endDate;

// ── The public page ─────────────────────────────────────────────────────────

/** What the sign-up page shows - picked field by field, never a stored record. */
export interface PublicProgramme {
  name: string;
  features: { id: string; artist: string; title: string; description: string; startDate: string; endDate: string; discountPct: number; stores: string[] }[];
  workshops: {
    id: string;
    title: string;
    description: string;
    date: string;
    time: string;
    durationMin: number;
    store: string;
    address: string;
    host: string | null;
    price: number;
    currency: string;
    seatsLeft: number;
    /** 'open' | 'waitlist' (full, join the list) | 'full' | 'closed' (sign-ups closed) */
    availability: 'open' | 'waitlist' | 'full' | 'closed';
  }[];
}
