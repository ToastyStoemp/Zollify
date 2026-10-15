import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { listForAccount, migrateEntitlements, setEnabled } from '../modules/entitlements';
import type { PublishedModule } from '../modules/registry';
import { dependentsOf, requiredBy } from '../routes/modules';

const mod = (moduleId: string, requires?: string[]): PublishedModule => ({
  moduleId, version: '1.0.0', title: moduleId, requires,
  integrity: '', url: '', filePath: '', sizeBytes: 0,
});

const store = new Map(
  [
    mod('customs-hub', ['catalog']),
    mod('customs-ch', ['catalog', 'customs-hub']),
    mod('customs-de', ['catalog', 'customs-hub']),
    mod('pos'),
  ].map((m) => [m.moduleId, m]),
);

describe('module dependencies', () => {
  it('switching a country module on brings the hub, not core capabilities', () => {
    expect([...requiredBy(store, 'customs-ch')]).toEqual(['customs-hub']);
    expect([...requiredBy(store, 'pos')]).toEqual([]);
  });

  it('switching the hub off takes both country modules with it', () => {
    expect([...dependentsOf(store, 'customs-hub')].sort()).toEqual(['customs-ch', 'customs-de']);
    expect([...dependentsOf(store, 'customs-ch')]).toEqual([]);
  });
});

describe('customs-hub entitlement backfill', () => {
  it('turns the hub on for accounts with a country module on', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY); INSERT INTO accounts VALUES ('a'), ('b'), ('c');`);
    migrateEntitlements(db);
    setEnabled(db, 'a', 'customs-ch', true);
    setEnabled(db, 'b', 'customs-de', true);
    setEnabled(db, 'b', 'customs-hub', false);
    setEnabled(db, 'c', 'pos', true);

    migrateEntitlements(db);

    const hub = (id: string) => listForAccount(db, id).find((m) => m.moduleId === 'customs-hub')?.enabled;
    expect(hub('a')).toBe(true);
    expect(hub('b')).toBe(true);
    expect(hub('c')).toBeUndefined();
  });
});
