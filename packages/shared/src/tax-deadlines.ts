import { z } from 'zod';

/**
 * Tax deadlines: when to file and pay, worked out from how the business is
 * set up rather than fetched. No tax office publishes deadlines as data, but
 * the rules are fixed in law, so a profile (country, VAT status, filing
 * frequency, extension…) is enough to list every date ahead.
 *
 * Countries come as rule sets. Germany is complete; every EU country gets the
 * cross-border SME scheme report; anything else is covered by the business's
 * own custom deadlines. Adding a country is one more `RuleSet`.
 *
 * Dates are plain calendar days (YYYY-MM-DD). A deadline that falls on a
 * weekend or holiday moves to the next working day where the country's law
 * says so (Germany: §108 Abs. 3 AO). For a country whose rules are not known
 * here nothing is moved: reminding a day early is the safe mistake.
 *
 * Not tax advice - the business should check its own dates with the tax
 * office or a tax advisor.
 */

// ── Profile and settings ────────────────────────────────────────────────────

export const GERMAN_STATES: { code: string; name: string }[] = [
  { code: 'BW', name: 'Baden-Württemberg' },
  { code: 'BY', name: 'Bayern' },
  { code: 'BE', name: 'Berlin' },
  { code: 'BB', name: 'Brandenburg' },
  { code: 'HB', name: 'Bremen' },
  { code: 'HH', name: 'Hamburg' },
  { code: 'HE', name: 'Hessen' },
  { code: 'MV', name: 'Mecklenburg-Vorpommern' },
  { code: 'NI', name: 'Niedersachsen' },
  { code: 'NW', name: 'Nordrhein-Westfalen' },
  { code: 'RP', name: 'Rheinland-Pfalz' },
  { code: 'SL', name: 'Saarland' },
  { code: 'SN', name: 'Sachsen' },
  { code: 'ST', name: 'Sachsen-Anhalt' },
  { code: 'SH', name: 'Schleswig-Holstein' },
  { code: 'TH', name: 'Thüringen' },
];

const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const TaxDeadlineProfileSchema = z.object({
  /** Where the business is established (ISO code). Picks the rule set. */
  country: z.string().regex(/^[A-Z]{2}$/).default('DE'),
  /** Region for regional holidays - a German state code. Empty: national holidays only. */
  region: z.string().max(4).default(''),
  /** Sole trader / freelancer, or a company (GmbH, UG…): decides income or corporate tax. */
  legalForm: z.enum(['sole', 'company']).default('sole'),
  /** `regular`: charges VAT. `small-business`: exempt at home (Kleinunternehmer, §19 UStG). `none`: no VAT at all. */
  vat: z.enum(['regular', 'small-business', 'none']).default('regular'),
  /** How often the VAT return is filed. `yearly`: only the annual return. */
  vatFrequency: z.enum(['monthly', 'quarterly', 'yearly']).default('quarterly'),
  /** Germany: Dauerfristverlängerung, one month more for each VAT return. */
  extension: z.boolean().default(false),
  /** A tax advisor files the annual returns, which moves their deadline. */
  advisor: z.boolean().default(false),
  /** Germany: a trade (Gewerbe), so trade tax applies. Freelancers usually have none. */
  tradeTax: z.boolean().default(true),
  /** Quarterly income or corporate tax prepayments set by the tax office. */
  incomeTaxPrepayments: z.boolean().default(false),
  /** Quarterly trade tax prepayments set by the municipality. */
  tradeTaxPrepayments: z.boolean().default(false),
  /** EC Sales List (Zusammenfassende Meldung) for VAT-free supplies to businesses in other EU countries. */
  ecSalesList: z.boolean().default(false),
  ecSalesListFrequency: z.enum(['monthly', 'quarterly']).default('quarterly'),
  /** Uses the EU cross-border SME scheme (has an EX number): a quarterly turnover report at home. */
  euSmeScheme: z.boolean().default(false),
  /**
   * The year the business started, when it is older than the account. Deadlines
   * from 1 January of that year on count; unset, they count from the day the
   * account was created (`since`), so a new account never opens on "missed".
   */
  startYear: z.number().int().min(1990).max(2100).optional(),
});
export type TaxDeadlineProfile = z.infer<typeof TaxDeadlineProfileSchema>;

export const CustomDeadlineSchema = z.object({
  id: z.string().min(1).max(60),
  title: z.string().trim().min(1).max(120),
  note: z.string().max(500).default(''),
  action: z.enum(['file', 'pay', 'file-pay', 'other']).default('other'),
  /** `once` on `date`; otherwise every month, quarter or year from `date` on, same day (clamped to the month's end). */
  repeat: z.enum(['once', 'monthly', 'quarterly', 'yearly']).default('once'),
  date: Day,
  /** Optional last day it repeats until. */
  until: Day.optional(),
});
export type CustomDeadline = z.infer<typeof CustomDeadlineSchema>;

/** Lead times people pick from; any whole number of days 0-90 is allowed. */
export const REMINDER_PRESETS: { days: number; label: string }[] = [
  { days: 0, label: 'On the day' },
  { days: 1, label: '1 day before' },
  { days: 3, label: '3 days before' },
  { days: 5, label: '5 days before' },
  { days: 7, label: '1 week before' },
  { days: 14, label: '2 weeks before' },
  { days: 21, label: '3 weeks before' },
  { days: 30, label: '1 month before' },
];

export const TaxDeadlineSettingsSchema = z.object({
  profile: TaxDeadlineProfileSchema.default(TaxDeadlineProfileSchema.parse({})),
  custom: z.array(CustomDeadlineSchema).max(100).default([]),
  /** Rule ids switched off (e.g. 'de.trade-tax-prepayment'). */
  off: z.array(z.string().max(60)).max(50).default([]),
  reminders: z
    .object({
      /** Days before the due date to remind, e.g. [14, 3]. Empty: no reminders. */
      leadDays: z.array(z.number().int().min(0).max(90)).max(6).default([7, 1]),
      /** Also email the owner, not just the bell. */
      email: z.boolean().default(true),
      /** One more note the day after a deadline that is not ticked off. */
      overdue: z.boolean().default(true),
      timeZone: z.string().max(60).default('Europe/Berlin'),
    })
    .default({ leadDays: [7, 1], email: true, overdue: true, timeZone: 'Europe/Berlin' }),
  /** True once someone saved the settings: until then nothing is reminded. */
  configured: z.boolean().default(false),
  /**
   * The day the account was created (YYYY-MM-DD). Deadlines due before it were
   * never this account's to file, so they are neither listed as missed nor
   * reminded about. The server fills it in from the account on every read; a
   * `startYear` in the profile takes its place when set.
   */
  since: Day.optional(),
});
export type TaxDeadlineSettings = z.infer<typeof TaxDeadlineSettingsSchema>;

/** The first day deadlines count from: 1 January of `startYear` when given, else the account's creation day. */
export function deadlinesFrom(settings: Pick<TaxDeadlineSettings, 'profile'> & Partial<Pick<TaxDeadlineSettings, 'since'>>): string | undefined {
  if (settings.profile.startYear) return `${settings.profile.startYear}-01-01`;
  return settings.since;
}

export function defaultTaxDeadlineSettings(): TaxDeadlineSettings {
  return TaxDeadlineSettingsSchema.parse({});
}

/** Lead days cleaned up: whole, 0-90, no repeats, largest first. */
export function normalizeLeadDays(days: number[]): number[] {
  return [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 90))].sort((a, b) => b - a).slice(0, 6);
}

/** "2 weeks before", "3 days before", "On the day". */
export function leadLabel(days: number): string {
  const preset = REMINDER_PRESETS.find((p) => p.days === days);
  if (preset) return preset.label;
  if (days % 7 === 0) return `${days / 7} weeks before`;
  return `${days} days before`;
}

// ── Deadlines ───────────────────────────────────────────────────────────────

export type DeadlineAction = 'file' | 'pay' | 'file-pay' | 'other';

export interface TaxDeadline {
  /** Stable per occurrence: rule id and period, e.g. 'de.vat-return:2026-09'. */
  id: string;
  ruleId: string;
  title: string;
  /** What period it covers, as people say it ("September 2026", "Q3 2026", "2025"). */
  period: string;
  action: DeadlineAction;
  /** The day it is due, after moving off weekends and holidays. */
  due: string;
  /** The day the law names, before moving. Equal to `due` when nothing moved. */
  statutory: string;
  detail: string;
  /** Where it is filed or paid, when there is one place. */
  where?: string;
  custom?: boolean;
}

export interface RuleInfo {
  id: string;
  label: string;
}

/** What a country contributes: its deadlines, and whether a day is a working day there. */
interface RuleSet {
  country: string;
  rules: RuleInfo[];
  deadlines(profile: TaxDeadlineProfile, year: number): Omit<TaxDeadline, 'due'>[];
  /** Next working day on or after `day`. Absent: nothing moves. */
  shift?(day: string, profile: TaxDeadlineProfile): string;
}

// ── Calendar arithmetic (UTC, on plain days) ────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const parts = (day: string) => day.split('-').map(Number) as [number, number, number];
const toUtc = (day: string) => {
  const [y, m, d] = parts(day);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms: number) => {
  const d = new Date(ms);
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
};
export const addDays = (day: string, n: number): string => fromUtc(toUtc(day) + n * 86_400_000);
export const daysBetween = (from: string, to: string): number => Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Month `m` (1-12) of `y` moved by `n` months. */
function addMonths(y: number, m: number, n: number): [number, number] {
  const i = y * 12 + (m - 1) + n;
  return [Math.floor(i / 12), (i % 12) + 1];
}
/** Day `d` in the month, clamped to its end (31 Jan + 1 month = 28/29 Feb). */
const clampDay = (y: number, m: number, d: number) => ymd(y, m, Math.min(d, lastDayOfMonth(y, m)));
const weekday = (day: string) => new Date(toUtc(day)).getUTCDay(); // 0 Sunday

/** Easter Sunday (Gregorian, anonymous algorithm). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

// ── Germany ─────────────────────────────────────────────────────────────────

const ALL_STATES = GERMAN_STATES.map((s) => s.code);

/** German public holidays in a year, national ones plus those of `state` (none when empty). */
export function germanHolidays(year: number, state = ''): Map<string, string> {
  const easter = easterSunday(year);
  const list: { day: string; name: string; states: string[] }[] = [
    { day: ymd(year, 1, 1), name: 'Neujahr', states: ALL_STATES },
    { day: ymd(year, 1, 6), name: 'Heilige Drei Könige', states: ['BW', 'BY', 'ST'] },
    { day: ymd(year, 3, 8), name: 'Internationaler Frauentag', states: ['BE', 'MV'] },
    { day: addDays(easter, -2), name: 'Karfreitag', states: ALL_STATES },
    { day: addDays(easter, 1), name: 'Ostermontag', states: ALL_STATES },
    { day: ymd(year, 5, 1), name: 'Tag der Arbeit', states: ALL_STATES },
    { day: addDays(easter, 39), name: 'Christi Himmelfahrt', states: ALL_STATES },
    { day: addDays(easter, 50), name: 'Pfingstmontag', states: ALL_STATES },
    { day: addDays(easter, 60), name: 'Fronleichnam', states: ['BW', 'BY', 'HE', 'NW', 'RP', 'SL'] },
    { day: ymd(year, 8, 15), name: 'Mariä Himmelfahrt', states: ['SL'] },
    { day: ymd(year, 9, 20), name: 'Weltkindertag', states: ['TH'] },
    { day: ymd(year, 10, 3), name: 'Tag der Deutschen Einheit', states: ALL_STATES },
    { day: ymd(year, 10, 31), name: 'Reformationstag', states: ['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH'] },
    { day: ymd(year, 11, 1), name: 'Allerheiligen', states: ['BW', 'BY', 'NW', 'RP', 'SL'] },
    // The Wednesday before 23 November.
    { day: addDays(ymd(year, 11, 23), -(((weekday(ymd(year, 11, 23)) - 3 + 7) % 7) || 7)), name: 'Buß- und Bettag', states: ['SN'] },
    { day: ymd(year, 12, 25), name: '1. Weihnachtstag', states: ALL_STATES },
    { day: ymd(year, 12, 26), name: '2. Weihnachtstag', states: ALL_STATES },
  ];
  const out = new Map<string, string>();
  for (const h of list) if (h.states.length === ALL_STATES.length || (state && h.states.includes(state))) out.set(h.day, h.name);
  return out;
}

/** §108 Abs. 3 AO: a deadline on a Saturday, Sunday or holiday ends on the next working day. */
export function nextGermanWorkingDay(day: string, state = ''): string {
  let d = day;
  for (let i = 0; i < 10; i++) {
    const w = weekday(d);
    if (w !== 0 && w !== 6 && !germanHolidays(parts(d)[0], state).has(d)) return d;
    d = addDays(d, 1);
  }
  return d;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Annual returns (income, corporate, trade tax, VAT) for tax year `y`.
 * Own filing: 31 July of the next year. With a tax advisor: the last day of
 * February of the year after that. The pandemic extensions still apply to
 * the years listed.
 */
export function germanAnnualDeadline(y: number, advisor: boolean): string {
  const special: Record<number, [string, string]> = {
    2022: ['2023-09-30', '2024-07-31'],
    2023: ['2024-08-31', '2025-05-31'],
    2024: ['2025-07-31', '2026-04-30'],
  };
  if (special[y]) return special[y]![advisor ? 1 : 0];
  return advisor ? ymd(y + 2, 2, lastDayOfMonth(y + 2, 2)) : ymd(y + 1, 7, 31);
}

const SCHONFRIST = 'A bank transfer up to three days late costs no late-payment surcharge (Schonfrist); the filing itself has no grace period.';

const germany: RuleSet = {
  country: 'DE',
  rules: [
    { id: 'de.vat-return', label: 'VAT return (Umsatzsteuer-Voranmeldung)' },
    { id: 'de.vat-special-prepayment', label: 'Special VAT prepayment (Sondervorauszahlung)' },
    { id: 'de.vat-annual', label: 'Annual VAT return (Umsatzsteuererklärung)' },
    { id: 'de.income-tax-return', label: 'Income or corporate tax return' },
    { id: 'de.trade-tax-return', label: 'Trade tax return (Gewerbesteuererklärung)' },
    { id: 'de.income-tax-prepayment', label: 'Income or corporate tax prepayment' },
    { id: 'de.trade-tax-prepayment', label: 'Trade tax prepayment (Gewerbesteuer)' },
    { id: 'de.ec-sales-list', label: 'EC Sales List (Zusammenfassende Meldung)' },
  ],
  deadlines(p, year) {
    const out: Omit<TaxDeadline, 'due'>[] = [];
    const push = (d: Omit<TaxDeadline, 'due'>) => out.push(d);

    // VAT returns: the 10th after the period, one month later with the extension.
    if (p.vat === 'regular' && p.vatFrequency !== 'yearly') {
      const step = p.vatFrequency === 'monthly' ? 1 : 3;
      for (let m = step; m <= 12; m += step) {
        const [dy, dm] = addMonths(year, m, 1 + (p.extension ? 1 : 0));
        const period = step === 1 ? `${MONTHS[m - 1]} ${year}` : `Q${m / 3} ${year}`;
        push({
          id: `de.vat-return:${step === 1 ? `${year}-${pad(m)}` : `${year}-Q${m / 3}`}`,
          ruleId: 'de.vat-return',
          title: `VAT return ${period}`,
          period,
          action: 'file-pay',
          statutory: ymd(dy, dm, 10),
          detail: `Umsatzsteuer-Voranmeldung through ELSTER, and the VAT owed is due the same day. ${SCHONFRIST}`,
          where: 'ELSTER',
        });
      }
      // Monthly filers keep the extension by paying 1/11 of last year's VAT each February.
      if (p.extension && p.vatFrequency === 'monthly') {
        push({
          id: `de.vat-special-prepayment:${year}`,
          ruleId: 'de.vat-special-prepayment',
          title: `Special VAT prepayment ${year}`,
          period: String(year),
          action: 'file-pay',
          statutory: ymd(year, 2, 10),
          detail: 'Sondervorauszahlung: 1/11 of last year\'s VAT, filed and paid to keep the Dauerfristverlängerung. It is credited back on the December return.',
          where: 'ELSTER',
        });
      }
    }

    // Annual returns for last year. Kleinunternehmer no longer file a VAT return (from tax year 2024).
    const ty = year - 1;
    const annual = germanAnnualDeadline(ty, p.advisor);
    const byWhom = p.advisor ? 'The deadline with a tax advisor.' : 'The deadline when filing yourself; a tax advisor gets longer.';
    if (p.vat === 'regular') {
      push({ id: `de.vat-annual:${ty}`, ruleId: 'de.vat-annual', title: `Annual VAT return ${ty}`, period: String(ty), action: 'file', statutory: annual, detail: `Umsatzsteuererklärung. ${byWhom} Any balance is due a month after filing.`, where: 'ELSTER' });
    }
    push({
      id: `de.income-tax-return:${ty}`,
      ruleId: 'de.income-tax-return',
      title: p.legalForm === 'company' ? `Corporate tax return ${ty}` : `Income tax return ${ty}`,
      period: String(ty),
      action: 'file',
      statutory: annual,
      detail: p.legalForm === 'company' ? `Körperschaftsteuererklärung with the annual accounts (E-Bilanz). ${byWhom}` : `Einkommensteuererklärung with the Anlage EÜR (profit and loss). ${byWhom}`,
      where: 'ELSTER',
    });
    if (p.tradeTax) {
      push({ id: `de.trade-tax-return:${ty}`, ruleId: 'de.trade-tax-return', title: `Trade tax return ${ty}`, period: String(ty), action: 'file', statutory: annual, detail: `Gewerbesteuererklärung. ${byWhom}`, where: 'ELSTER' });
    }

    // Prepayments: income or corporate tax 10 Mar/Jun/Sep/Dec, trade tax 15 Feb/May/Aug/Nov.
    if (p.incomeTaxPrepayments) {
      [3, 6, 9, 12].forEach((m, i) =>
        push({
          id: `de.income-tax-prepayment:${year}-Q${i + 1}`,
          ruleId: 'de.income-tax-prepayment',
          title: `${p.legalForm === 'company' ? 'Corporate' : 'Income'} tax prepayment Q${i + 1} ${year}`,
          period: `Q${i + 1} ${year}`,
          action: 'pay',
          statutory: ymd(year, m, 10),
          detail: `The amount is on the tax office's prepayment notice (Vorauszahlungsbescheid). ${SCHONFRIST}`,
          where: 'Finanzamt',
        }),
      );
    }
    if (p.tradeTax && p.tradeTaxPrepayments) {
      [2, 5, 8, 11].forEach((m, i) =>
        push({
          id: `de.trade-tax-prepayment:${year}-Q${i + 1}`,
          ruleId: 'de.trade-tax-prepayment',
          title: `Trade tax prepayment Q${i + 1} ${year}`,
          period: `Q${i + 1} ${year}`,
          action: 'pay',
          statutory: ymd(year, m, 15),
          detail: `Paid to the municipality (Gemeinde), the amount is on its notice. ${SCHONFRIST}`,
          where: 'Gemeinde',
        }),
      );
    }

    // EC Sales List: the 25th after the month or quarter, never extended.
    if (p.ecSalesList) {
      const step = p.ecSalesListFrequency === 'monthly' ? 1 : 3;
      for (let m = step; m <= 12; m += step) {
        const [dy, dm] = addMonths(year, m, 1);
        const period = step === 1 ? `${MONTHS[m - 1]} ${year}` : `Q${m / 3} ${year}`;
        push({
          id: `de.ec-sales-list:${step === 1 ? `${year}-${pad(m)}` : `${year}-Q${m / 3}`}`,
          ruleId: 'de.ec-sales-list',
          title: `EC Sales List ${period}`,
          period,
          action: 'file',
          statutory: ymd(dy, dm, 25),
          detail: 'Zusammenfassende Meldung to the Bundeszentralamt für Steuern, for VAT-free supplies to businesses in other EU countries. The Dauerfristverlängerung does not apply.',
          where: 'BZSt Online-Portal',
        });
      }
    }
    return out;
  },
  shift: (day, p) => nextGermanWorkingDay(day, p.region),
};

const RULE_SETS: Record<string, RuleSet> = { DE: germany };

/** EU-wide: the cross-border SME scheme's quarterly report, within a month of the quarter's end. */
const SME_RULE: RuleInfo = { id: 'eu.sme-report', label: 'EU SME scheme quarterly report' };
function smeReports(p: TaxDeadlineProfile, year: number): Omit<TaxDeadline, 'due'>[] {
  if (!p.euSmeScheme || !EU.includes(p.country)) return [];
  return [1, 2, 3, 4].map((q) => {
    const [dy, dm] = addMonths(year, q * 3, 1);
    return {
      id: `eu.sme-report:${year}-Q${q}`,
      ruleId: SME_RULE.id,
      title: `SME scheme report Q${q} ${year}`,
      period: `Q${q} ${year}`,
      action: 'file' as const,
      statutory: ymd(dy, dm, lastDayOfMonth(dy, dm)),
      detail: 'Turnover per EU country for the quarter (zero where there was none), filed in the country you are established in. The figures are under Books → SME report.',
      where: p.country === 'DE' ? 'BZSt Online-Portal' : 'Your tax office',
    };
  });
}

/** Whether there is a full rule set for the country (beyond the SME report and custom deadlines). */
export function hasCountryRules(country: string): boolean {
  return country in RULE_SETS;
}

/**
 * The rules the profile's answers leave standing, to switch off one by one.
 * A Kleinunternehmer is not offered VAT returns, a business without the EU
 * scheme no SME report: the list shows what the answers decided, not every
 * rule the country has. Worked out by asking each rule set for a year's
 * deadlines, the same way the list itself is built, so the two cannot drift.
 */
export function rulesFor(profile: TaxDeadlineProfile, year = new Date().getUTCFullYear()): RuleInfo[] {
  const set = RULE_SETS[profile.country];
  const active = new Set([...(set?.deadlines(profile, year) ?? []), ...smeReports(profile, year)].map((d) => d.ruleId));
  return [...(set?.rules ?? []), ...(EU.includes(profile.country) ? [SME_RULE] : [])].filter((r) => active.has(r.id));
}

function customOccurrences(c: CustomDeadline, from: string, to: string): Omit<TaxDeadline, 'due'>[] {
  const base = { ruleId: `custom:${c.id}`, title: c.title, action: c.action, detail: c.note, custom: true as const };
  if (c.repeat === 'once') return c.date >= from && c.date <= to ? [{ ...base, id: `custom:${c.id}:${c.date}`, period: '', statutory: c.date }] : [];
  const step = c.repeat === 'monthly' ? 1 : c.repeat === 'quarterly' ? 3 : 12;
  const [y0, m0, d0] = parts(c.date);
  const out: Omit<TaxDeadline, 'due'>[] = [];
  for (let i = 0; i < 1200; i += step) {
    const [y, m] = addMonths(y0, m0, i);
    const day = clampDay(y, m, d0);
    if (day > to || (c.until && day > c.until)) break;
    if (day >= from) out.push({ ...base, id: `custom:${c.id}:${day}`, period: '', statutory: day });
  }
  return out;
}

/** What `deadlinesBetween` and the reminders work from; `since` is optional because older callers never had it. */
export type DeadlineSource = Pick<TaxDeadlineSettings, 'profile' | 'custom' | 'off'> & Partial<Pick<TaxDeadlineSettings, 'since'>>;

/**
 * Every deadline due between `from` and `to` (inclusive), sorted by due day.
 * Rules in `settings.off` are left out, as is anything due before the day
 * the deadlines count from (`deadlinesFrom`).
 */
export function deadlinesBetween(settings: DeadlineSource, from: string, to: string): TaxDeadline[] {
  const p = settings.profile;
  const set = RULE_SETS[p.country];
  const off = new Set(settings.off);
  const out: TaxDeadline[] = [];
  const first = deadlinesFrom(settings);
  if (first && first > from) from = first;
  if (from > to) return out;
  // A year's rules can fall due well into the next two (annual returns with an advisor).
  for (let y = parts(from)[0] - 2; y <= parts(to)[0]; y++) {
    for (const d of [...(set?.deadlines(p, y) ?? []), ...smeReports(p, y)]) {
      if (off.has(d.ruleId)) continue;
      const due = set?.shift ? set.shift(d.statutory, p) : d.statutory;
      if (due >= from && due <= to) out.push({ ...d, due });
    }
  }
  for (const c of settings.custom) {
    // Custom days move like the country's own, when its rules are known.
    for (const d of customOccurrences(c, addDays(from, -7), to)) {
      const due = set?.shift ? set.shift(d.statutory, p) : d.statutory;
      if (due >= from && due <= to) out.push({ ...d, due });
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title));
}

// ── Reminders ───────────────────────────────────────────────────────────────

export interface ReminderDue {
  deadline: TaxDeadline;
  /** Days before the due day this reminder is for; -1 is the overdue note. */
  lead: number;
  /** Larger lead times this one stands in for, which should not be sent any more. */
  covers: number[];
}

/**
 * What to remind about today. For each open deadline, the smallest lead time
 * already reached; when the server was down through several, one note goes
 * out and stands in for the larger ones (`covers`). `sent` holds
 * `${deadlineId}|${lead}` for what already went out.
 */
export function remindersDue(
  settings: DeadlineSource & Pick<TaxDeadlineSettings, 'reminders'>,
  today: string,
  done: Set<string>,
  sent: Set<string>,
): ReminderDue[] {
  const leads = normalizeLeadDays(settings.reminders.leadDays);
  const out: ReminderDue[] = [];
  const max = leads[0] ?? 0;
  for (const d of deadlinesBetween(settings, addDays(today, -1), addDays(today, max))) {
    if (done.has(d.id)) continue;
    const left = daysBetween(today, d.due);
    if (left < 0) {
      if (left === -1 && settings.reminders.overdue && !sent.has(`${d.id}|-1`)) out.push({ deadline: d, lead: -1, covers: [] });
      continue;
    }
    const reached = leads.filter((l) => l >= left);
    if (!reached.length) continue;
    const lead = Math.min(...reached);
    if (sent.has(`${d.id}|${lead}`)) continue;
    out.push({ deadline: d, lead, covers: reached.filter((l) => l !== lead && !sent.has(`${d.id}|${l}`)) });
  }
  return out;
}

/** "today", "tomorrow", "in 5 days", "2 days ago". */
export function dueIn(due: string, today: string): string {
  const n = daysBetween(today, due);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

export const ACTION_LABELS: Record<DeadlineAction, string> = { file: 'File', pay: 'Pay', 'file-pay': 'File and pay', other: 'Deadline' };

/** The calendar day it is in a time zone (falls back to UTC for an unknown zone). */
export function dayInZone(at: number, timeZone: string): string {
  try {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}
