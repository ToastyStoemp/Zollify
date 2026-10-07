import { z } from 'zod';
import { safeHttpUrl } from './csv';
import { sanitizeBoothLayout, type BoothLayout } from './booth-layout';
import type { StoredEventOverlay } from './public-events';
import type { EventBooth, SalesEvent } from './types';

/**
 * Where the booth stands at an event: hall, stand number, the convention's
 * page and a short note. It lives on the event record (SalesEvent.booth) so
 * everything that talks about the event - the public page, receipts, the
 * planner - reads one source. Public events used to keep these in its own
 * per-event overlay; the server moves them onto the event and clears them from
 * the overlay at startup (see `planBoothCleanup`).
 *
 * Pure functions, shared by the app form, the migration and the server.
 */

export const BOOTH_LIMITS = { hall: 40, number: 40, link: 500, note: 400 } as const;

/** Only https links leave: the public page renders them as clickable hrefs. */
export function safeHttpsUrl(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  try {
    return new URL(s).protocol === 'https:' ? s : '';
  } catch {
    return '';
  }
}

export const EventBoothSchema = z.object({
  hall: z.string().trim().max(BOOTH_LIMITS.hall).optional(),
  number: z.string().trim().max(BOOTH_LIMITS.number).optional(),
  link: z.string().trim().max(BOOTH_LIMITS.link).refine((v) => !v || !!safeHttpsUrl(v), 'Links must start with https://').optional(),
  note: z.string().trim().max(BOOTH_LIMITS.note).optional(),
});

const BOOTH_KEYS = ['hall', 'number', 'link', 'note'] as const;

/**
 * Tidies whatever an event carries into a valid booth, dropping empty fields,
 * over-long text and non-https links; undefined when nothing is left. Events
 * arrive from any device, so readers run this rather than trusting the shape.
 */
export function cleanBooth(raw: unknown): EventBooth | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as Record<string, unknown>;
  const out: EventBooth = {};
  for (const key of BOOTH_KEYS) {
    const v = typeof src[key] === 'string' ? (src[key] as string).trim() : '';
    if (!v || v.length > BOOTH_LIMITS[key]) continue;
    if (key === 'link' && !safeHttpsUrl(v)) continue;
    out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * What Duplicate carries from an event's booth section to the copy: the booth
 * details, the layout (validated and deep-copied, as "Use layout from" does)
 * and noPool, so a private event's copy stays private. A store has no booth
 * section, so nothing comes along.
 */
export function boothFieldsForDuplicate(
  source: Pick<SalesEvent, 'kind' | 'booth' | 'boothLayout' | 'noPool'>,
  now: number = Date.now(),
): { booth?: EventBooth; boothLayout?: BoothLayout; noPool?: true } {
  if (source.kind === 'store') return {};
  const layout = sanitizeBoothLayout(source.boothLayout);
  return {
    booth: cleanBooth(source.booth),
    boothLayout: layout ? { ...layout, importedAt: now } : undefined,
    noPool: source.noPool ? true : undefined,
  };
}

export interface ResolvedBooth {
  hall: string;
  number: string;
  link: string;
  note: string;
}

/**
 * The booth facts to publish: the event's own, nothing else. A field the user
 * clears stays cleared because the legacy overlay is no longer consulted.
 * (A legacy overlay link that is not https cannot be carried onto the event
 * and is not published either.)
 */
export function resolveBooth(event: Pick<SalesEvent, 'booth'>): ResolvedBooth {
  const own = cleanBooth(event.booth) ?? {};
  return { hall: own.hall ?? '', number: own.number ?? '', link: own.link ?? '', note: own.note ?? '' };
}

/** What a legacy overlay holds, as booth fields (empty ones omitted). */
export function boothFromOverlay(overlay: Partial<StoredEventOverlay> | undefined): EventBooth | undefined {
  if (!overlay) return undefined;
  return cleanBooth({ hall: overlay.hall, number: overlay.booth, link: overlay.link, note: overlay.blurb });
}

/**
 * One-time move of legacy overlay booth facts onto their events. Returns only
 * the events that change: each empty booth field is filled from the overlay,
 * a field already set on the event is never touched, and a second run over the
 * result returns nothing. The overlay itself is left alone (an older client
 * still reads it), so this never has to write to it.
 */
export function eventsToMigrateBooth(
  events: SalesEvent[],
  overlays: Record<string, Partial<StoredEventOverlay>>,
): SalesEvent[] {
  const out: SalesEvent[] = [];
  for (const e of events) {
    if (e.deletedAt) continue;
    const legacy = boothFromOverlay(overlays[e.id]);
    if (!legacy) continue;
    const own = cleanBooth(e.booth) ?? {};
    const merged: EventBooth = { ...own };
    for (const key of BOOTH_KEYS) if (!own[key] && legacy[key]) merged[key] = legacy[key];
    if (BOOTH_KEYS.every((k) => merged[k] === own[k])) continue;
    out.push({ ...e, booth: merged });
  }
  return out;
}

/** Overlay key -> the booth field it moved to. */
const OVERLAY_TO_BOOTH = { hall: 'hall', booth: 'number', link: 'link', blurb: 'note' } as const;

export interface BoothCleanupPlan {
  /** Events to write back: empty booth fields filled from the overlay. */
  events: SalesEvent[];
  /** Overlay rows to rewrite (only those that change), legacy keys removed. */
  overlays: Record<string, Partial<StoredEventOverlay>>;
}

/**
 * Per field: an overlay value is copied onto the event when the event's field
 * is empty, and removed from the overlay once the event's own field is set (or
 * when the overlay value is blank). A value that cannot be carried (an http
 * link, say) stays in the overlay untouched, so nothing is lost. Overlays of
 * unknown or deleted events are left alone. The publishing fields are never
 * touched, and a second run over the result plans nothing.
 */
export function planBoothCleanup(
  events: SalesEvent[],
  overlays: Record<string, Partial<StoredEventOverlay>>,
): BoothCleanupPlan {
  const changed = eventsToMigrateBooth(events, overlays);
  const after = new Map(events.map((e) => [e.id, e]));
  for (const e of changed) after.set(e.id, e);
  const rows: Record<string, Partial<StoredEventOverlay>> = {};
  for (const [id, row] of Object.entries(overlays)) {
    const event = after.get(id);
    if (!event || event.deletedAt) continue;
    const own = cleanBooth(event.booth) ?? {};
    const next: Record<string, unknown> = { ...row };
    for (const key of Object.keys(OVERLAY_TO_BOOTH) as (keyof typeof OVERLAY_TO_BOOTH)[]) {
      if (!(key in row)) continue;
      const blank = typeof row[key] !== 'string' || !row[key]!.trim();
      if (blank || own[OVERLAY_TO_BOOTH[key]]) delete next[key];
    }
    if (Object.keys(next).length !== Object.keys(row).length) rows[id] = next as Partial<StoredEventOverlay>;
  }
  return { events: changed, overlays: rows };
}
