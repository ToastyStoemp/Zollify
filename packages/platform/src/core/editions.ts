import type { SalesEvent } from '@zollify/shared';
import {
  capToFree,
  editionLabelOf,
  planClaims,
  planKey,
  seriesEditions,
  type ClaimGrant,
  type PlanEdition,
  type PlanOptions,
  type PlanRow,
} from '@zollify/shared';
import { allProducts } from './catalog';
import { claimFor, claimsForEvent, eventIsOver, freeFor, setClaim } from './inventory';
import { eventPricing, getSalesEvent, upsertSalesEvent, visibleEvents } from './sales-events';
import { recentTransactions } from './transactions';

/**
 * Editions: events that are the same convention in different years or
 * seasons, linked by a shared `seriesId`. An event with no series is a
 * one-off and behaves exactly as before.
 */

/** The other editions of an event's series, oldest first - and the event itself. */
export function editionsOf(eventId: string): SalesEvent[] {
  const event = getSalesEvent(eventId);
  return seriesEditions(visibleEvents.value, event?.seriesId);
}

export interface NextEditionInput {
  /** Label for the new edition, e.g. "Spring 2027". */
  label: string;
  dateStart?: string;
  dateEnd?: string;
  /** 'same' starts the new edition with the source's claims; 'none' starts it empty. */
  stock: 'none' | 'same';
}

/**
 * Copies an event as the next edition of its series: venue, currency, local
 * pricing, VAT and notes come along; dates and label are new. Per-event
 * paperwork (customs) and attached files stay with the edition they belong to.
 * The source joins a series if it was a one-off, labelled by its start year
 * when it had no label. Returns the new event.
 */
export async function createNextEdition(sourceId: string, input: NextEditionInput): Promise<SalesEvent> {
  const source = getSalesEvent(sourceId);
  if (!source) throw new Error('That event no longer exists.');
  const label = input.label.trim();
  if (!label) throw new Error('Give the new edition a label, like "2027" or "Spring 2027".');

  const seriesId = source.seriesId ?? crypto.randomUUID();
  const sourceLabel = editionLabelOf(source);
  if (source.seriesId !== seriesId || (!source.edition && sourceLabel)) {
    await upsertSalesEvent({ ...source, seriesId, edition: source.edition || sourceLabel || undefined });
  }

  const next: SalesEvent = {
    id: crypto.randomUUID(),
    name: source.name,
    kind: source.kind,
    dateStart: input.dateStart || undefined,
    dateEnd: input.dateEnd || undefined,
    venue: { ...source.venue },
    currency: source.currency,
    ...eventPricing(source),
    vat: source.vat ? { ...source.vat } : undefined,
    notes: source.notes,
    seriesId,
    edition: label,
    status: 'planned',
    updatedAt: Date.now(),
  };
  await upsertSalesEvent(next);
  if (input.stock === 'same') {
    for (const row of claimsForEvent(sourceId)) await setClaim(next.id, row.productId, row.variantId, row.broughtQty);
  }
  return next;
}

/**
 * Makes `eventId` an edition of the same series as `otherId` (starting one if
 * `other` was a one-off). `label` defaults to the event's start year.
 */
export async function linkToSeries(eventId: string, otherId: string, label?: string): Promise<void> {
  const event = getSalesEvent(eventId);
  const other = getSalesEvent(otherId);
  if (!event || !other) throw new Error('That event no longer exists.');
  if (event.id === other.id) throw new Error('Pick a different event to link to.');
  const seriesId = other.seriesId ?? crypto.randomUUID();
  if (!other.seriesId) await upsertSalesEvent({ ...other, seriesId, edition: other.edition || editionLabelOf(other) || undefined });
  await upsertSalesEvent({ ...event, seriesId, edition: label?.trim() || event.edition || editionLabelOf(event) || undefined });
}

/** Takes an event out of its series; the other editions keep theirs. */
export async function unlinkFromSeries(eventId: string): Promise<void> {
  const event = getSalesEvent(eventId);
  if (!event) return;
  const { seriesId: _s, edition: _e, ...rest } = event;
  await upsertSalesEvent(rest);
}

/** Renames an edition. */
export async function setEditionLabel(eventId: string, label: string): Promise<void> {
  const event = getSalesEvent(eventId);
  if (!event) throw new Error('That event no longer exists.');
  await upsertSalesEvent({ ...event, edition: label.trim() || undefined });
}

const dateKey = (e: SalesEvent): string => e.dateStart || e.dateEnd || '';

/** Earlier editions of this event's series: before it by date, or over when either has no dates. */
function earlierEditions(event: SalesEvent): SalesEvent[] {
  return editionsOf(event.id).filter((e) => {
    if (e.id === event.id) return false;
    const a = dateKey(e);
    const b = dateKey(event);
    return a && b ? a < b : eventIsOver(e);
  });
}

/** The earlier editions with recorded sales, as the planner's input. */
export function planEditionsFor(eventId: string): PlanEdition[] {
  const event = getSalesEvent(eventId);
  if (!event) return [];
  const past = earlierEditions(event);
  const byEvent = new Map<string, PlanEdition>();
  for (const e of past) {
    const claims: Record<string, number> = {};
    for (const c of claimsForEvent(e.id)) claims[planKey(c.productId, c.variantId)] = c.broughtQty;
    byEvent.set(e.id, { eventId: e.id, label: editionLabelOf(e) || e.name, claims, sales: [] });
  }
  for (const tx of recentTransactions.value) {
    const ed = byEvent.get(tx.eventId);
    if (!ed || tx.revertedAt) continue;
    ed.sales.push({
      at: tx.timestamp,
      items: tx.items.map((i) => ({ productId: i.pid, variantId: i.vid, qty: i.qty, revenue: i.baseLineTotal ?? i.lineTotal })),
    });
  }
  // Editions that never sold anything say nothing about demand.
  return [...byEvent.values()].filter((e) => e.sales.length > 0);
}

export interface PlannerRow extends PlanRow {
  label: string;
  /** What this event could claim of it: free stock plus its own current claim. */
  claimable: number;
  /** This event's current claim, or null. */
  current: number | null;
}

/** Items still in the catalogue, with names - what can actually be claimed. */
export function prepPlanFor(eventId: string, opts: PlanOptions): PlannerRow[] {
  const labels = new Map<string, string>();
  for (const p of allProducts.value) {
    if (!p.variants?.length) labels.set(planKey(p.id, ''), p.title);
    for (const v of p.variants ?? []) labels.set(planKey(p.id, v.id), `${p.title} · ${v.name}`);
  }
  const event = getSalesEvent(eventId);
  const reserving = event ? !eventIsOver(event) : false;
  return planClaims(planEditionsFor(eventId), opts)
    .filter((r) => labels.has(r.key))
    .map((r) => {
      const current = claimFor(eventId, r.productId, r.variantId);
      // freeFor already subtracts this event's own claim while it reserves, so add it back.
      const claimable = freeFor(r.productId, r.variantId) + (reserving && current !== null ? current : 0);
      return { ...r, label: labels.get(r.key)!, claimable: Math.max(0, claimable), current };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** What applying the plan would claim, capped at free stock. */
export function grantsFor(rows: PlannerRow[]): ClaimGrant[] {
  const free: Record<string, number> = {};
  for (const r of rows) free[r.key] = r.claimable;
  return capToFree(rows, free);
}

/** Writes the capped suggestions as this event's claims. Returns the grants applied. */
export async function applyPrepPlan(eventId: string, rows: PlannerRow[]): Promise<ClaimGrant[]> {
  const grants = grantsFor(rows);
  for (const g of grants) await setClaim(eventId, g.productId, g.variantId, g.granted);
  return grants;
}
