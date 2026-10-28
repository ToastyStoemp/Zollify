import { priceRows, symbolFor } from './price-rows';
import type { DiscountRule, EventStock, Product, SalesEvent } from './types';

/**
 * What's on the table: the public menu a customer opens from the QR on the
 * booth. Pure over what the account holds, so the server and a test agree
 * on it. The event is the open one (ongoing today first); what it claimed
 * is what is on the table, priced as the booth charges there (its local
 * currency, rounding and overrides). An open event with no claims, or no
 * open event at all, shows the whole catalogue instead, so the QR printed
 * once keeps working. Only what is for sale and listed appears, and never
 * stock, costs or what sold - a menu, not a window into the books.
 */

export interface TableMenuLine {
  variantId: string;
  name: string;
  /** The price as shown, e.g. "€25" or "250 kr". */
  text: string;
  amount: number;
  /** "3 for €60 · 5 for €90" from a tiered deal, else ''. */
  deal: string;
}

export interface TableMenuItem {
  id: string;
  title: string;
  type: string;
  imageId: string;
  /** One line per variant; a product without variants has one line with an empty name. */
  lines: TableMenuLine[];
}

export interface TableMenuGroup {
  /** The product type; '' for untyped products, listed last. */
  type: string;
  items: TableMenuItem[];
}

export interface TableMenu {
  event: { id: string; name: string; start: string; end: string; hall: string; booth: string } | null;
  /** 'table' when the event's claims decide what is listed; 'catalogue' when everything for sale is. */
  scope: 'table' | 'catalogue';
  currency: string;
  groups: TableMenuGroup[];
  /** Items listed. */
  count: number;
}

export interface TableMenuInput {
  events: SalesEvent[];
  products: Product[];
  discounts: DiscountRule[];
  stock: EventStock[];
  /** The catalogue's own currency, for when no event decides. */
  currency: string;
  /** YYYY-MM-DD. */
  today: string;
}

/** The open event the menu is for: one running today first, else the open one that started last. */
export function tableEvent(events: SalesEvent[], today: string): SalesEvent | null {
  const open = events.filter((e) => !e.deletedAt && !e.test && e.kind !== 'store' && e.status === 'active');
  const ongoing = open.filter((e) => {
    const start = e.dateStart || e.dateEnd;
    const end = e.dateEnd || e.dateStart;
    return start && end && start <= today && end >= today;
  });
  const pick = (list: SalesEvent[]) => [...list].sort((a, b) => (b.dateStart ?? '').localeCompare(a.dateStart ?? '') || b.updatedAt - a.updatedAt)[0] ?? null;
  return pick(ongoing) ?? pick(open);
}

export function tableMenu(input: TableMenuInput): TableMenu {
  const ev = tableEvent(input.events, input.today);
  const local = ev?.localCurrency && ev.localCurrency !== ev.currency ? ev.localCurrency : null;
  const currency = (local ?? ev?.currency ?? input.currency ?? 'EUR').toUpperCase();
  const rounding = local ? ev?.roundingIncrement ?? 0 : 0;
  const feed = priceRows(input.products, { currency, exchangeRate: local ? ev?.exchangeRate : 1, rounding }, input.discounts);
  const rowByKey = new Map(feed.rows.map((r) => [`${r.id}:${r.variantId}`, r]));

  // A local price the booth typed over the converted one, formatted the way the feed does.
  const sym = symbolFor(currency);
  const trails = /^(kr|zł|Kč)$/.test(sym.trim());
  const money = (v: number): string => {
    const num = v.toFixed(rounding >= 1 ? 0 : 2);
    return trails ? `${num} ${sym.trim()}` : `${sym}${num}`;
  };
  const overrides = local ? ev?.localPriceOverrides ?? {} : {};

  const claimed = new Set<string>();
  if (ev) for (const s of input.stock) if (s.eventId === ev.id && s.broughtQty > 0) claimed.add(`${s.productId}:${s.variantId}`);
  const scope: TableMenu['scope'] = claimed.size ? 'table' : 'catalogue';

  const groups = new Map<string, TableMenuGroup>();
  let count = 0;
  const products = [...input.products].filter((p) => !p.deletedAt && p.forSale !== false && !p.unlisted).sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
  for (const p of products) {
    const variants = (p.variants ?? []).filter((v) => !v.unlisted);
    const lines: TableMenuLine[] = [];
    for (const v of variants.length ? variants : [null]) {
      const variantId = v?.id ?? '';
      const key = `${p.id}:${variantId}`;
      if (scope === 'table' && !claimed.has(key)) continue;
      const row = rowByKey.get(key);
      if (!row) continue;
      const over = overrides[variantId ? key : p.id];
      const amount = typeof over === 'number' && over >= 0 ? over : row.amount;
      const deal = row.tiers
        .filter((t) => t.qty > 1)
        .map((t) => t.text)
        .join(' · ');
      lines.push({ variantId, name: v?.name ?? '', text: typeof over === 'number' && over >= 0 ? money(over) : row.text, amount, deal });
    }
    if (!lines.length) continue;
    const type = (p.type ?? '').trim();
    const g = groups.get(type) ?? { type, items: [] };
    g.items.push({ id: p.id, title: p.title, type, imageId: p.imageId ?? variants.find((v) => v.imageId)?.imageId ?? '', lines });
    groups.set(type, g);
    count += 1;
  }
  const ordered = [...groups.values()].sort((a, b) => (a.type === '' ? 1 : b.type === '' ? -1 : a.type.localeCompare(b.type)));
  return {
    event: ev ? { id: ev.id, name: ev.name, start: ev.dateStart ?? '', end: ev.dateEnd ?? ev.dateStart ?? '', hall: ev.booth?.hall ?? '', booth: ev.booth?.number ?? '' } : null,
    scope,
    currency,
    groups: ordered,
    count,
  };
}
