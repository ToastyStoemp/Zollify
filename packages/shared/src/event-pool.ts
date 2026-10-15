import { z } from 'zod';

/**
 * The shared event pool: public listings that accounts contribute to and
 * quick-add from. Only the facts below ever cross accounts. The server reads
 * every one of them from the contributor's own events (never from a request)
 * once the account has agreed to share.
 */

/** Longest a listing may run; keeps a typo from publishing a year-long "event". */
export const POOL_MAX_DAYS = 60;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  const year = Number(s.slice(0, 4));
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && year >= 2000 && year <= 2100;
}

/** https only, no credentials, no whitespace. Returns the cleaned URL or ''. */
export function httpsUrl(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s || s.length > 500 || /\s/.test(s)) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return '';
    return u.toString();
  } catch {
    return '';
  }
}

/** Collapses whitespace and drops control characters. */
export function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Free text: plain only, so markup is refused rather than half-stripped. */
const text = (max: number) =>
  z
    .string()
    .transform(cleanText)
    .pipe(z.string().max(max, `Keep it under ${max} characters.`))
    .refine((v) => !/[<>]/.test(v), 'No markup or angle brackets, please.');

/** The account-level consent, as the settings endpoint takes it. */
export const PoolSettingsSchema = z.object({ share: z.boolean() });
export type PoolSettings = z.infer<typeof PoolSettingsSchema>;

export const PoolReportSchema = z.object({
  reason: z.enum(['spam', 'wrong', 'offensive', 'other']),
  note: text(300).default(''),
});

/**
 * The facts of one listing, as every account sees them. Public event facts
 * only: nothing here says who shares, adopted or goes to the event, so there
 * is no contributor count, no names and no timestamps that move when another
 * account joins.
 */
export interface PoolListing {
  id: string;
  name: string;
  edition: string;
  venueName: string;
  street: string;
  postcode: string;
  city: string;
  country: string;
  dateStart: string;
  dateEnd: string;
  url: string;
  description: string;
  /** The caller already quick-added it. */
  added: boolean;
}

/** Same name, same start, same city is the same event; case, accents and punctuation do not matter. */
export function poolKey(name: string, dateStart: string, city: string): string {
  const norm = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return `${norm(name)}|${dateStart}|${norm(city)}`;
}
