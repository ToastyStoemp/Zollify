import type { SmeReport } from './sme-report';
import { COUNTRY_BY_CODE } from './countries';
import { EU_COUNTRIES, type VatProfile } from './vat';

/**
 * Small-business VAT exemption thresholds, and the warnings for a business
 * getting close to one or past it.
 *
 * Each EU country sets its own annual threshold (at most EUR 85,000), and a
 * business using the exemption in other EU countries under the SME scheme
 * also has to stay under EUR 100,000 across the whole EU. Both are measured
 * over the current and the previous calendar year. Past a national
 * threshold the exemption ends in that country - usually from the sale that
 * crosses it, though some countries let it run to the end of the year
 * within a margin. Past the EU-wide one, the exemption ends in every other
 * country (home keeps its own, if still under the home threshold).
 *
 * The figures move every year and are the business's own responsibility:
 * they are defaults, overridable per country in Settings → VAT, and every
 * warning links to the country's page on the Commission's SME site.
 *
 * Sources (October 2026): the Commission's per-country pages for Austria,
 * Germany, Denmark and Italy (`checked`), and published 2026 overviews for
 * the rest - see https://sme-vat-rules.ec.europa.eu/national-vat-rules_en.
 */

export interface SmeThreshold {
  /** The annual threshold, in `currency`. */
  amount: number;
  currency: string;
  /**
   * Some countries keep the exemption until the end of the year when this
   * year's turnover passes the threshold by no more than this percentage.
   */
  tolerancePct?: number;
  /**
   * A higher in-year ceiling: past `amount` the exemption runs to the end of
   * the year, past this it ends at once (Germany: EUR 25,000 last year,
   * EUR 100,000 this year).
   */
  inYearCap?: number;
  /** Only this year counts (Austria, Denmark), not last year as well. */
  currentYearOnly?: boolean;
  /** Confirmed against the Commission's own page for the country. */
  checked?: boolean;
  /** One line worth knowing, shown with the warning. */
  note?: string;
}

/** EUR 100,000: total EU turnover for using the exemption in other EU countries. */
export const UNION_THRESHOLD = { amount: 100_000, currency: 'EUR' } as const;

/** Countries with no small-business exemption at all: an exemption there is a mistake. */
export const NO_SME_EXEMPTION = ['ES'];

/** Warn from this share of the threshold. */
export const NEAR_SHARE = 0.8;

export const SME_THRESHOLDS: Record<string, SmeThreshold> = {
  AT: { amount: 55_000, currency: 'EUR', tolerancePct: 10, currentYearOnly: true, checked: true },
  BE: { amount: 25_000, currency: 'EUR' },
  BG: { amount: 51_130, currency: 'EUR' },
  HR: { amount: 60_000, currency: 'EUR' },
  CY: { amount: 15_600, currency: 'EUR' },
  CZ: { amount: 2_000_000, currency: 'CZK', inYearCap: 2_536_500 },
  DK: {
    amount: 50_000,
    currency: 'DKK',
    currentYearOnly: true,
    checked: true,
    note: 'An artist selling their own original works of art for the first time has a separate DKK 350,000 threshold.',
  },
  EE: { amount: 40_000, currency: 'EUR' },
  FI: { amount: 20_000, currency: 'EUR' },
  FR: { amount: 85_000, currency: 'EUR', inYearCap: 93_500, note: 'For sales of goods; services have a lower threshold.' },
  DE: { amount: 25_000, currency: 'EUR', inYearCap: 100_000, checked: true, note: 'Last year must stay under EUR 25,000; this year under EUR 100,000.' },
  GR: { amount: 10_000, currency: 'EUR' },
  HU: { amount: 18_000_000, currency: 'HUF' },
  IE: { amount: 85_000, currency: 'EUR', note: 'For sales of goods; services have a lower threshold.' },
  IT: { amount: 85_000, currency: 'EUR', inYearCap: 100_000, checked: true },
  LV: { amount: 50_000, currency: 'EUR' },
  LT: { amount: 45_000, currency: 'EUR' },
  LU: { amount: 50_000, currency: 'EUR' },
  MT: { amount: 35_000, currency: 'EUR' },
  NL: { amount: 20_000, currency: 'EUR' },
  PL: { amount: 240_000, currency: 'PLN' },
  PT: { amount: 15_000, currency: 'EUR', tolerancePct: 25 },
  RO: { amount: 395_000, currency: 'RON' },
  SK: { amount: 50_000, currency: 'EUR', inYearCap: 62_500 },
  SI: { amount: 60_000, currency: 'EUR' },
  SE: { amount: 120_000, currency: 'SEK' },
};

const SLUGS: Record<string, string> = {
  AT: 'austria', BE: 'belgium', HR: 'croatia', CY: 'cyprus', CZ: 'czechia', DK: 'denmark', EE: 'estonia', FI: 'finland',
  DE: 'germany', GR: 'greece', HU: 'hungary', IE: 'ireland', IT: 'italy', LV: 'latvia', LT: 'lithuania', LU: 'luxembourg',
  MT: 'malta', NL: 'netherlands', PL: 'poland', PT: 'portugal', RO: 'romania', SK: 'slovakia', SI: 'slovenia', SE: 'sweden',
};

/** The Commission's page on a country's SME rules, or its overview when it has none. */
export function smeRulesUrl(country: string): string {
  const slug = SLUGS[country];
  return slug
    ? `https://sme-vat-rules.ec.europa.eu/national-vat-rules/${slug}-sme-rules_en`
    : 'https://sme-vat-rules.ec.europa.eu/national-vat-rules_en';
}

/** A country's threshold: the business's own figure when it set one (in the default's currency), else the default. */
export function thresholdFor(country: string, overrides?: Record<string, number> | null): SmeThreshold | null {
  const base = SME_THRESHOLDS[country];
  if (!base) return null;
  const own = overrides?.[country];
  if (typeof own !== 'number' || !Number.isFinite(own) || own <= 0) return base;
  // An own figure replaces the threshold; an in-year cap set relative to the default moves with it.
  const cap = base.inYearCap ? Math.round((base.inYearCap / base.amount) * own) : undefined;
  return { ...base, amount: own, ...(cap ? { inYearCap: cap } : {}), checked: false };
}

export type ThresholdLevel = 'over' | 'over-year-end' | 'last-year' | 'near' | 'no-scheme';

export interface ThresholdWarning {
  /** ISO code, or 'EU' for the EU-wide threshold. */
  country: string;
  level: ThresholdLevel;
  /** This year's turnover there (last year's, for `last-year`), in `currency`. */
  used: number;
  limit: number;
  currency: string;
  /** used / limit, 0..; 0 for `no-scheme`. */
  share: number;
  title: string;
  text: string;
  /** Where to check the rules. */
  source: string;
  /** The default figure was not confirmed against the Commission's page. */
  unverified: boolean;
}

/** 1 `from` = rate `to`; null when not known (offline, never fetched). */
export type RateLookup = (from: string, to: string) => number | null;

/**
 * The currency pairs the warnings need a rate for: each book currency the
 * sales were in, to each threshold's currency.
 */
export function thresholdRatePairs(reports: SmeReport[], profile: { vat?: Partial<VatProfile> } | null | undefined): [string, string][] {
  const books = new Set(reports.flatMap((r) => r.rows.map((row) => row.currency)));
  const targets = new Set<string>([UNION_THRESHOLD.currency]);
  for (const c of profile?.vat?.exemptCountries ?? []) {
    const t = SME_THRESHOLDS[c];
    if (t) targets.add(t.currency);
  }
  const out: [string, string][] = [];
  for (const from of books) for (const to of targets) if (from !== to) out.push([from, to]);
  return out;
}

/**
 * What was reported in a country (or across the EU) in one year, in
 * `currency`: exempt sales in full, charged sales without VAT - the same
 * figure the SME report files. Null when a rate it needs is missing.
 */
function sumIn(report: SmeReport, currency: string, rate: RateLookup, where: (country: string, eu: boolean) => boolean): number | null {
  let total = 0;
  for (const row of report.rows) {
    if (!where(row.country, row.eu)) continue;
    if (row.currency === currency) {
      total += row.reported;
      continue;
    }
    const r = rate(row.currency, currency);
    if (r == null) return null;
    total += row.reported * r;
  }
  return Math.round(total * 100) / 100;
}

const money = (n: number, cur: string): string =>
  `${cur} ${Math.round(n).toLocaleString('en-GB')}`;
const pct = (share: number): string => `${Math.floor(share * 100)}%`;
const nameOf = (code: string): string => COUNTRY_BY_CODE[code] ?? code;

/**
 * Warnings for every country the business is exempt in, and for the EU-wide
 * threshold when it uses the exemption abroad. Most serious first. A country
 * whose figure needs a rate that is not known is left out rather than
 * guessed.
 */
export function thresholdWarnings(args: {
  thisYear: SmeReport;
  lastYear: SmeReport;
  profile: { vat?: Partial<VatProfile> & { thresholds?: Record<string, number> } } | null | undefined;
  /** The business's home country, ISO. */
  home: string;
  rate: RateLookup;
}): ThresholdWarning[] {
  const { thisYear, lastYear, profile, home, rate } = args;
  const vat = profile?.vat;
  const exempt = vat?.exemptCountries ?? [];
  const out: ThresholdWarning[] = [];

  for (const country of exempt) {
    if (NO_SME_EXEMPTION.includes(country)) {
      out.push({
        country,
        level: 'no-scheme',
        used: 0,
        limit: 0,
        currency: 'EUR',
        share: 0,
        title: `${nameOf(country)} has no small-business exemption`,
        text: `Sales there should charge ${nameOf(country)}'s VAT. Untick it under Settings → VAT, exempt countries.`,
        source: smeRulesUrl(country),
        unverified: false,
      });
      continue;
    }
    const t = thresholdFor(country, vat?.thresholds);
    if (!t) continue;
    const here = (c: string) => c === country;
    const now = sumIn(thisYear, t.currency, rate, here);
    const before = sumIn(lastYear, t.currency, rate, here);
    const base = { country, limit: t.amount, currency: t.currency, source: smeRulesUrl(country), unverified: !t.checked };
    const name = nameOf(country);
    const note = t.note ? ` ${t.note}` : '';

    if (now != null && now > t.amount) {
      const share = now / t.amount;
      const tolerated = t.tolerancePct != null && now <= t.amount * (1 + t.tolerancePct / 100);
      const capped = t.inYearCap != null && now <= t.inYearCap;
      if (tolerated || capped) {
        const until = capped ? money(t.inYearCap!, t.currency) : `${t.tolerancePct}% over (${money(t.amount * (1 + t.tolerancePct! / 100), t.currency)})`;
        out.push({
          ...base, level: 'over-year-end', used: now, share,
          title: `${name}: over the threshold this year`,
          text: `${money(now, t.currency)} of ${money(t.amount, t.currency)}. ${name} lets the exemption run to the end of the year up to ${until}; from 1 January you charge VAT there.${note}`,
        });
      } else {
        out.push({
          ...base, level: 'over', used: now, share,
          title: `${name}: over the threshold`,
          text: `${money(now, t.currency)} this year, past ${money(t.inYearCap ?? t.amount, t.currency)}. The exemption there ends with the sale that crossed it: charge ${name}'s VAT from now on, and untick ${name} under Settings → VAT.${note}`,
        });
      }
      continue;
    }
    if (!t.currentYearOnly && before != null && before > t.amount) {
      out.push({
        ...base, level: 'last-year', used: before, share: before / t.amount,
        title: `${name}: over the threshold last year`,
        text: `${money(before, t.currency)} last year, past ${money(t.amount, t.currency)}. The exemption needs both last year and this year under it, so it does not apply in ${name} this year.${note}`,
      });
      continue;
    }
    if (now != null && now >= t.amount * NEAR_SHARE) {
      out.push({
        ...base, level: 'near', used: now, share: now / t.amount,
        title: `${name}: ${pct(now / t.amount)} of the threshold`,
        text: `${money(now, t.currency)} of ${money(t.amount, t.currency)} this year - ${money(t.amount - now, t.currency)} to go.${note}`,
      });
    }
  }

  // EU-wide: only for a business using the exemption outside its home country.
  const abroad = exempt.some((c) => c !== home && EU_COUNTRIES.includes(c)) || Boolean(vat?.exNumber?.trim());
  if (abroad) {
    const { amount, currency } = UNION_THRESHOLD;
    const eu = (_c: string, isEu: boolean) => isEu;
    const now = sumIn(thisYear, currency, rate, eu);
    const before = sumIn(lastYear, currency, rate, eu);
    const base = { country: 'EU', limit: amount, currency, source: 'https://sme-vat-rules.ec.europa.eu/sme-scheme/cross-border-sme-scheme_en', unverified: false };
    if ((now ?? 0) > amount || (before ?? 0) > amount) {
      const used = Math.max(now ?? 0, before ?? 0);
      out.push({
        ...base, level: 'over', used, share: used / amount,
        title: 'Over EUR 100,000 across the EU',
        text: `${money(used, currency)} in EU sales ${(now ?? 0) > amount ? 'this year' : 'last year'}. The exemption in other EU countries ends and your EX number is switched off; at home it stays only while you are under the home threshold.`,
      });
    } else if (now != null && now >= amount * NEAR_SHARE) {
      out.push({
        ...base, level: 'near', used: now, share: now / amount,
        title: `${pct(now / amount)} of the EU-wide EUR 100,000`,
        text: `${money(now, currency)} in EU sales this year. Past EUR 100,000 the exemption in other EU countries ends.`,
      });
    }
  }

  const rank: Record<ThresholdLevel, number> = { over: 0, 'no-scheme': 1, 'last-year': 2, 'over-year-end': 3, near: 4 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || b.share - a.share);
}
