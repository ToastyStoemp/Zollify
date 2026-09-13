import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SQLite via better-sqlite3 — synchronous, transactional, zero infra.
 * All data lives under DATA_DIR (a Docker volume in production):
 *   DATA_DIR/zolltool.db      the database
 *   DATA_DIR/images/<acct>/   full-size product images
 */

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE accounts (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE TABLE users (
    id           TEXT PRIMARY KEY,
    accountId    TEXT NOT NULL REFERENCES accounts(id),
    email        TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
    createdAt    INTEGER NOT NULL,
    lastLoginAt  INTEGER
  );
  CREATE TABLE devices (
    id         TEXT PRIMARY KEY,
    accountId  TEXT NOT NULL REFERENCES accounts(id),
    userId     TEXT NOT NULL REFERENCES users(id),
    name       TEXT,
    lastSeenAt INTEGER NOT NULL,
    createdAt  INTEGER NOT NULL
  );
  CREATE TABLE refresh_tokens (
    id        TEXT PRIMARY KEY,
    userId    TEXT NOT NULL REFERENCES users(id),
    tokenHash TEXT NOT NULL UNIQUE,
    expiresAt INTEGER NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE TABLE invites (
    code      TEXT PRIMARY KEY,
    accountId TEXT REFERENCES accounts(id),  -- NULL = invite creates a brand-new account
    role      TEXT NOT NULL DEFAULT 'member',
    createdBy TEXT NOT NULL REFERENCES users(id),
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    usedBy    TEXT REFERENCES users(id)
  );
  CREATE TABLE ops (
    accountId  TEXT NOT NULL REFERENCES accounts(id),
    seq        INTEGER NOT NULL,
    opId       TEXT NOT NULL UNIQUE,
    deviceId   TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    receivedAt INTEGER NOT NULL,
    PRIMARY KEY (accountId, seq)
  );
  CREATE TABLE images (
    id        TEXT NOT NULL,
    accountId TEXT NOT NULL REFERENCES accounts(id),
    mime      TEXT NOT NULL,
    size      INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    PRIMARY KEY (id, accountId)
  );
  CREATE TABLE metrics (
    accountId   TEXT NOT NULL REFERENCES accounts(id),
    day         TEXT NOT NULL,
    logins      INTEGER NOT NULL DEFAULT 0,
    syncPushes  INTEGER NOT NULL DEFAULT 0,
    opsReceived INTEGER NOT NULL DEFAULT 0,
    txCount     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (accountId, day)
  );
  `,
  // v2 — client-uploaded diagnostic logs (see routes/logs.ts)
  `
  CREATE TABLE logs (
    id         TEXT PRIMARY KEY,
    accountId  TEXT NOT NULL REFERENCES accounts(id),
    deviceId   TEXT NOT NULL,
    deviceName TEXT,
    flavor     TEXT,
    appVersion TEXT,
    reason     TEXT,
    size       INTEGER NOT NULL,
    createdAt  INTEGER NOT NULL
  );
  `,
  // v3 — track each device's app flavor, so e.g. a register can list the
  // account's Carbon terminals for the remote-payment-trigger picker.
  `ALTER TABLE devices ADD COLUMN flavor TEXT;`,
  // v4 — scoped, revocable API tokens for machine access (e.g. the ZollTax
  // accounting bridge) — read-only, so no account password lives in a config.
  `
  CREATE TABLE api_tokens (
    id         TEXT PRIMARY KEY,
    accountId  TEXT NOT NULL REFERENCES accounts(id),
    name       TEXT,
    tokenHash  TEXT NOT NULL UNIQUE,
    scopes     TEXT NOT NULL DEFAULT 'data:read',
    createdBy  TEXT REFERENCES users(id),
    createdAt  INTEGER NOT NULL,
    lastUsedAt INTEGER,
    revokedAt  INTEGER
  );
  CREATE INDEX idx_api_tokens_account ON api_tokens(accountId);
  `,
  // v5 — 2FA (TOTP + recovery codes), richer session metadata on refresh tokens
  // (a refresh token IS a login session → device/IP/geo for the admin overview),
  // and trusted devices so a 2FA'd device can skip the code on later logins.
  `
  ALTER TABLE users ADD COLUMN totpSecret TEXT;                    -- encrypted at rest
  ALTER TABLE users ADD COLUMN totpEnabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN recoveryCodes TEXT;                 -- JSON array of sha256 hashes
  ALTER TABLE refresh_tokens ADD COLUMN deviceId TEXT;
  ALTER TABLE refresh_tokens ADD COLUMN deviceName TEXT;
  ALTER TABLE refresh_tokens ADD COLUMN flavor TEXT;
  ALTER TABLE refresh_tokens ADD COLUMN ip TEXT;
  ALTER TABLE refresh_tokens ADD COLUMN device TEXT;
  ALTER TABLE refresh_tokens ADD COLUMN geo TEXT;
  ALTER TABLE refresh_tokens ADD COLUMN lastUsedAt INTEGER;
  CREATE TABLE trusted_devices (
    id        TEXT PRIMARY KEY,
    userId    TEXT NOT NULL REFERENCES users(id),
    deviceId  TEXT NOT NULL,
    tokenHash TEXT NOT NULL UNIQUE,
    expiresAt INTEGER NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX idx_trusted_user ON trusted_devices(userId, deviceId);
  `,
  // v6 — per-user event restriction. A JSON array of event ids: when set, a member
  // ("helper") only syncs and may only write data for those events, and the catalog
  // is read-only to them (except stock for their events). NULL = full access.
  `
  ALTER TABLE users ADD COLUMN allowedEventIds TEXT;
  ALTER TABLE invites ADD COLUMN allowedEventIds TEXT;
  `,
  // v7 — account log epoch. Bumped by an in-place op-log rewrite (e.g. baking
  // product merges into stored tx payloads); the pull API returns it so clients
  // detect the rewrite and re-pull from scratch. See scripts/rewrite-merges.mjs.
  `ALTER TABLE accounts ADD COLUMN syncEpoch INTEGER NOT NULL DEFAULT 0;`,
];

export function openDb(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  const db = new Database(join(dataDir, 'zolltool.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const applied = db.pragma('user_version', { simple: true }) as number;
  for (let v = applied; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

const METRIC_FIELDS = ['logins', 'syncPushes', 'opsReceived', 'txCount'] as const;
export type MetricField = (typeof METRIC_FIELDS)[number];

export function bumpMetric(db: Database.Database, accountId: string, field: MetricField, delta = 1): void {
  if (!METRIC_FIELDS.includes(field)) return;
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO metrics (accountId, day, ${field}) VALUES (?, ?, ?)
     ON CONFLICT (accountId, day) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
  ).run(accountId, day, delta);
}

/**
 * Upsert device presence — called both from a sync push (routes/sync.ts) and
 * a fresh WS connection (ws.ts), since a device that mostly just listens
 * (e.g. a Carbon sitting in customer-display mode) may rarely push its own
 * ops otherwise, leaving its lastSeenAt stale for the device picker.
 */
export function touchDevice(
  db: Database.Database,
  id: string,
  accountId: string,
  userId: string,
  name: string | null,
  flavor: string | null,
  now: number,
): void {
  db.prepare(
    `INSERT INTO devices (id, accountId, userId, name, flavor, lastSeenAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       lastSeenAt = excluded.lastSeenAt,
       name = COALESCE(excluded.name, name),
       flavor = COALESCE(excluded.flavor, flavor)`,
  ).run(id, accountId, userId, name, flavor, now, now);
}
