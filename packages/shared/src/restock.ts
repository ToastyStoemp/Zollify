/**
 * How much of each item an artist should send a store, from how fast it has
 * been selling there. A forecast to decide with, not an order: it looks at
 * the last weeks of sales, what is left on the shelf and what is already on
 * its way, and suggests enough to last the chosen number of weeks.
 */

export interface RestockItem {
  productId: string;
  variantId: string;
  /** What the store has left; null when it never counted it. */
  remaining: number | null;
}
export interface RestockSale {
  productId: string;
  /** Null or '' for a product without variants. */
  variantId: string | null;
  qty: number;
  /** When it sold, ms. */
  at: number;
}
export interface RestockOptions {
  /** How many weeks the shelf should last after the package arrives. */
  weeks: number;
  now?: number;
  /** How far back sales count, days. Older sales say little about now. */
  windowDays?: number;
  /** Never judge a rate from fewer days than this - a lucky first weekend is not a trend. */
  minDays?: number;
  /** Already sent and not yet confirmed, per `productId:variantId`. */
  inTransit?: Record<string, number>;
}
export interface RestockRow {
  key: string;
  productId: string;
  variantId: string;
  /** Sold in the window. */
  sold: number;
  /** Sold per week, from the window. */
  perWeek: number;
  /** On the shelf now, or null when uncounted. */
  left: number | null;
  inTransit: number;
  /** How long what is there (and on its way) lasts at that pace; null when it is not selling. */
  weeksLeft: number | null;
  /** Units to send so it lasts `weeks`; 0 when it already does or nothing sells. */
  suggest: number;
}

const DAY = 86_400_000;

export function restockForecast(items: RestockItem[], sales: RestockSale[], opts: RestockOptions): RestockRow[] {
  const now = opts.now ?? Date.now();
  const windowDays = opts.windowDays ?? 56;
  const minDays = opts.minDays ?? 14;
  const since = now - windowDays * DAY;
  const keyOf = (productId: string, variantId: string | null | undefined): string => `${productId}:${variantId ?? ''}`;

  const sold = new Map<string, { qty: number; first: number }>();
  /** Items that sold before the window too: judged over the whole window. */
  const older = new Set<string>();
  for (const s of sales) {
    if (s.at < since && s.qty > 0) older.add(keyOf(s.productId, s.variantId));
    if (s.at < since || s.at > now || s.qty <= 0) continue;
    const k = keyOf(s.productId, s.variantId);
    const cur = sold.get(k);
    sold.set(k, { qty: (cur?.qty ?? 0) + s.qty, first: Math.min(cur?.first ?? s.at, s.at) });
  }

  return items.map((i) => {
    const key = keyOf(i.productId, i.variantId);
    const hit = sold.get(key);
    // A newer item is judged over the days it has been selling, not the whole window.
    const days = hit && !older.has(key) ? Math.min(windowDays, Math.max(minDays, (now - hit.first) / DAY)) : windowDays;
    const perWeek = hit ? (hit.qty / days) * 7 : 0;
    const inTransit = opts.inTransit?.[key] ?? 0;
    const have = Math.max(0, i.remaining ?? 0) + inTransit;
    const need = Math.ceil(perWeek * opts.weeks);
    return {
      key,
      productId: i.productId,
      variantId: i.variantId,
      sold: hit?.qty ?? 0,
      perWeek: Math.round(perWeek * 10) / 10,
      left: i.remaining,
      inTransit,
      weeksLeft: perWeek > 0 ? Math.round((have / perWeek) * 10) / 10 : null,
      suggest: Math.max(0, need - have),
    };
  });
}
