import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { TravelRatesSchema, defaultTravelRates, perDiemsDue, type SalesEvent, type TravelRates } from '@zollify/shared';
import { reduceEvents } from '@zollify/server-core';
import type { KvCache } from './types';

/**
 * The ledger's per-account state the routes and the op hook both read - the
 * key-value cache, the events as the op-log holds them, the travel rates -
 * and the per diems added by themselves when an event closes (see
 * `perDiemsDue` in @zollify/shared).
 */

export const RATES_KEY = 'ledger.rates';
/** Events that got their automatic per diem once; deleting it is a decision, so they are not given another. */
const AUTO_DONE_KEY = 'ledger.perdiem.auto';

export const kvFor = (db: Database.Database, accountId: string): KvCache => ({
  get: <T>(key: string): T | null => {
    const row = db.prepare('SELECT value FROM tax_cache WHERE accountId = ? AND key = ?').get(accountId, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  },
  set: (key, value) => {
    db.prepare('INSERT INTO tax_cache (accountId, key, value) VALUES (?, ?, ?) ON CONFLICT(accountId, key) DO UPDATE SET value = excluded.value').run(accountId, key, JSON.stringify(value));
  },
});

export const opsFor = (db: Database.Database, accountId: string, types: string[]) =>
  (db
    .prepare(`SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY seq`)
    .all(accountId, ...types) as { opId: string; type: string; payload: string }[]).map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) as unknown }));

export const eventsFor = (db: Database.Database, accountId: string): SalesEvent[] => reduceEvents(opsFor(db, accountId, ['event.upsert', 'event.close'])).filter((e) => !e.deletedAt);

/** The account's rate table, started from the defaults for its country (Germany's rules until the profile says). */
export function readRates(db: Database.Database, accountId: string): TravelRates {
  const stored = kvFor(db, accountId).get<unknown>(RATES_KEY);
  const parsed = stored ? TravelRatesSchema.safeParse(stored) : null;
  if (parsed?.success) return parsed.data;
  const row = db.prepare('SELECT profile FROM accounts WHERE id = ?').get(accountId) as { profile: string | null } | undefined;
  let home = '';
  try {
    home = String((JSON.parse(row?.profile ?? '{}') as { artist?: { countryOfOrigin?: string } }).artist?.countryOfOrigin ?? '');
  } catch {
    /* no profile yet */
  }
  return defaultTravelRates(home || 'DE');
}

/**
 * Adds the per diems the closed events are due and returns how many. Run
 * after event ops arrive and when the setting is saved; an event with a per
 * diem already, or that had its automatic one, gets none.
 */
export function addDuePerDiems(db: Database.Database, accountId: string): number {
  const rates = readRates(db, accountId);
  if (!rates.auto.on) return 0;
  const kv = kvFor(db, accountId);
  const handled = kv.get<{ events: string[] }>(AUTO_DONE_KEY)?.events ?? [];
  const done = new Set<string>(handled);
  for (const r of db.prepare(`SELECT DISTINCT eventId FROM tax_expenses WHERE accountId = ? AND category = 'perdiem'`).all(accountId) as { eventId: string }[]) done.add(r.eventId);
  const due = perDiemsDue(eventsFor(db, accountId), done, rates);
  if (!due.length) return 0;
  const insert = db.prepare(
    `INSERT INTO tax_expenses (accountId, id, eventId, category, amountMinor, currency, date, vendor, note, detail, createdBy, paidFrom, createdAt, updatedAt)
     VALUES (?, ?, ?, 'perdiem', ?, ?, ?, '', ?, ?, NULL, NULL, ?, ?)`,
  );
  const now = Date.now();
  db.transaction(() => {
    for (const d of due) insert.run(accountId, randomUUID(), d.eventId, Math.round(d.amount * 100), d.currency.toUpperCase(), d.date, d.note, JSON.stringify(d.detail), now, now);
    kv.set(AUTO_DONE_KEY, { events: [...new Set([...handled, ...due.map((d) => d.eventId)])] });
  })();
  return due.length;
}
