import type Database from 'better-sqlite3';
import { autoEventChangesAt, cleanAutoEventSettings, type SalesEvent } from '@zollify/shared';
import { reduceEvents } from './reduce';
import type { ServerOpInput } from './routes/sync';

/**
 * Opens events on their first day and closes them the day after their last,
 * for the accounts whose owner switched it on (Events → Automatic, the
 * synced setting `events.auto`). The server does it so it happens whether or
 * not any device is on: each pass appends ordinary `event.upsert` ops, which
 * every device pulls like an edit from another till. The day is judged on
 * each event's own clock - see autoEventChangesAt.
 */

const KEY = 'events.auto';
const EVERY_MS = 15 * 60_000;

/** One pass over every account that wants it. Returns what changed, for logs and tests. */
export function runAutoEvents(
  db: Database.Database,
  write: (accountId: string, ops: ServerOpInput[]) => void,
  now = Date.now(),
): { accountId: string; opened: string[]; closed: string[] }[] {
  // The latest events.auto setting per account (last writer by updatedAt, as devices apply it).
  const rows = db
    .prepare("SELECT accountId, payload FROM ops WHERE type = 'setting.upsert' AND json_extract(payload, '$.key') = ? ORDER BY seq")
    .all(KEY) as { accountId: string; payload: string }[];
  const latest = new Map<string, { value: unknown; updatedAt: number }>();
  for (const r of rows) {
    const p = JSON.parse(r.payload) as { value?: unknown; updatedAt?: number };
    const prev = latest.get(r.accountId);
    if (!prev || (p.updatedAt ?? 0) >= prev.updatedAt) latest.set(r.accountId, { value: p.value, updatedAt: p.updatedAt ?? 0 });
  }
  const eventOps = db.prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN ('event.upsert', 'event.close') ORDER BY seq");
  const out: { accountId: string; opened: string[]; closed: string[] }[] = [];
  for (const [accountId, setting] of latest) {
    const settings = cleanAutoEventSettings(setting.value);
    if (!settings.open && !settings.close) continue;
    const ops = (eventOps.all(accountId) as { opId: string; type: string; payload: string }[]).map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) as unknown }));
    const { open, close } = autoEventChangesAt(reduceEvents(ops) as SalesEvent[], now, settings);
    if (!open.length && !close.length) continue;
    write(accountId, [
      ...open.map((e): ServerOpInput => ({ type: 'event.upsert', payload: { ...e, status: 'active', updatedAt: now } })),
      ...close.map((e): ServerOpInput => ({ type: 'event.upsert', payload: { ...e, status: 'closed', updatedAt: now } })),
    ]);
    out.push({ accountId, opened: open.map((e) => e.id), closed: close.map((e) => e.id) });
  }
  return out;
}

/** Runs a pass shortly after start, then every quarter of an hour; returns the stop. */
export function startAutoEvents(db: Database.Database, write: (accountId: string, ops: ServerOpInput[]) => void, log: (err: unknown) => void): () => void {
  const pass = (): void => {
    try {
      runAutoEvents(db, write);
    } catch (err) {
      log(err);
    }
  };
  const first = setTimeout(pass, 30_000);
  const timer = setInterval(pass, EVERY_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
