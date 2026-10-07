import { z } from 'zod';
import { safeHttpUrl } from './csv';
import type { EventOverlay } from './public-events';
import type { EventBooth, SalesEvent } from './types';

/**
 * Where the booth stands at an event: hall, stand number, the convention's
 * page and a short note. It lives on the event record (SalesEvent.booth) so
 * everything that talks about the event - the public page, receipts, the
 * planner - reads one source. Public events used to keep these in its own
 * per-event overlay; `resolveBooth` falls back to that until it is migrated.
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

export interface ResolvedBooth {
  hall: string;
  number: string;
  link: string;
  note: string;
}

/**
 * The booth facts to publish. The event's own field wins; the legacy overlay
 * value fills in only where the event field is empty, field by field.
 */
export function resolveBooth(
  event: Pick<SalesEvent, 'booth'>,
  overlay: Partial<Pick<EventOverlay, 'hall' | 'booth' | 'link' | 'blurb'>> = {},
): ResolvedBooth {
  const own = cleanBooth(event.booth) ?? {};
  return {
    hall: own.hall ?? (overlay.hall ?? '').trim(),
    number: own.number ?? (overlay.booth ?? '').trim(),
    link: own.link ?? safeHttpUrl(overlay.link),
    note: own.note ?? (overlay.blurb ?? '').trim(),
  };
}

/** What a legacy overlay holds, as booth fields (empty ones omitted). */
export function boothFromOverlay(overlay: Partial<EventOverlay> | undefined): EventBooth | undefined {
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
  overlays: Record<string, Partial<EventOverlay>>,
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
