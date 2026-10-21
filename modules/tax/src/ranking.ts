import { bookLineTotals, conventionKey, csvCell, eventDays, localIsoDay, round2, type Product, type SalesEvent, type Transaction } from '@zollify/shared';

/**
 * Reports across events: which ones paid off, how a show does year over
 * year, what sold where, and what has stopped selling. Pure functions over
 * the sales core holds, the events, and the ledger's per-event costs, so
 * every figure here is the same one the Ledger shows - revenue excluding
 * VAT, costs as entered - only lined up.
 */

export interface EventFigures {
  /** Revenue as customers paid it, in the event's book currency (the ledger's figure). */
  revenue: number;
  /** VAT inside that revenue; comes off, it is the tax office's money. */
  vat: number;
  expenses: number;
  /** Expenses in another currency than the event's: no one profit figure. */
  mixed: boolean;
}

export interface RankRow {
  eventId: string;
  name: string;
  kind: 'event' | 'store';
  start: string;
  end: string;
  country: string;
  currency: string;
  seriesId?: string;
  edition: string;
  /** Event days, dates both counted; for an undated event the days it sold on. */
  days: number;
  revenue: number;
  expenses: number;
  /** null when expenses are in a mix of currencies. */
  profit: number | null;
  perDay: number | null;
  units: number;
  sales: number;
  avgSale: number;
}

const live = (tx: Transaction): boolean => !tx.revertedAt && !tx.revertedBy;
const bookTotal = (tx: Transaction): number => tx.baseTotal ?? tx.total;
const isStore = (e: Pick<SalesEvent, 'kind'>): boolean => e.kind === 'store';

/** Every sale per event, reverted ones left out. */
export function salesByEvent(transactions: Transaction[]): Map<string, Transaction[]> {
  const out = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    if (!live(tx)) continue;
    out.set(tx.eventId, [...(out.get(tx.eventId) ?? []), tx]);
  }
  return out;
}

const sellingDays = (sales: Transaction[]): number => new Set(sales.map((t) => localIsoDay(t.timestamp))).size;

/**
 * One row per event that is over or has sold something, ranked by profit per
 * day (revenue per day where costs are mixed), best first. Stores are not
 * here - they have no end - see `storeRows`.
 */
export function rankEvents(events: SalesEvent[], transactions: Transaction[], figures: Map<string, EventFigures>, today = localIsoDay()): RankRow[] {
  const sales = salesByEvent(transactions);
  const rows: RankRow[] = [];
  for (const e of events) {
    if (isStore(e)) continue;
    const mine = sales.get(e.id) ?? [];
    const over = !!e.dateEnd && e.dateEnd < today;
    if (!mine.length && !over) continue;
    const f = figures.get(e.id) ?? { revenue: round2(mine.reduce((s, t) => s + bookTotal(t), 0)), vat: 0, expenses: 0, mixed: false };
    const revenue = round2(f.revenue - f.vat);
    const days = eventDays(e.dateStart, e.dateEnd) || sellingDays(mine);
    const profit = f.mixed ? null : round2(revenue - f.expenses);
    const units = mine.reduce((s, t) => s + t.items.reduce((n, i) => n + (i.lineTotal >= 0 ? i.qty : 0), 0), 0);
    rows.push({
      eventId: e.id,
      name: e.name || 'Event',
      kind: 'event',
      start: e.dateStart ?? '',
      end: e.dateEnd ?? '',
      country: e.venue?.country ?? '',
      currency: e.currency,
      ...(e.seriesId ? { seriesId: e.seriesId } : {}),
      edition: e.edition ?? '',
      days,
      revenue,
      expenses: f.expenses,
      profit,
      perDay: days ? round2((profit ?? revenue) / days) : null,
      units,
      sales: mine.length,
      avgSale: mine.length ? round2(revenue / mine.length) : 0,
    });
  }
  return rows.sort((a, b) => (b.perDay ?? -Infinity) - (a.perDay ?? -Infinity) || b.revenue - a.revenue || b.start.localeCompare(a.start));
}

/**
 * Stores over a period (`from`..`to`, YYYY-MM-DD, both included): the same
 * figures, with the days they sold on standing in for event days. Costs are
 * whatever the ledger holds for the store dated in the period.
 */
export function storeRows(events: SalesEvent[], transactions: Transaction[], figures: Map<string, EventFigures>, from: string, to: string): RankRow[] {
  const inPeriod = transactions.filter((t) => {
    const d = localIsoDay(t.timestamp);
    return d >= from && d <= to;
  });
  const sales = salesByEvent(inPeriod);
  return events
    .filter(isStore)
    .map((e): RankRow => {
      const mine = sales.get(e.id) ?? [];
      const f = figures.get(e.id) ?? { revenue: round2(mine.reduce((s, t) => s + bookTotal(t), 0)), vat: 0, expenses: 0, mixed: false };
      const revenue = round2(f.revenue - f.vat);
      const days = sellingDays(mine);
      const profit = f.mixed ? null : round2(revenue - f.expenses);
      return {
        eventId: e.id,
        name: e.name || 'Store',
        kind: 'store',
        start: from,
        end: to,
        country: e.venue?.country ?? '',
        currency: e.currency,
        edition: '',
        days,
        revenue,
        expenses: f.expenses,
        profit,
        perDay: days ? round2((profit ?? revenue) / days) : null,
        units: mine.reduce((s, t) => s + t.items.reduce((n, i) => n + (i.lineTotal >= 0 ? i.qty : 0), 0), 0),
        sales: mine.length,
        avgSale: mine.length ? round2(revenue / mine.length) : 0,
      };
    })
    .sort((a, b) => (b.perDay ?? -Infinity) - (a.perDay ?? -Infinity) || b.revenue - a.revenue);
}

export interface EditionRow extends RankRow {
  /** Change against the edition before, as a fraction (0.25 = up a quarter); null for the first or where either side is unknown. */
  revenueChange: number | null;
  profitChange: number | null;
  perDayChange: number | null;
}

export interface SeriesRows {
  key: string;
  name: string;
  editions: EditionRow[];
  /** Mean profit per day over the editions that have one. */
  avgPerDay: number | null;
}

const change = (now: number | null, before: number | null): number | null => (now == null || before == null || before === 0 ? null : round2((now - before) / Math.abs(before)));

/**
 * The same show year over year: editions grouped by their series, or by
 * the name with the year taken out when nobody linked them, oldest first,
 * each against the one before. Only shows with more than one edition.
 */
export function editionTables(rows: RankRow[]): SeriesRows[] {
  const groups = new Map<string, RankRow[]>();
  for (const r of rows) {
    const key = r.seriesId ?? `name:${conventionKey(r.name)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: SeriesRows[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
    const editions = sorted.map((r, i): EditionRow => {
      const prev = i ? sorted[i - 1]! : null;
      return {
        ...r,
        revenueChange: prev ? change(r.revenue, prev.revenue) : null,
        profitChange: prev ? change(r.profit, prev.profit) : null,
        perDayChange: prev ? change(r.perDay, prev.perDay) : null,
      };
    });
    const withPerDay = editions.filter((e) => e.perDay != null);
    out.push({
      key,
      name: sorted[sorted.length - 1]!.name,
      editions,
      avgPerDay: withPerDay.length ? round2(withPerDay.reduce((s, e) => s + e.perDay!, 0) / withPerDay.length) : null,
    });
  }
  return out.sort((a, b) => (b.editions[b.editions.length - 1]!.start ?? '').localeCompare(a.editions[a.editions.length - 1]!.start ?? ''));
}

export interface SoldRow {
  key: string;
  title: string;
  type: string;
  units: number;
  revenue: number;
  /** Of the event's line revenue (before VAT comes off). */
  share: number;
}

/** What sold at one event: items and product types by revenue, with each one's share. */
export function soldAt(eventId: string, transactions: Transaction[], products: Map<string, Product>): { items: SoldRow[]; types: SoldRow[] } {
  const items = new Map<string, SoldRow>();
  const types = new Map<string, SoldRow>();
  let total = 0;
  for (const tx of transactions) {
    if (!live(tx) || tx.eventId !== eventId) continue;
    const book = bookLineTotals(tx);
    tx.items.forEach((item, i) => {
      const amount = book[i] ?? item.lineTotal;
      // A gift card spent, a settling line: not something that sold.
      if (amount < 0) return;
      const product = products.get(item.pid);
      const type = product?.type || 'Other';
      const key = `${item.pid}:${item.vid ?? ''}`;
      const title = item.variantLabel ? `${item.title} · ${item.variantLabel}` : item.title;
      const row = items.get(key) ?? { key, title, type, units: 0, revenue: 0, share: 0 };
      row.units += item.qty;
      row.revenue = round2(row.revenue + amount);
      items.set(key, row);
      const t = types.get(type) ?? { key: type, title: type, type, units: 0, revenue: 0, share: 0 };
      t.units += item.qty;
      t.revenue = round2(t.revenue + amount);
      types.set(type, t);
      total += amount;
    });
  }
  const withShare = (rows: SoldRow[]): SoldRow[] => rows.map((r) => ({ ...r, share: total ? round2(r.revenue / total) : 0 })).sort((a, b) => b.revenue - a.revenue || b.units - a.units);
  return { items: withShare([...items.values()]), types: withShare([...types.values()]) };
}

export interface DeadRow {
  productId: string;
  variantId: string | null;
  title: string;
  type: string;
  /** Here now, as the Stock page counts it. */
  inStock: number;
  /** Stock at cost where a cost is known, else at list price. */
  value: number;
  valuedAt: 'cost' | 'price';
  /** When it last sold anywhere; '' if never. */
  lastSold: string;
  /** Units sold in the window. */
  recentUnits: number;
}

export interface DeadStockOptions {
  /** Look back over the last N events that sold something… */
  lastEvents: number;
  /** …and the last N months (for stores, which sell every day). */
  months: number;
  today?: string;
}

/**
 * Items on hand that did not sell in the last N events nor in the last N
 * months: candidates to discount, bundle or retire. Each variant on its
 * own; a product without variants as itself.
 */
export function deadStock(products: Product[], events: SalesEvent[], transactions: Transaction[], inStock: (pid: string, vid: string | null) => number, opts: DeadStockOptions): DeadRow[] {
  const today = opts.today ?? localIsoDay();
  const sales = salesByEvent(transactions);
  // The last N events that sold anything, by when they ended (or last sold).
  const past = events
    .filter((e) => !isStore(e) && (sales.get(e.id)?.length ?? 0) > 0)
    .map((e) => ({ id: e.id, when: e.dateEnd || localIsoDay(Math.max(...sales.get(e.id)!.map((t) => t.timestamp))) }))
    .filter((e) => e.when <= today)
    .sort((a, b) => b.when.localeCompare(a.when))
    .slice(0, Math.max(0, opts.lastEvents))
    .map((e) => e.id);
  const recentEvents = new Set(past);
  const since = new Date(`${today}T12:00:00`);
  since.setMonth(since.getMonth() - Math.max(0, opts.months));
  const sinceDay = localIsoDay(since);

  const lastSold = new Map<string, string>();
  const recentUnits = new Map<string, number>();
  for (const tx of transactions) {
    if (!live(tx)) continue;
    const day = localIsoDay(tx.timestamp);
    const recent = recentEvents.has(tx.eventId) || day >= sinceDay;
    for (const item of tx.items) {
      if (item.lineTotal < 0) continue;
      const key = `${item.pid}:${item.vid ?? ''}`;
      if ((lastSold.get(key) ?? '') < day) lastSold.set(key, day);
      if (recent) recentUnits.set(key, (recentUnits.get(key) ?? 0) + item.qty);
    }
  }

  const out: DeadRow[] = [];
  for (const p of products) {
    const units: { vid: string | null; title: string; cost?: number; price: number }[] = p.variants?.length
      ? p.variants.map((v) => ({ vid: v.id, title: `${p.title} · ${v.name}`, cost: v.cost ?? p.cost, price: v.price ?? p.price }))
      : [{ vid: null, title: p.title, cost: p.cost, price: p.price }];
    for (const u of units) {
      const key = `${p.id}:${u.vid ?? ''}`;
      if ((recentUnits.get(key) ?? 0) > 0) continue;
      const stock = inStock(p.id, u.vid);
      if (!(stock > 0)) continue;
      const valuedAt = typeof u.cost === 'number' && u.cost > 0 ? 'cost' : 'price';
      out.push({
        productId: p.id,
        variantId: u.vid,
        title: u.title,
        type: p.type ?? '',
        inStock: stock,
        value: round2(stock * (valuedAt === 'cost' ? u.cost! : u.price || 0)),
        valuedAt,
        lastSold: lastSold.get(key) ?? '',
        recentUnits: 0,
      });
    }
  }
  return out.sort((a, b) => b.value - a.value || a.lastSold.localeCompare(b.lastSold));
}

/** For the home card: the last event that is over, against its series' average profit per day. */
export function lastAgainstSeries(rows: RankRow[], today = localIsoDay()): { last: RankRow; seriesAvg: number | null; seriesName: string } | null {
  const over = rows.filter((r) => r.end && r.end < today).sort((a, b) => b.end.localeCompare(a.end));
  const last = over[0];
  if (!last) return null;
  const series = editionTables(rows).find((s) => s.editions.some((e) => e.eventId === last.eventId));
  const others = series?.editions.filter((e) => e.eventId !== last.eventId && e.perDay != null) ?? [];
  return { last, seriesName: series?.name ?? last.name, seriesAvg: others.length ? round2(others.reduce((s, e) => s + e.perDay!, 0) / others.length) : null };
}

/** Rows as a CSV file, one column per key. */
export function toCsv<T extends object>(headers: { key: keyof T & string; label: string }[], rows: T[]): string {
  return [headers.map((h) => csvCell(h.label)).join(','), ...rows.map((r) => headers.map((h) => csvCell((r as Record<string, unknown>)[h.key])).join(','))].join('\n');
}
