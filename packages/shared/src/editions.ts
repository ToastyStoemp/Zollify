/**
 * Editions of one convention, and the prep planner built on them.
 *
 * Events that share a `seriesId` are editions of the same show - next year's
 * Comic Con, or its fall run after the spring one. Before the next edition the
 * planner looks at what sold at the earlier ones, against what was claimed,
 * and suggests what to claim. Deterministic and deliberately simple: an
 * average or the best of the past editions plus a buffer, nothing learned.
 */
import type { SalesEvent } from './types';

const SEASONS = ['spring', 'summer', 'fall', 'autumn', 'winter'] as const;
const OTHER_SEASON: Record<string, string> = { spring: 'Fall', fall: 'Spring', autumn: 'Spring', summer: 'Winter', winter: 'Summer' };
const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

const yearOf = (date: string | undefined): number | null => {
  const m = date?.match(/\b(?:19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
};

/** The edition label an event reads as: its own, else the year of its start. */
export function editionLabelOf(event: Pick<SalesEvent, 'edition' | 'dateStart' | 'dateEnd'>): string {
  const own = event.edition?.trim();
  if (own) return own;
  const y = yearOf(event.dateStart ?? event.dateEnd);
  return y ? String(y) : '';
}

/**
 * Labels worth offering for the next edition, best first. A season in the
 * source label is kept and moved to the new year ("Spring 2026" -> "Spring
 * 2027"), with the opposite season of the same year as the second choice
 * ("Fall 2026"). A plain year just moves on. `nextStart` is the new start
 * date when the user already picked one.
 */
export function suggestEditionLabels(source: Pick<SalesEvent, 'edition' | 'dateStart' | 'dateEnd'>, nextStart?: string): string[] {
  const label = editionLabelOf(source);
  const sourceYear = yearOf(label) ?? yearOf(source.dateStart ?? source.dateEnd);
  const year = yearOf(nextStart) ?? (sourceYear ? sourceYear + 1 : null);
  const season = SEASONS.find((s) => new RegExp(`\\b${s}\\b`, 'i').test(label));
  const suffix = year ? ` ${year}` : '';
  if (season) {
    const same = `${cap(season)}${suffix}`.trim();
    const other = `${OTHER_SEASON[season]}${sourceYear ? ` ${yearOf(nextStart) ?? sourceYear}` : ''}`.trim();
    return other === same ? [same] : [same, other];
  }
  return year ? [String(year)] : [];
}

const dateKey = (e: Pick<SalesEvent, 'dateStart' | 'dateEnd'>): string => e.dateStart || e.dateEnd || '';

/** Every edition of a series, oldest first (undated ones last). */
export function seriesEditions<T extends Pick<SalesEvent, 'seriesId' | 'dateStart' | 'dateEnd' | 'name'>>(events: T[], seriesId: string | undefined): T[] {
  if (!seriesId) return [];
  return events
    .filter((e) => e.seriesId === seriesId)
    .sort((a, b) => (dateKey(a) || '￿').localeCompare(dateKey(b) || '￿') || a.name.localeCompare(b.name));
}

// ── Planner ─────────────────────────────────────────────────────────────────

export interface PlanSale {
  /** When it was rung up, ms. */
  at: number;
  items: { productId: string; variantId: string | null; qty: number; revenue: number }[];
}
export interface PlanEdition {
  eventId: string;
  label: string;
  /** What the edition claimed, per `productId:variantId`; absent = no claim on that item. */
  claims: Record<string, number>;
  /** Its sales, reverted ones already left out. */
  sales: PlanSale[];
}
export interface PlanOptions {
  /** Extra on top of the base figure, percent. */
  bufferPct: number;
  /** 'average' of the editions that sold the item, or the 'max' of them. */
  basis: 'average' | 'max';
}
export interface EditionStat {
  eventId: string;
  label: string;
  units: number;
  revenue: number;
  /** Null when the edition claimed nothing of this item (it sold from the shared pool). */
  claimed: number | null;
  /** Units over claimed, 0..1+; null without a claim. */
  sellThrough: number | null;
  soldOut: boolean;
  /** When the last unit of the claim went, ms; set only when soldOut. */
  soldOutAt?: number;
}
export interface PlanRow {
  key: string;
  productId: string;
  variantId: string;
  editions: EditionStat[];
  /** Units to claim next time. */
  suggested: number;
  /** Some earlier edition ran out, so past sales understate demand. */
  underClaimed: boolean;
}

export const planKey = (productId: string, variantId: string | null | undefined): string => `${productId}:${variantId ?? ''}`;

/** Per item, what each earlier edition sold and claimed, and a suggested claim. Editions are given oldest first. */
export function planClaims(editions: PlanEdition[], opts: PlanOptions): PlanRow[] {
  const buffer = Math.max(0, opts.bufferPct) / 100;
  const keys = new Set<string>();
  for (const ed of editions) {
    for (const k of Object.keys(ed.claims)) keys.add(k);
    for (const s of ed.sales) for (const i of s.items) keys.add(planKey(i.productId, i.variantId));
  }

  const rows: PlanRow[] = [];
  for (const key of keys) {
    const [productId = '', variantId = ''] = key.split(':');
    const stats: EditionStat[] = [];
    for (const ed of editions) {
      const sales = [...ed.sales].sort((a, b) => a.at - b.at);
      let units = 0;
      let revenue = 0;
      const claimed = key in ed.claims ? ed.claims[key]! : null;
      let soldOutAt: number | undefined;
      for (const s of sales) {
        for (const i of s.items) {
          if (planKey(i.productId, i.variantId) !== key) continue;
          units += i.qty;
          revenue += i.revenue;
          if (soldOutAt === undefined && claimed !== null && claimed > 0 && units >= claimed) soldOutAt = s.at;
        }
      }
      if (units === 0 && claimed === null) continue;
      stats.push({
        eventId: ed.eventId,
        label: ed.label,
        units,
        revenue,
        claimed,
        sellThrough: claimed === null ? null : claimed > 0 ? units / claimed : units > 0 ? 1 : 0,
        soldOut: soldOutAt !== undefined,
        ...(soldOutAt !== undefined ? { soldOutAt } : {}),
      });
    }
    if (!stats.length) continue;
    const sold = stats.map((s) => s.units);
    const base = opts.basis === 'max' ? Math.max(...sold) : sold.reduce((a, b) => a + b, 0) / sold.length;
    rows.push({
      key,
      productId,
      variantId,
      editions: stats,
      suggested: Math.ceil(base * (1 + buffer)),
      underClaimed: stats.some((s) => s.soldOut),
    });
  }
  return rows;
}

export interface ClaimGrant {
  key: string;
  productId: string;
  variantId: string;
  wanted: number;
  /** What can actually be claimed given the stock free for this event. */
  granted: number;
  short: number;
}

/** Caps each suggestion at what is free; `free` maps `productId:variantId` to claimable units (missing = 0). */
export function capToFree(rows: Pick<PlanRow, 'key' | 'productId' | 'variantId' | 'suggested'>[], free: Record<string, number>): ClaimGrant[] {
  return rows.map((r) => {
    const granted = Math.max(0, Math.min(r.suggested, Math.floor(free[r.key] ?? 0)));
    return { key: r.key, productId: r.productId, variantId: r.variantId, wanted: r.suggested, granted, short: r.suggested - granted };
  });
}
