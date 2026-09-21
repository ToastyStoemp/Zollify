import { computed, reactive, ref } from 'vue';
import type { EventStock, SalesEvent } from '@zollify/shared';
import { openCoreDb } from './db';
import { getAccount } from '../session';
import { queueOp } from './outbox';
import { toPlain } from './plain';

/**
 * Sales events - the conventions and markets a booth trades at.
 *
 * Almost everything hangs off these: POS records sales against the active
 * event, Customs generates paperwork per event, and a helper's access is
 * defined by which events they are allowed. They are core rather than a module
 * for exactly that reason.
 */

const events = reactive(new Map<string, SalesEvent>());
const activeId = ref<string | null>(null);
const ACTIVE_KEY = 'core.activeEventId';
/**
 * Account-wide, synced via 'setting.upsert' - written whenever any device
 * calls setActiveEvent(), so a fresh device inherits it instead of asking
 * again. It is only ever a fallback: an explicit local choice (ACTIVE_KEY)
 * always wins, and loadSalesEvents() re-checks visibleEvents before ever
 * applying it, so a helper without access to that event never gets it
 * silently activated just because another device set it.
 */
const DEFAULT_ACTIVE_KEY = 'core.defaultActiveEventId';

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Sales events were used while signed out.');
  return account.accountId;
}

export async function loadSalesEvents(): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const rows = await db.events.toArray();
  events.clear();
  for (const row of rows) {
    if (!row.deletedAt) events.set(row.id, row);
  }
  const [stored, defaultStored] = await Promise.all([
    db.settings.get(ACTIVE_KEY),
    db.settings.get(DEFAULT_ACTIVE_KEY),
  ]);
  const candidate = stored?.value as string | undefined;
  // Only restore an active event that still exists and is still visible -
  // otherwise a deleted event leaves the till pointed at nothing.
  if (candidate && events.has(candidate)) {
    activeId.value = candidate;
    return;
  }
  // No explicit choice on this device yet - fall back to the account's
  // synced default, but only if this account can actually see that event.
  const fallback = defaultStored?.value as string | null | undefined;
  activeId.value = fallback && visibleEvents.value.some((e) => e.id === fallback) ? fallback : null;
}

/**
 * Events the signed-in user may see.
 *
 * A helper carries `allowedEventIds`; anyone else sees everything. The server
 * applies the same filter on sync, so this is what the user can act on rather
 * than the boundary itself.
 */
export const visibleEvents = computed(() => {
  const account = getAccount();
  const all = [...events.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const allowed = account?.allowedEventIds;
  if (!allowed || allowed.length === 0) return all;
  const set = new Set(allowed);
  return all.filter((e) => set.has(e.id));
});

export const activeEvent = computed(() =>
  activeId.value ? (events.get(activeId.value) ?? null) : null,
);

export const activeEventId = computed(() => activeId.value);

export function getSalesEvent(id: string): SalesEvent | undefined {
  return events.get(id);
}

export async function setActiveEvent(id: string | null): Promise<void> {
  if (id !== null) {
    const allowed = visibleEvents.value.some((e) => e.id === id);
    if (!allowed) throw new Error('That event is not available to this user.');
  }
  activeId.value = id;
  const db = openCoreDb(requireAccountId());
  // Device-local, not synced: two registers at the same booth may legitimately
  // be working different events.
  await db.settings.put({ key: ACTIVE_KEY, value: id });
  // Also published as the account-wide default (see DEFAULT_ACTIVE_KEY) so a
  // fresh device inherits it instead of asking again. A helper account can't
  // write this op at all (server rejects setting.upsert from restricted
  // users - see opWritable in routes/sync.ts); queue it regardless and let
  // the push silently drop for them rather than special-casing it here.
  await queueOp({
    type: 'setting.upsert',
    payload: { key: DEFAULT_ACTIVE_KEY, value: id, updatedAt: Date.now() },
  });
}

export async function upsertSalesEvent(event: SalesEvent): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const next: SalesEvent = toPlain({ ...event, updatedAt: Date.now() });
  await db.events.put(next);
  events.set(next.id, next);
  await queueOp({ type: 'event.upsert', payload: next });
}

export async function deleteSalesEvent(id: string): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const existing = await db.events.get(id);
  if (!existing) return;
  const tombstoned: SalesEvent = toPlain({ ...existing, deletedAt: Date.now(), updatedAt: Date.now() });
  await db.events.put(tombstoned);
  events.delete(id);
  if (activeId.value === id) await setActiveEvent(null);
  // The protocol has no event.delete - a tombstoned upsert is the delete,
  // which is also exactly how the local soft delete already works.
  await queueOp({ type: 'event.upsert', payload: tombstoned });
}

export async function replaceSalesEvents(rows: SalesEvent[]): Promise<void> {
  const db = openCoreDb(requireAccountId());
  await db.events.bulkPut(rows.map(toPlain));
  for (const row of rows) {
    if (row.deletedAt) events.delete(row.id);
    else events.set(row.id, row);
  }
}

// ── Per-event stock ─────────────────────────────────────────────────────────

export async function stockForEvent(eventId: string): Promise<EventStock[]> {
  const db = openCoreDb(requireAccountId());
  return db.eventStock.where('eventId').equals(eventId).toArray();
}

export async function setStock(entry: EventStock): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const next: EventStock = toPlain({ ...entry, variantId: entry.variantId ?? '', updatedAt: Date.now() });
  await db.eventStock.put(next);
  await queueOp({ type: 'stock.set', payload: next });
}

export function resetSalesEventCache(): void {
  events.clear();
  activeId.value = null;
}
