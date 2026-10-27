import { GIVEN_AWAY, coveredByPerDiem, localIsoDay, round2, toBaseFactor, vatBreakdown, type ExpenseDetail, type SalesEvent, type Transaction } from '@zollify/shared';

/**
 * A year in review: what the whole year came to, from the same figures the
 * ledger and the ranking show. Revenue is what customers paid less the VAT
 * the till collected, in each sale's book currency; costs are the ledger's,
 * by the date they were paid. One block per currency, since a year's
 * figures only add up in one; the block with the most revenue comes first.
 * Pure over what the device holds - nothing is entered here.
 */

/** A ledger expense as the year needs it. */
export interface YearExpense {
  eventId: string;
  category: string;
  amount: number;
  currency: string;
  /** YYYY-MM-DD. */
  date: string;
  /** How a computed expense came about; a per diem's says which days it covers. */
  detail?: ExpenseDetail | null;
}

export interface YearEventRow {
  eventId: string;
  name: string;
  kind: 'event' | 'store';
  revenue: number;
  expenses: number;
  profit: number;
  units: number;
  sales: number;
}

export interface YearProductRow {
  key: string;
  title: string;
  units: number;
  /** Line revenue as paid, VAT included. */
  revenue: number;
}

export interface YearBlock {
  currency: string;
  /** Excluding the VAT collected. */
  revenue: number;
  vat: number;
  expenses: number;
  byCategory: Record<string, number>;
  /** Food bought on days a per diem covers: in the costs, since the money went, but the flat rate already stands for it at tax time. */
  mealsCovered: number;
  profit: number;
  sales: number;
  units: number;
  /** Sales that came to nothing and were given away. */
  givenAway: number;
  /** Revenue excl. VAT per month, January first. */
  byMonth: number[];
  /** Every event or store that sold or cost something this year, best profit first. */
  events: YearEventRow[];
  /** What sold most, by units. */
  products: YearProductRow[];
}

export interface YearReview {
  year: number;
  blocks: YearBlock[];
}

const live = (tx: Transaction): boolean => !tx.revertedAt && !tx.revertedBy;
const bookCurrency = (tx: Transaction): string => tx.baseCurrency ?? tx.currency;
const bookTotal = (tx: Transaction): number => tx.baseTotal ?? tx.total;
const yearOf = (day: string): number => Number(day.slice(0, 4));

/** The years anything happened in, latest first. */
export function yearsWithData(transactions: Transaction[], expenses: YearExpense[], today = localIsoDay()): number[] {
  const years = new Set<number>([yearOf(today)]);
  for (const tx of transactions) if (live(tx)) years.add(yearOf(localIsoDay(tx.timestamp)));
  for (const e of expenses) if (e.date) years.add(yearOf(e.date));
  return [...years].filter((y) => Number.isFinite(y)).sort((a, b) => b - a);
}

export function yearReview(year: number, events: SalesEvent[], transactions: Transaction[], expenses: YearExpense[], top = 10): YearReview {
  const names = new Map(events.map((e) => [e.id, e]));
  const blocks = new Map<string, YearBlock>();
  const block = (currency: string): YearBlock => {
    let b = blocks.get(currency);
    if (!b) {
      b = { currency, revenue: 0, vat: 0, expenses: 0, byCategory: {}, mealsCovered: 0, profit: 0, sales: 0, units: 0, givenAway: 0, byMonth: Array(12).fill(0), events: [], products: [] };
      blocks.set(currency, b);
    }
    return b;
  };
  const eventRows = new Map<string, YearEventRow>();
  const eventRow = (b: YearBlock, eventId: string): YearEventRow => {
    const key = `${b.currency}:${eventId}`;
    let r = eventRows.get(key);
    if (!r) {
      const e = names.get(eventId);
      r = { eventId, name: e?.name || eventId, kind: e?.kind === 'store' ? 'store' : 'event', revenue: 0, expenses: 0, profit: 0, units: 0, sales: 0 };
      eventRows.set(key, r);
      b.events.push(r);
    }
    return r;
  };
  const productRows = new Map<string, YearProductRow>();

  for (const tx of transactions) {
    if (!live(tx)) continue;
    const day = localIsoDay(tx.timestamp);
    if (yearOf(day) !== year) continue;
    const b = block(bookCurrency(tx));
    const factor = toBaseFactor(tx, b.currency);
    const vat = vatBreakdown(tx).reduce((s, r) => s + r.vat, 0) * factor;
    const revenue = bookTotal(tx) - vat;
    b.revenue += revenue;
    b.vat += vat;
    b.sales += 1;
    if (tx.method === GIVEN_AWAY) b.givenAway += 1;
    b.byMonth[Number(day.slice(5, 7)) - 1]! += revenue;
    const row = eventRow(b, tx.eventId);
    row.revenue += revenue;
    row.sales += 1;
    for (const i of tx.items) {
      if (i.lineTotal < 0) continue;
      b.units += i.qty;
      row.units += i.qty;
      const key = `${b.currency}:${i.pid}:${i.vid ?? ''}`;
      let p = productRows.get(key);
      if (!p) {
        p = { key: `${i.pid}:${i.vid ?? ''}`, title: [i.title, i.variantLabel].filter(Boolean).join(' · ') || i.pid, units: 0, revenue: 0 };
        productRows.set(key, p);
        b.products.push(p);
      }
      p.units += i.qty;
      p.revenue += i.baseLineTotal ?? i.lineTotal * factor;
    }
  }

  const covered = new Set(coveredByPerDiem(expenses));
  for (const e of expenses) {
    if (!e.date || yearOf(e.date) !== year) continue;
    const b = block(e.currency);
    b.expenses += e.amount;
    b.byCategory[e.category] = (b.byCategory[e.category] ?? 0) + e.amount;
    if (covered.has(e)) b.mealsCovered += e.amount;
    if (e.eventId) eventRow(b, e.eventId).expenses += e.amount;
  }

  const out: YearBlock[] = [];
  for (const b of blocks.values()) {
    b.revenue = round2(b.revenue);
    b.vat = round2(b.vat);
    b.expenses = round2(b.expenses);
    b.mealsCovered = round2(b.mealsCovered);
    b.profit = round2(b.revenue - b.expenses);
    b.byMonth = b.byMonth.map(round2);
    for (const c of Object.keys(b.byCategory)) b.byCategory[c] = round2(b.byCategory[c]!);
    for (const r of b.events) {
      r.revenue = round2(r.revenue);
      r.expenses = round2(r.expenses);
      r.profit = round2(r.revenue - r.expenses);
    }
    b.events.sort((x, y) => y.profit - x.profit || y.revenue - x.revenue || x.name.localeCompare(y.name));
    b.products = b.products
      .map((p) => ({ ...p, revenue: round2(p.revenue) }))
      .sort((x, y) => y.units - x.units || y.revenue - x.revenue || x.title.localeCompare(y.title))
      .slice(0, top);
    out.push(b);
  }
  return { year, blocks: out.sort((x, y) => y.revenue - x.revenue || y.expenses - x.expenses) };
}

/** Change from one year to the next, as a fraction (0.25 = up a quarter); null without a figure to compare to. */
export const yearChange = (now: number, before: number | undefined): number | null => (before == null || before === 0 ? null : round2((now - before) / Math.abs(before)));
