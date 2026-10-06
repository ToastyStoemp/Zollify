import { z } from 'zod';
import {
  baseFactor,
  cardFeeOf,
  consignmentLines,
  consignmentStatements,
  rentDue,
  rentalPeriods,
  type CardFees,
  type ConsignmentLine,
  type ConsignmentPayout,
  type ConsignmentRental,
  type Consignor,
} from './consignment';
import type { Transaction } from './types';

/**
 * The store's books for consignment: fees it charges artists, its settings
 * for card costs and reporting, and the periodic report - what sold, what
 * was discounted, the VAT in it, what cards cost, and what each artist is
 * owed for the period. Pure, like the rest of consignment: the server feeds
 * it the op-log and the tests pin the arithmetic.
 */

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const toMinor = (n: number): number => Math.round(n * 100);

// ── Fees ────────────────────────────────────────────────────────────────────

/** Why a store charges an artist, with how it reads to both sides. */
export const FEE_REASONS = {
  no_show: 'Missed a setup',
  unresponsive: 'Did not respond',
  late: 'Late stock or setup',
  handling: 'Handling or admin',
  damage: 'Damage or loss',
  other: 'Other',
} as const;
export type FeeReason = keyof typeof FEE_REASONS;
const FeeReasonSchema = z.enum(Object.keys(FEE_REASONS) as [FeeReason, ...FeeReason[]]);

export const FeeInputSchema = z.object({
  consignorId: z.string().min(1).max(80),
  /** The store it concerns, when it concerns one. */
  storeId: z.string().min(1).max(80).nullable().default(null),
  reason: FeeReasonSchema,
  amount: z.number().positive().max(1_000_000),
  currency: Currency,
  date: IsoDate,
  note: z.string().max(500).default(''),
  /** The setup moment it is for, when it is for a missed one. */
  setupId: z.string().min(1).max(80).nullable().default(null),
});
export type FeeInput = z.infer<typeof FeeInputSchema>;

export interface ConsignmentFee extends FeeInput {
  id: string;
  /** Waived fees stay on record but no longer come off the balance. */
  status: 'charged' | 'waived';
  waivedAt: number | null;
  waiveNote: string;
  /** The artist's objection, if they raised one. */
  dispute: string | null;
  disputedAt: number | null;
  createdAt: number;
}

/** What comes off each artist's balance: the fees still charged. */
export function feesDue(fees: Pick<ConsignmentFee, 'consignorId' | 'amount' | 'currency' | 'status'>[]): { consignorId: string; amount: number; currency: string }[] {
  return fees.filter((f) => f.status === 'charged').map(({ consignorId, amount, currency }) => ({ consignorId, amount, currency }));
}

// ── Settings ────────────────────────────────────────────────────────────────

export const BooksSettingsSchema = z.object({
  /** How often the store closes a report. */
  reportPeriod: z.enum(['biweekly', 'monthly']).default('monthly'),
  /** First day of a two-week period; every other period starts 14 days on. */
  biweeklyAnchor: IsoDate.default('2024-01-01'),
  /** Where the store is, so a sale at 23:30 lands on the right day. */
  timeZone: z.string().min(1).max(64).default('UTC'),
  /** Email the owner the report when a period closes. */
  emailReport: z.boolean().default(true),
  /** What the card terminal costs: percent of each card payment... */
  cardFeePct: z.number().min(0).max(20).default(0),
  /** ...plus a fixed amount per card payment, in the books' currency. */
  cardFeeFixed: z.number().min(0).max(100).default(0),
  /** Artists carry their share of card costs on their own sales (in proportion to what they get of the sale). */
  passCardFees: z.boolean().default(false),
  /** Suggested amount per fee reason, in the books' currency. */
  feePresets: z.partialRecord(FeeReasonSchema, z.number().min(0).max(1_000_000)).default({}),
  /** Linked artists may put their own work on discount at the till. */
  artistDiscounts: z.boolean().default(true),
  /** The deepest discount an artist may set, in percent. */
  artistDiscountMaxPct: z.number().min(1).max(100).default(30),
});
export type BooksSettings = z.infer<typeof BooksSettingsSchema>;
export const DEFAULT_BOOKS_SETTINGS: BooksSettings = BooksSettingsSchema.parse({});

/** Card costs as consignmentLines takes them. */
export function cardFeesOf(s: Pick<BooksSettings, 'cardFeePct' | 'cardFeeFixed' | 'passCardFees'>): CardFees | undefined {
  return s.passCardFees && (s.cardFeePct > 0 || s.cardFeeFixed > 0) ? { pct: s.cardFeePct, fixed: s.cardFeeFixed } : undefined;
}
// ── Periods ─────────────────────────────────────────────────────────────────

/** Inclusive dates, yyyy-mm-dd, in the store's time zone. */
export interface ReportPeriod {
  from: string;
  to: string;
}

const DAY = 86_400_000;
const dayMs = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The calendar day a moment falls on where the store is. */
export function localDay(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  } catch {
    return isoOf(ms);
  }
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The period a day falls in. */
export function reportPeriod(s: Pick<BooksSettings, 'reportPeriod' | 'biweeklyAnchor'>, day: string): ReportPeriod {
  if (s.reportPeriod === 'monthly') {
    const [y, m] = day.split('-').map(Number) as [number, number];
    return { from: `${day.slice(0, 7)}-01`, to: isoOf(Date.UTC(y, m, 0)) };
  }
  const k = Math.floor((dayMs(day) - dayMs(s.biweeklyAnchor)) / (14 * DAY));
  const from = dayMs(s.biweeklyAnchor) + k * 14 * DAY;
  return { from: isoOf(from), to: isoOf(from + 13 * DAY) };
}

/** The period a day falls in and the ones before it, newest first. */
export function recentPeriods(s: Pick<BooksSettings, 'reportPeriod' | 'biweeklyAnchor'>, day: string, count: number): ReportPeriod[] {
  const out: ReportPeriod[] = [];
  let p = reportPeriod(s, day);
  for (let i = 0; i < count; i++) {
    out.push(p);
    p = reportPeriod(s, isoOf(dayMs(p.from) - DAY));
  }
  return out;
}

// ── The report ──────────────────────────────────────────────────────────────

export interface ReportTotals {
  currency: string;
  /** Sales (receipts), not lines. */
  sales: number;
  units: number;
  /** What customers paid, VAT and discounts included. */
  gross: number;
  /** Taken off list prices by discounts. */
  discounts: number;
  /** VAT inside gross. */
  vat: number;
  /** gross less VAT. */
  net: number;
  cash: number;
  card: number;
  /** Paid any other way. */
  other: number;
  /** What the card payments cost (from the store's card settings). */
  cardFees: number;
  /** Of gross, sales of artists' work. */
  consigned: number;
  /** The store's commission on those. */
  commission: number;
  /** What the artists earned from those, before card costs, rent and fees. */
  artistShare: number;
  /** Card costs the artists carry. */
  cardFeesPassed: number;
  /** Sales of the store's own stock. */
  own: number;
}

export interface VatReportRow {
  currency: string;
  rate: number;
  gross: number;
  net: number;
  vat: number;
}

export interface ArtistReportRow {
  consignorId: string;
  name: string;
  currency: string;
  units: number;
  gross: number;
  discounts: number;
  commission: number;
  artistShare: number;
  cardFees: number;
  /** Rent for months that started in the period. */
  rent: number;
  /** Fees charged in the period. */
  fees: number;
  /** Paid out in the period. */
  paid: number;
  /** What the period earned them: share less card costs, rent and fees. */
  earned: number;
  /** Everything still owed at the end of the period - what a payout settles. */
  balance: number;
}

export interface StoreReport {
  period: ReportPeriod;
  timeZone: string;
  totals: ReportTotals[];
  byStore: (ReportTotals & { storeId: string })[];
  vat: VatReportRow[];
  artists: ArtistReportRow[];
  /** Discounts by name, for seeing which ones cost what. */
  discountsByName: { name: string; currency: string; amount: number; sales: number }[];
}

export interface ReportInput {
  period: ReportPeriod;
  settings: Pick<BooksSettings, 'timeZone' | 'cardFeePct' | 'cardFeeFixed' | 'passCardFees'>;
  transactions: Transaction[];
  consignors: Pick<Consignor, 'id' | 'name' | 'commissionPct' | 'storeCommission'>[];
  payouts: Pick<ConsignmentPayout, 'consignorId' | 'amount' | 'currency' | 'date'>[];
  fees: Pick<ConsignmentFee, 'consignorId' | 'amount' | 'currency' | 'date' | 'status'>[];
  rentals: ConsignmentRental[];
}

type Tot = Omit<ReportTotals, 'currency'>;
const zeroTot = (): Tot => ({ sales: 0, units: 0, gross: 0, discounts: 0, vat: 0, net: 0, cash: 0, card: 0, other: 0, cardFees: 0, consigned: 0, commission: 0, artistShare: 0, cardFeesPassed: 0, own: 0 });
const MONEY: (keyof Tot)[] = ['gross', 'discounts', 'vat', 'net', 'cash', 'card', 'other', 'cardFees', 'consigned', 'commission', 'artistShare', 'cardFeesPassed', 'own'];

/**
 * One period's report. Everything is in the books' currency (a sale charged
 * in a converted local currency counts at its base figure), summed in minor
 * units. The artists' balances are as of the period's last day, so a past
 * report reads the same tomorrow as today.
 */
export function storeReport(input: ReportInput): StoreReport {
  const { period, settings } = input;
  const tz = settings.timeZone || 'UTC';
  const inPeriod = (d: string): boolean => d >= period.from && d <= period.to;
  const cardFees: CardFees = { pct: settings.cardFeePct, fixed: settings.cardFeeFixed };
  const passed = cardFeesOf(settings);

  const txs = input.transactions.filter((t) => !t.revertedAt && !t.revertedBy && inPeriod(localDay(t.timestamp, tz)));
  const lines = consignmentLines(txs, input.consignors, passed);
  const linesByTx = new Map<string, ConsignmentLine[]>();
  for (const l of lines) linesByTx.set(l.txId, [...(linesByTx.get(l.txId) ?? []), l]);

  // Minor units throughout.
  const totals = new Map<string, Tot>();
  const stores = new Map<string, Tot>();
  const vat = new Map<string, { gross: number; vat: number }>();
  const discounts = new Map<string, { amount: number; sales: Set<string> }>();
  const artistDisc = new Map<string, number>(); // consignor|currency
  const add = (map: Map<string, Tot>, key: string): Tot => {
    let t = map.get(key);
    if (!t) map.set(key, (t = zeroTot()));
    return t;
  };

  for (const tx of txs) {
    const currency = tx.baseCurrency ?? tx.currency;
    const f = baseFactor(tx);
    const rows = [add(totals, currency), add(stores, `${tx.eventId}|${currency}`)];
    const gross = tx.items.reduce((s, i) => s + toMinor(i.baseLineTotal ?? i.lineTotal), 0);
    const legs = tx.payments?.length ? tx.payments : [{ kind: tx.method === 'card' ? 'card' : tx.method === 'cash' ? 'cash' : 'other', amount: tx.total }];
    const paid = { cash: 0, card: 0, other: 0 };
    for (const l of legs) paid[l.kind === 'cash' || l.kind === 'card' ? l.kind : 'other'] += Math.round(l.amount * f * 100);
    // Rounding in conversion must not make the methods disagree with what was sold.
    const drift = gross - (paid.cash + paid.card + paid.other);
    if (drift && Math.abs(drift) <= legs.length) paid[paid.card ? 'card' : paid.cash ? 'cash' : 'other'] += drift;
    const fee = toMinor(cardFeeOf(tx, cardFees));

    let lineVat = 0;
    let lineDisc = 0;
    tx.items.forEach((item, i) => {
      const g = toMinor(item.baseLineTotal ?? item.lineTotal);
      const lf = item.lineTotal ? (item.baseLineTotal ?? item.lineTotal) / item.lineTotal : f;
      const d = Math.max(0, Math.round((item.unitPrice * item.qty - item.lineTotal) * lf * 100));
      lineDisc += d;
      if (item.consignorId) artistDisc.set(`${item.consignorId}|${currency}`, (artistDisc.get(`${item.consignorId}|${currency}`) ?? 0) + d);
      const rate = tx.tax && !tx.tax.exempt ? tx.tax.rates[i] : null;
      if (rate != null) {
        const v = Math.round((g * rate) / (100 + rate));
        lineVat += v;
        const k = `${currency}|${rate}`;
        const acc = vat.get(k) ?? { gross: 0, vat: 0 };
        acc.gross += g;
        acc.vat += v;
        vat.set(k, acc);
      }
    });
    for (const d of tx.discounts ?? []) {
      const k = `${d.name}|${currency}`;
      const acc = discounts.get(k) ?? { amount: 0, sales: new Set<string>() };
      acc.amount += Math.round(d.amount * f * 100);
      acc.sales.add(tx.id);
      discounts.set(k, acc);
    }

    const own = linesByTx.get(tx.id) ?? [];
    const consigned = own.reduce((s, l) => s + toMinor(l.gross), 0);
    for (const t of rows) {
      t.sales += 1;
      t.units += tx.items.reduce((s, i) => s + i.qty, 0);
      t.gross += gross;
      t.discounts += lineDisc;
      t.vat += lineVat;
      t.net += gross - lineVat;
      t.cash += paid.cash;
      t.card += paid.card;
      t.other += paid.other;
      t.cardFees += fee;
      t.consigned += consigned;
      t.commission += own.reduce((s, l) => s + toMinor(l.commission), 0);
      t.artistShare += own.reduce((s, l) => s + toMinor(l.artistShare), 0);
      t.cardFeesPassed += own.reduce((s, l) => s + toMinor(l.cardFees ?? 0), 0);
      t.own += gross - consigned;
    }
  }

  const fromMinor = (t: Tot): Tot => {
    const out = { ...t };
    for (const k of MONEY) out[k] = t[k] / 100;
    return out;
  };

  // Artists: the period's activity, and the balance at its end.
  const rentIn = input.rentals
    .filter((r) => r.deductFromSales)
    .flatMap((r) => rentalPeriods(r).filter(inPeriod).map(() => ({ consignorId: r.consignorId, amount: r.monthlyFee, currency: r.currency })));
  const feesIn = feesDue(input.fees.filter((f) => inPeriod(f.date)));
  const paidIn = input.payouts.filter((p) => inPeriod(p.date));
  const periodStatements = consignmentStatements(lines, paidIn, [], rentIn, feesIn);

  const allLines = consignmentLines(
    input.transactions.filter((t) => localDay(t.timestamp, tz) <= period.to),
    input.consignors,
    passed,
  );
  const closing = consignmentStatements(
    allLines,
    input.payouts.filter((p) => p.date <= period.to),
    [],
    rentDue(input.rentals, period.to),
    feesDue(input.fees.filter((f) => f.date <= period.to)),
  );
  const closingBy = new Map(closing.flatMap((s) => s.totals.map((t) => [`${s.consignorId}|${t.currency}`, t.balance])));
  const names = new Map(input.consignors.map((c) => [c.id, c.name]));

  const artists: ArtistReportRow[] = [];
  const seen = new Set<string>();
  for (const s of periodStatements) {
    for (const t of s.totals) {
      const key = `${s.consignorId}|${t.currency}`;
      seen.add(key);
      artists.push({
        consignorId: s.consignorId,
        name: names.get(s.consignorId) ?? 'Removed artist',
        currency: t.currency,
        units: t.units,
        gross: t.gross,
        discounts: (artistDisc.get(key) ?? 0) / 100,
        commission: t.commission,
        artistShare: t.artistShare,
        cardFees: t.cardFees,
        rent: t.rent,
        fees: t.fees,
        paid: t.paid,
        earned: (toMinor(t.artistShare) - toMinor(t.cardFees) - toMinor(t.rent) - toMinor(t.fees)) / 100,
        balance: closingBy.get(key) ?? 0,
      });
    }
  }
  // Someone still owed money shows up even in a quiet period.
  for (const [key, balance] of closingBy) {
    if (seen.has(key) || !balance) continue;
    const cut = key.lastIndexOf('|');
    const consignorId = key.slice(0, cut);
    artists.push({ consignorId, name: names.get(consignorId) ?? 'Removed artist', currency: key.slice(cut + 1), units: 0, gross: 0, discounts: 0, commission: 0, artistShare: 0, cardFees: 0, rent: 0, fees: 0, paid: 0, earned: 0, balance });
  }

  return {
    period,
    timeZone: tz,
    totals: [...totals.entries()].map(([currency, t]) => ({ currency, ...fromMinor(t) })).sort((a, b) => a.currency.localeCompare(b.currency)),
    byStore: [...stores.entries()]
      .map(([key, t]) => {
        const cut = key.lastIndexOf('|');
        return { storeId: key.slice(0, cut), currency: key.slice(cut + 1), ...fromMinor(t) };
      })
      .sort((a, b) => a.storeId.localeCompare(b.storeId) || a.currency.localeCompare(b.currency)),
    vat: [...vat.entries()]
      .map(([key, v]) => {
        const [currency, rate] = key.split('|') as [string, string];
        return { currency, rate: Number(rate), gross: v.gross / 100, net: (v.gross - v.vat) / 100, vat: v.vat / 100 };
      })
      .sort((a, b) => a.currency.localeCompare(b.currency) || b.rate - a.rate),
    artists: artists.sort((a, b) => a.name.localeCompare(b.name) || a.currency.localeCompare(b.currency)),
    discountsByName: [...discounts.entries()]
      .map(([key, d]) => {
        const cut = key.lastIndexOf('|');
        return { name: key.slice(0, cut), currency: key.slice(cut + 1), amount: d.amount / 100, sales: d.sales.size };
      })
      .sort((a, b) => b.amount - a.amount),
  };
}

/** The report as a spreadsheet: one row per artist, then the totals. */
export function reportCsv(r: StoreReport, storeName: (id: string) => string = (id) => id): string {
  const cell = (v: string | number): string => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const row = (cells: (string | number)[]): string => cells.map(cell).join(',');
  const out = [
    row(['Period', `${r.period.from} to ${r.period.to}`]),
    '',
    row(['Artist', 'Currency', 'Units', 'Sold', 'Discounts', 'Commission', 'Artist share', 'Card costs', 'Rent', 'Fees', 'Earned in period', 'Paid in period', 'Balance at end']),
    ...r.artists.map((a) => row([a.name, a.currency, a.units, a.gross, a.discounts, a.commission, a.artistShare, a.cardFees, a.rent, a.fees, a.earned, a.paid, a.balance])),
    '',
    row(['Store', 'Currency', 'Sales', 'Units', 'Gross', 'Discounts', 'VAT', 'Net', 'Cash', 'Card', 'Other', 'Card costs', 'Consigned', 'Commission', 'Own stock']),
    ...r.byStore.map((t) => row([storeName(t.storeId), t.currency, t.sales, t.units, t.gross, t.discounts, t.vat, t.net, t.cash, t.card, t.other, t.cardFees, t.consigned, t.commission, t.own])),
    ...r.totals.map((t) => row(['All stores', t.currency, t.sales, t.units, t.gross, t.discounts, t.vat, t.net, t.cash, t.card, t.other, t.cardFees, t.consigned, t.commission, t.own])),
    '',
    row(['VAT rate', 'Currency', 'Gross', 'Net', 'VAT']),
    ...r.vat.map((v) => row([`${v.rate}%`, v.currency, v.gross, v.net, v.vat])),
  ];
  return out.join('\n') + '\n';
}

// ── Artists' own discounts ──────────────────────────────────────────────────

/**
 * A discount an artist puts on their own work in a store: percent off, on
 * all their items there or some, optionally only for some days or at some
 * of the store's shops. It becomes an ordinary discount rule in the store,
 * so every till applies it offline too; the store can end it.
 */
export const ArtistDiscountInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  percent: z.number().min(1).max(100),
  /** The store's ids of the artist's items; empty = all their work there. */
  productIds: z.array(z.string().min(1).max(80)).max(500).default([]),
  validFrom: IsoDate.optional(),
  validUntil: IsoDate.optional(),
  /** The store's shops it applies at; empty = all of them. */
  eventIds: z.array(z.string().min(1).max(80)).max(200).default([]),
});
export type ArtistDiscountInput = z.infer<typeof ArtistDiscountInputSchema>;
export interface ArtistDiscount extends ArtistDiscountInput {
  id: string;
  updatedAt: number;
}
/** The store-side id of an artist's discount rule. */
export const artistDiscountRuleId = (consignorId: string, id: string): string => `artist:${consignorId}:${id}`;
