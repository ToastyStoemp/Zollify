import type { EventStock, SalesEvent } from './types';

/**
 * Sell 🔒. Once another event has taken over what this one had left (Claim
 * leftovers) and that event has opened, the leftovers are physically there:
 * anything this event still sold would come out of the next one's box, and
 * neither event's stock would add up. So the till stops selling at this
 * event. An owner or admin can force it open again, but only when the account
 * allows that (Events → Sell lock); it is off by default.
 */

export interface SellLockSettings {
  /** Owners and admins may force sales at a locked event. */
  allowForce: boolean;
}

export const SELL_LOCK_DEFAULTS: SellLockSettings = { allowForce: false };

export function cleanSellLockSettings(v: unknown): SellLockSettings {
  const src = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { allowForce: src.allowForce === true };
}

type LockEvent = Pick<SalesEvent, 'id' | 'name' | 'status' | 'deletedAt' | 'sellLockForced'>;

export interface SellLock<E> {
  /** The open events holding this one's leftovers. */
  by: E[];
  /** Forced open by an owner or admin, and the account allows it: the till sells anyway. */
  forced: boolean;
}

/** The lock on `eventId`, or null when it may sell. Pure - pass every event and every claim. */
export function sellLockOf<E extends LockEvent>(
  eventId: string,
  events: Iterable<E>,
  claims: Iterable<Pick<EventStock, 'eventId' | 'carried'>>,
  settings: SellLockSettings,
): SellLock<E> | null {
  const takers = new Set<string>();
  for (const c of claims) if (c.carried?.from === eventId && c.carried.qty > 0 && c.eventId !== eventId) takers.add(c.eventId);
  if (!takers.size) return null;
  let self: E | undefined;
  const by: E[] = [];
  for (const e of events) {
    if (e.id === eventId) self = e;
    else if (takers.has(e.id) && !e.deletedAt && e.status !== 'planned') by.push(e);
  }
  if (!by.length) return null;
  return { by, forced: settings.allowForce && self?.sellLockForced === true };
}
