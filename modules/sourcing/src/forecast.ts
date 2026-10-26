import { conventionKey, localIsoDay, type EventStock, type SalesEvent, type Transaction } from '@zollify/shared';
import type { Dossier, Reorder } from './engine';

/**
 * Forecast - what each item sells on an average event day, and from that
 * what a set of picked events should take and what to order or make for it.
 *
 * The unit is the event day, not the calendar day: a booth sells nothing
 * between conventions, so units ÷ days the booth stood somewhere is the rate
 * worth multiplying. Stores sell on every day of the year and would drown
 * that rate, so only events count. Busy shows are not average ones: an event
 * whose earlier editions sold more per day than the average gets a size
 * factor above 1, and the user can change it. Deterministic, nothing learned.
 */

const DAY = 86400000;
/** A date range longer than this is a store-like run, not a show; count the days it sold instead. */
const MAX_RANGE_DAYS = 31;

const key = (pid: string, vid: string | null | undefined): string => `${pid}:${vid ?? ''}`;
/** A sale counts toward its variant and its product, so a product-level row covers every variant. */
const keysOf = (pid: string, vid: string | null | undefined): string[] => (vid ? [key(pid, vid), key(pid, null)] : [key(pid, null)]);

const isEvent = (e: Pick<SalesEvent, 'kind'>): boolean => (e.kind ?? 'event') === 'event';

/** Days in an event's date range, both ends counted; null without dates or for a long run. */
export function rangeDays(e: Pick<SalesEvent, 'dateStart' | 'dateEnd'>): number | null {
  const a = e.dateStart || e.dateEnd;
  const b = e.dateEnd || e.dateStart;
  if (!a || !b) return null;
  const n = Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / DAY) + 1;
  return n >= 1 && n <= MAX_RANGE_DAYS ? n : null;
}

export interface PastEvent {
  eventId: string;
  days: number;
  units: number;
}
export interface History {
  /** Event days in the window, over every event that sold something. */
  days: number;
  /** Units sold at those events. */
  units: number;
  /** Units per item key ("pid:vid", and "pid:" for the product as a whole). */
  byKey: Map<string, number>;
  events: Map<string, PastEvent>;
  /** Days of events with no stock record: every item counts for these. */
  openDays: number;
  /** Days each item was on sale at events that do have stock records; see `exposure`. */
  exposure: Map<string, number>;
}

/** The day an event's date range has for a sale: its position in the range, or among its selling days when it has no dates. */
function dayIndex(e: SalesEvent, day: string, sellingDays: string[], ranged: boolean, days: number): number {
  if (!ranged) return sellingDays.indexOf(day) + 1;
  const start = e.dateStart || e.dateEnd || day;
  const n = Math.round((Date.parse(`${day}T12:00:00`) - Date.parse(`${start}T12:00:00`)) / DAY) + 1;
  return Math.min(days, Math.max(1, n));
}

/**
 * How many days each item was on sale at one event. A product brought in
 * that sold out on day 2 of 3 was on sale for 2 days, so its day 3 is not
 * counted as zero demand. An item with no stock row at an event, that never
 * sold there, was not on sale and adds nothing.
 */
function addExposure(h: History, e: SalesEvent, days: number, ranged: boolean, sales: Transaction[], rows: EventStock[]): void {
  const sellingDays = [...new Set(sales.map((t) => localIsoDay(t.timestamp)))].sort();
  if (!rows.length) {
    h.openDays += days;
    return;
  }
  const brought = new Map<string, number>();
  for (const r of rows) {
    if (!(r.broughtQty > 0)) continue;
    brought.set(key(r.productId, r.variantId || null), (brought.get(key(r.productId, r.variantId || null)) ?? 0) + r.broughtQty);
    if (r.variantId) brought.set(key(r.productId, null), (brought.get(key(r.productId, null)) ?? 0) + r.broughtQty);
  }
  // Sold so far per key, in time order, to find the day each one ran out.
  const soldSoFar = new Map<string, number>();
  const soldOutAt = new Map<string, string>();
  const soldKeys = new Set<string>();
  for (const t of [...sales].sort((a, b) => a.timestamp - b.timestamp)) {
    const day = localIsoDay(t.timestamp);
    for (const it of t.items) {
      for (const k of keysOf(it.pid, it.vid)) {
        soldKeys.add(k);
        const n = (soldSoFar.get(k) ?? 0) + it.qty;
        soldSoFar.set(k, n);
        const b = brought.get(k) ?? 0;
        if (b > 0 && n >= b && !soldOutAt.has(k)) soldOutAt.set(k, day);
      }
    }
  }
  for (const k of new Set([...brought.keys(), ...soldKeys])) {
    if (!((brought.get(k) ?? 0) > 0) && !soldKeys.has(k)) continue;
    const out = soldOutAt.get(k);
    const onSale = out ? dayIndex(e, out, sellingDays, ranged, days) : days;
    h.exposure.set(k, (h.exposure.get(k) ?? 0) + onSale);
  }
}

/**
 * What the booth sold at events since `from`. An event's days are its date
 * range, or the days it rang up sales when it has no usable dates - a day
 * with no sales still counts when the range says the booth was there.
 * `stock` is each event's brought stock; with it, an item that sold out
 * stops counting days once it is gone.
 */
export function salesHistory(events: SalesEvent[], transactions: Transaction[], from = 0, stock: Map<string, EventStock[]> = new Map()): History {
  const shows = new Map(events.filter(isEvent).map((e) => [e.id, e]));
  const byKey = new Map<string, number>();
  const units = new Map<string, number>();
  const saleDays = new Map<string, Set<string>>();
  const sales = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.revertedAt || t.timestamp < from || !shows.has(t.eventId)) continue;
    let n = 0;
    for (const it of t.items) {
      n += it.qty;
      for (const k of keysOf(it.pid, it.vid)) byKey.set(k, (byKey.get(k) ?? 0) + it.qty);
    }
    units.set(t.eventId, (units.get(t.eventId) ?? 0) + n);
    (saleDays.get(t.eventId) ?? saleDays.set(t.eventId, new Set()).get(t.eventId)!).add(localIsoDay(t.timestamp));
    (sales.get(t.eventId) ?? sales.set(t.eventId, []).get(t.eventId)!).push(t);
  }
  const h: History = { days: 0, units: 0, byKey, events: new Map(), openDays: 0, exposure: new Map() };
  for (const [eventId, u] of units) {
    if (u <= 0) continue;
    const e = shows.get(eventId)!;
    const ranged = rangeDays(e) !== null;
    const d = rangeDays(e) ?? saleDays.get(eventId)!.size;
    h.events.set(eventId, { eventId, days: d, units: u });
    h.days += d;
    h.units += u;
    addExposure(h, e, d, ranged, sales.get(eventId) ?? [], stock.get(eventId) ?? []);
  }
  return h;
}

/** Units per day an item was on sale, for an item key. */
export function perDay(h: History, k: string): number {
  const onSale = h.openDays + (h.exposure.get(k) ?? 0);
  return onSale > 0 ? (h.byKey.get(k) ?? 0) / onSale : 0;
}

/** The earlier editions of an event: same series, else the same name minus the year. */
export function earlierEditions(ev: SalesEvent, events: SalesEvent[]): SalesEvent[] {
  const name = conventionKey(ev.name);
  const start = ev.dateStart || ev.dateEnd || '';
  return events.filter((o) => {
    if (o.id === ev.id || !isEvent(o)) return false;
    const same = ev.seriesId ? o.seriesId === ev.seriesId : !!name && conventionKey(o.name) === name;
    const oStart = o.dateStart || o.dateEnd || '';
    return same && (!start || !oStart || oStart < start);
  });
}

export interface SizeFactor {
  factor: number;
  /** How many earlier editions it came from; 0 means the default of 1. */
  editions: number;
}
/**
 * How busy an event is against the average: units per day at its earlier
 * editions over units per day at every event. All-time history, because
 * editions are a year apart and a short window would miss them.
 */
export function sizeFactor(ev: SalesEvent, events: SalesEvent[], allTime: History): SizeFactor {
  const avg = allTime.days > 0 ? allTime.units / allTime.days : 0;
  let days = 0;
  let units = 0;
  let n = 0;
  for (const o of earlierEditions(ev, events)) {
    const p = allTime.events.get(o.id);
    if (!p) continue;
    days += p.days;
    units += p.units;
    n++;
  }
  if (!n || !days || !avg) return { factor: 1, editions: 0 };
  return { factor: Math.round((units / days / avg) * 100) / 100, editions: n };
}

/** Events still to come that sell: not stores, not closed, not over. */
export function upcomingEvents(events: SalesEvent[], today = localIsoDay()): SalesEvent[] {
  const startOf = (e: SalesEvent): string => e.dateStart || e.dateEnd || '9999';
  return events
    .filter((e) => isEvent(e) && e.status !== 'closed' && !e.deletedAt && (e.dateEnd || e.dateStart || '9999') >= today)
    .sort((a, b) => startOf(a).localeCompare(startOf(b)) || a.name.localeCompare(b.name));
}

export interface ForecastItem {
  /** "pid:vid", or "pid:" for a whole product. */
  key: string;
  pid: string;
  vid: string;
  title: string;
  dossier: Dossier | null;
}

/**
 * The rows to forecast: a product with a product-level dossier is one row
 * (that dossier orders for all its variants), otherwise one row per variant,
 * each with its own dossier when it has one.
 */
export function forecastItems(products: { id: string; title: string; variants: { id: string; name: string }[] }[], dossiers: Dossier[]): ForecastItem[] {
  const byKey = new Map(dossiers.filter((d) => d.pid).map((d) => [key(d.pid!, d.vid), d]));
  const out: ForecastItem[] = [];
  for (const p of products) {
    const whole = byKey.get(key(p.id, null));
    if (whole || !p.variants.length) {
      out.push({ key: key(p.id, null), pid: p.id, vid: '', title: p.title, dossier: whole ?? null });
      continue;
    }
    for (const v of p.variants) out.push({ key: key(p.id, v.id), pid: p.id, vid: v.id, title: `${p.title} · ${v.name}`, dossier: byKey.get(key(p.id, v.id)) ?? null });
  }
  return out;
}

/** Units on order per dossier: every reorder not yet received, drafts too, so nothing is ordered twice. */
export function incomingByDossier(reorders: Reorder[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of reorders) {
    if (r.status === 'received') continue;
    for (const l of r.lines) out.set(l.dossierId, (out.get(l.dossierId) ?? 0) + (l.qty || 0));
  }
  return out;
}

export interface PlannedEvent {
  eventId: string;
  name: string;
  days: number;
  factor: number;
}
export interface ForecastRow extends ForecastItem {
  perDay: number;
  /** Units sold at events in the window. */
  sold: number;
  /** Expected units across the picked events. */
  expected: number;
  /** Per picked event, in the order given. */
  perEvent: number[];
  onHand: number;
  incoming: number;
  moq: number;
  /** What to order or make: expected plus buffer, less what is here and on its way, up to the MOQ. */
  suggestQty: number;
}

/** Rounds a need up to the MOQ; nothing needed stays nothing. */
export function toMoq(need: number, moq: number): number {
  return moq && need > 0 ? Math.max(need, moq) : need;
}

export function forecast(
  items: ForecastItem[],
  history: History,
  planned: PlannedEvent[],
  opts: { bufferPct: number; onHand: (pid: string, vid: string) => number; incoming: Map<string, number> },
): ForecastRow[] {
  return items.map((it) => {
    const rate = perDay(history, it.key);
    const perEvent = planned.map((e) => rate * Math.max(0, e.days) * Math.max(0, e.factor));
    const expected = perEvent.reduce((a, b) => a + b, 0);
    const onHand = opts.onHand(it.pid, it.vid);
    const incoming = it.dossier ? (opts.incoming.get(it.dossier.id) ?? 0) : 0;
    const moq = parseInt(it.dossier?.specs.moq ?? '') || 0;
    const need = Math.max(0, Math.ceil(expected * (1 + Math.max(0, opts.bufferPct) / 100) - 1e-9) - onHand - incoming);
    return {
      ...it,
      perDay: rate,
      sold: history.byKey.get(it.key) ?? 0,
      expected,
      perEvent,
      onHand,
      incoming,
      moq,
      suggestQty: toMoq(need, moq),
    };
  });
}
