import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runAutoEvents } from '../auto-events';
import { reduceEvents } from '../reduce';
import type { ServerOpInput } from '../routes/sync';

/** The server opens and closes events by date for the accounts that asked, on each venue's clock. */

let dir: string;
let db: Database.Database;
let seq = 0;

function put(accountId: string, type: string, payload: unknown): void {
  seq++;
  db.prepare('INSERT INTO ops (accountId, seq, opId, deviceId, ts, type, payload, receivedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(accountId, seq, `op-${seq}`, 'dev', 1, type, JSON.stringify(payload), 1);
}
const write = (accountId: string, ops: ServerOpInput[]): void => ops.forEach((o) => put(accountId, o.type, o.payload));
const statuses = (accountId: string) =>
  Object.fromEntries(
    reduceEvents((db.prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type LIKE 'event.%' ORDER BY seq").all(accountId) as { opId: string; type: string; payload: string }[]).map((o) => ({ ...o, payload: JSON.parse(o.payload) }))).map((e) => [e.id, e.status]),
  );
const ev = (id: string, status: string, dateStart: string, dateEnd: string, country = 'Germany') => ({ id, name: id, status, dateStart, dateEnd, venue: { country }, currency: 'EUR', updatedAt: 1 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zfy-auto-'));
  db = openDb(dir);
  seq = 0;
  for (const acct of ['on', 'off']) {
    db.prepare('INSERT INTO accounts (id, name, createdAt) VALUES (?, ?, 1)').run(acct, acct);
    put(acct, 'event.upsert', ev('last', 'active', '2026-10-15', '2026-10-16'));
    put(acct, 'event.upsert', ev('next', 'planned', '2026-10-17', '2026-10-18'));
  }
  put('on', 'setting.upsert', { key: 'events.auto', value: { open: true, close: true }, updatedAt: 5 });
  put('off', 'setting.upsert', { key: 'events.auto', value: { open: true, close: true }, updatedAt: 5 });
  put('off', 'setting.upsert', { key: 'events.auto', value: { open: false, close: false }, updatedAt: 6 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('server: automatic events', () => {
  it('waits for local midnight at the venue, then opens and closes, once', () => {
    expect(runAutoEvents(db, write, Date.parse('2026-10-16T21:30:00Z'))).toEqual([]);
    expect(runAutoEvents(db, write, Date.parse('2026-10-16T22:30:00Z'))).toEqual([{ accountId: 'on', opened: ['next'], closed: ['last'] }]);
    expect(statuses('on')).toEqual({ last: 'closed', next: 'active' });
    expect(runAutoEvents(db, write, Date.parse('2026-10-16T23:00:00Z'))).toEqual([]);
  });

  it('leaves accounts alone that switched it off, by the latest setting', () => {
    runAutoEvents(db, write, Date.parse('2026-10-17T10:00:00Z'));
    expect(statuses('off')).toEqual({ last: 'active', next: 'planned' });
  });
});
