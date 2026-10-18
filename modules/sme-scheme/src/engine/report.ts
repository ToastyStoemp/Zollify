import { EU_COUNTRIES, paidLineTotals, resolveEventVat, type SalesEvent, type Transaction, type VatProfile } from '@zollify/shared';

/**
 * The SME scheme's quarterly figures: what the booth sold in each country.
 *
 * Under the EU SME scheme a business reports, per quarter, the value of its
 * supplies in every member state. Where it is exempt that is simply what the
 * customer paid. Where it charges VAT the VAT is not turnover, so the figure
 * is the amount without it.
 *
 * VAT comes out of the quarter's gross per country and rate in one go
 * (gross × 100 / (100 + rate), rounded once), not by adding up each receipt's
 * own rounding: €2,000 sold in Germany at 19% reports as €1,680.67, however
 * many sales it took to get there.
 *
 * Each sale counts as it was taxed at the time (its SaleTax snapshot), so a
 * later change to the exempt countries never rewrites a closed quarter.
 * Sales from before VAT was tracked fall back to today's event and profile
 * settings and are counted, so the report can say how many it had to guess.
 */

export type Quarter = 1 | 2 | 3 | 4;
export interface QuarterRef {
  year: number;
  quarter: Quarter;
}

/** The quarter a moment falls in, in local time. */
export function quarterOf(timestamp: number): QuarterRef {
  const d = new Date(timestamp);
  return { year: d.getFullYear(), quarter: (Math.floor(d.getMonth() / 3) + 1) as Quarter };
}

/** [from, to) in epoch ms, local time - midnight on the 1st of the quarter's first month to the next quarter's. */
export function quarterRange(q: QuarterRef): { from: number; to: number } {
  const start = (q.quarter - 1) * 3;
  return { from: new Date(q.year, start, 1).getTime(), to: new Date(q.year, start + 3, 1).getTime() };
}

/** "Q3 2026" */
export const quarterLabel = (q: QuarterRef): string => `Q${q.quarter} ${q.year}`;

export function previousQuarter(q: QuarterRef): QuarterRef {
  return q.quarter === 1 ? { year: q.year - 1, quarter: 4 } : { year: q.year, quarter: (q.quarter - 1) as Quarter };
}

export interface RateLine {
  rate: number;
  gross: number;
  vat: number;
  net: number;
}

export interface CountryRow {
  /** ISO code; '' for sales whose country is unknown. */
  country: string;
  /** Book currency the amounts are in. */
  currency: string;
  eu: boolean;
  sales: number;
  /** What customers paid in sales that were exempt. */
  exemptGross: number;
  /** What customers paid in sales that charged VAT, VAT included. */
  chargedGross: number;
  /** VAT inside chargedGross. */
  vat: number;
  /** The figure to report: exempt sales in full, charged sales without VAT. */
  reported: number;
  /** Charged sales per VAT rate. Lines with no known rate count in full, as rate null. */
  rates: RateLine[];
  /** Charged gross on lines with no rate recorded - counted in full, nothing taken off. */
  unrated: number;
  status: 'exempt' | 'charged' | 'mixed';
}

export interface SmeReport {
  quarter: QuarterRef;
  rows: CountryRow[];
  /** Per book currency, over every row. */
  totals: { currency: string; sales: number; gross: number; vat: number; reported: number; euReported: number }[];
  /** Sales left out because they were reverted. */
  reverted: number;
  /** Sales with no VAT snapshot, judged by today's settings instead. */
  estimated: number;
}

export interface ReportInput {
  quarter: QuarterRef;
  transactions: Transaction[];
  eventOf: (id: string) => Pick<SalesEvent, 'venue'> & { vat?: SalesEvent['vat'] } | undefined;
  profile: { vat?: Partial<VatProfile>; artist?: { countryOfOrigin?: string } } | null | undefined;
  /** Book currency for the zero rows of countries with no sales. Defaults to EUR, the scheme's currency. */
  currency?: string;
}

/**
 * The EU countries the quarterly report must cover: every one the business is
 * exempt in under the scheme, home included. Each gets a row, zero where
 * nothing sold - the scheme asks for that, so a blank is not mistaken for
 * a missing figure.
 */
export function reportedCountries(profile: ReportInput['profile']): string[] {
  return (profile?.vat?.exemptCountries ?? []).filter((c) => EU_COUNTRIES.includes(c));
}

const toMinor = (n: number): number => Math.round(n * 100);

/** Book currency: what the event keeps its accounts in. */
const bookCurrency = (tx: Transaction): string => tx.baseCurrency || tx.currency;

/**
 * Each line's paid amount in the book currency, in minor units, adding up to
 * the sale's book total. A sale charged in a converted currency (CHF at a
 * EUR event) is scaled back by baseTotal/total, the remainder on the largest
 * line - the same way the receipt scaled it forward.
 */
function bookLinesMinor(tx: Transaction): number[] {
  const paid = paidLineTotals(tx).map(toMinor);
  const converted = Boolean(tx.baseCurrency) && tx.baseCurrency !== tx.currency && (tx.baseTotal ?? 0) > 0 && tx.total > 0;
  if (!converted) return paid;
  const target = toMinor(tx.baseTotal!);
  const sum = paid.reduce((a, b) => a + b, 0);
  if (!paid.length || sum <= 0) return paid;
  const out = paid.map((m) => Math.round((m * target) / sum));
  const biggest = out.indexOf(Math.max(...out));
  out[biggest] = out[biggest]! + target - out.reduce((a, b) => a + b, 0);
  return out;
}

interface Acc {
  country: string;
  currency: string;
  sales: number;
  exemptMinor: number;
  /** rate -> gross minor; null key = no rate known. */
  byRate: Map<number | null, number>;
  exemptSales: number;
  chargedSales: number;
}

export function buildSmeReport(input: ReportInput): SmeReport {
  const { from, to } = quarterRange(input.quarter);
  const accs = new Map<string, Acc>();
  let reverted = 0;
  let estimated = 0;

  for (const tx of input.transactions) {
    if (tx.timestamp < from || tx.timestamp >= to) continue;
    if (tx.revertedBy) {
      reverted++;
      continue;
    }
    let tax = tx.tax;
    if (!tax) {
      estimated++;
      const r = resolveEventVat(input.eventOf(tx.eventId), input.profile);
      tax = { country: r.country, exempt: r.exempt, rates: tx.items.map(() => (r.exempt ? null : r.standard)) };
    }
    const currency = bookCurrency(tx);
    const key = `${tax.country}|${currency}`;
    let acc = accs.get(key);
    if (!acc) {
      acc = { country: tax.country, currency, sales: 0, exemptMinor: 0, byRate: new Map(), exemptSales: 0, chargedSales: 0 };
      accs.set(key, acc);
    }
    acc.sales++;
    const lines = bookLinesMinor(tx);
    if (tax.exempt) {
      acc.exemptSales++;
      acc.exemptMinor += lines.reduce((a, b) => a + b, 0);
    } else {
      acc.chargedSales++;
      lines.forEach((m, i) => {
        const rate = tax!.rates[i] ?? null;
        acc!.byRate.set(rate, (acc!.byRate.get(rate) ?? 0) + m);
      });
    }
  }

  // Zero rows for the countries the scheme covers that saw no sale in this book currency.
  const zeroCurrency = input.currency || 'EUR';
  for (const country of reportedCountries(input.profile)) {
    if ([...accs.values()].some((a) => a.country === country)) continue;
    accs.set(`${country}|${zeroCurrency}`, { country, currency: zeroCurrency, sales: 0, exemptMinor: 0, byRate: new Map(), exemptSales: 0, chargedSales: 0 });
  }

  const rows: CountryRow[] = [...accs.values()].map((a) => {
    const rates: RateLine[] = [];
    let unratedMinor = 0;
    for (const [rate, gross] of a.byRate) {
      if (rate == null || rate <= 0) {
        unratedMinor += gross;
        continue;
      }
      const vat = Math.round((gross * rate) / (100 + rate));
      rates.push({ rate, gross: gross / 100, vat: vat / 100, net: (gross - vat) / 100 });
    }
    rates.sort((x, y) => y.rate - x.rate);
    const chargedMinor = [...a.byRate.values()].reduce((s, g) => s + g, 0);
    const vatMinor = rates.reduce((s, r) => s + toMinor(r.vat), 0);
    return {
      country: a.country,
      currency: a.currency,
      eu: EU_COUNTRIES.includes(a.country),
      sales: a.sales,
      exemptGross: a.exemptMinor / 100,
      chargedGross: chargedMinor / 100,
      vat: vatMinor / 100,
      reported: (a.exemptMinor + chargedMinor - vatMinor) / 100,
      rates,
      unrated: unratedMinor / 100,
      status: a.chargedSales === 0 ? 'exempt' : a.exemptSales === 0 ? 'charged' : 'mixed',
    };
  });
  // EU first, then by what was sold there - the countries that matter most on top.
  rows.sort((x, y) => Number(y.eu) - Number(x.eu) || y.reported - x.reported || x.country.localeCompare(y.country));

  const byCurrency = new Map<string, SmeReport['totals'][number]>();
  for (const r of rows) {
    const t = byCurrency.get(r.currency) ?? { currency: r.currency, sales: 0, gross: 0, vat: 0, reported: 0, euReported: 0 };
    t.sales += r.sales;
    t.gross = (toMinor(t.gross) + toMinor(r.exemptGross + r.chargedGross)) / 100;
    t.vat = (toMinor(t.vat) + toMinor(r.vat)) / 100;
    t.reported = (toMinor(t.reported) + toMinor(r.reported)) / 100;
    if (r.eu) t.euReported = (toMinor(t.euReported) + toMinor(r.reported)) / 100;
    byCurrency.set(r.currency, t);
  }

  return { quarter: input.quarter, rows, totals: [...byCurrency.values()], reverted, estimated };
}

/** What goes above the columns in the CSV, so the file still says whose and which quarter it is when forwarded. */
export interface CsvHeader {
  businessName?: string;
  exNumber?: string;
  /** Defaults to today. */
  generated?: Date;
}

/**
 * Whether the quarterly report is this business's to file. It is only due
 * once the business is on the cross-border scheme: an EX number, or exempt in
 * an EU country other than home. A Kleinunternehmer at home alone files nothing.
 */
export function schemeApplies(profile: ReportInput['profile'], home: string): boolean {
  if (profile?.vat?.exNumber?.trim()) return true;
  return reportedCountries(profile).some((c) => c !== home);
}

/**
 * The report as CSV, one row per country - for the accountant or for typing
 * into the home country's SME portal. Plain dot decimals so a spreadsheet in
 * any locale reads them as numbers; semicolons so Belgian and German Excel
 * split the columns without asking. A few header lines first (business, EX
 * number, quarter, when it was made), since the file travels without its page.
 */
export function reportCsv(report: SmeReport, countryName: (code: string) => string, header: CsvHeader = {}): string {
  const cell = (v: string | number): string => {
    const s = typeof v === 'number' ? v.toFixed(2) : v;
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const generated = (header.generated ?? new Date()).toISOString().slice(0, 10);
  const lines = [
    `Business;${cell(header.businessName || '-')}`,
    `EX number;${cell(header.exNumber || '-')}`,
    `Quarter;${quarterLabel(report.quarter)}`,
    `Generated;${generated}`,
    '',
  ];
  const head = ['Country', 'Code', 'EU', 'Status', 'Sales', 'Currency', 'Exempt gross', 'Charged gross', 'VAT', 'Reported'];
  lines.push(head.join(';'));
  for (const r of report.rows) {
    lines.push(
      [
        cell(r.country ? countryName(r.country) : 'Unknown'),
        cell(r.country || '-'),
        cell(r.eu ? 'yes' : 'no'),
        cell(r.status),
        String(r.sales),
        cell(r.currency),
        cell(r.exemptGross),
        cell(r.chargedGross),
        cell(r.vat),
        cell(r.reported),
      ].join(';'),
    );
  }
  return lines.join('\n') + '\n';
}
