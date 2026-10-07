import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  POOL_MAX_DAYS,
  PoolReportSchema,
  PoolSettingsSchema,
  cleanText,
  httpsUrl,
  isIsoDate,
  poolKey,
  type PoolListing,
} from '@zollify/shared';
import { reduceEvents, type ModuleContext, type ModuleServices } from '@zollify/server-core';

/**
 * The shared event pool - the server half. Part of public-events: both publish
 * an event's public facts, and the pool reuses its op-log reader and its
 * enablement gate instead of standing up a second module.
 *
 * Data crossing accounts is only what `PoolListing` holds. An account agrees
 * once ("help share event information"); the server then keeps its pool
 * contributions in step with the account's own events, reading every field
 * from the op-log and never from a request. Nothing about who shares, who
 * quick-added or who goes ever leaves the server: a contribution carries the
 * account id privately, only so the account's own contributions can be
 * updated, withdrawn and deduped. A listing is derived from its contributions,
 * so withdrawing the last one removes it entirely.
 */

/** Consent changes per account per hour. */
const SETTING_LIMIT = 20;
/** Reports per account per day. */
const REPORT_LIMIT = 30;
/** Distinct reporters after which a listing stops showing in search until the server owner looks. */
const HIDE_AT_FLAGS = 3;
const MAX_CONTRIBUTIONS = 200;
/** Events that ended longer ago than this are no longer shared. */
const RECENT_DAYS = 30;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function migrateEventPool(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_pool_listings (
      id          TEXT PRIMARY KEY,
      dedupeKey   TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      edition     TEXT NOT NULL DEFAULT '',
      venueName   TEXT NOT NULL DEFAULT '',
      street      TEXT NOT NULL DEFAULT '',
      postcode    TEXT NOT NULL DEFAULT '',
      city        TEXT NOT NULL DEFAULT '',
      country     TEXT NOT NULL DEFAULT '',
      dateStart   TEXT NOT NULL,
      dateEnd     TEXT NOT NULL,
      url         TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      updatedAt   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_pool_dates ON event_pool_listings (dateEnd, dateStart);
    -- One row per account event shared; private, never returned. The listing mirrors the first of these.
    CREATE TABLE IF NOT EXISTS event_pool_contribs (
      accountId   TEXT NOT NULL,
      eventId     TEXT NOT NULL,
      listingId   TEXT NOT NULL,
      facts       TEXT NOT NULL,
      updatedAt   INTEGER NOT NULL,
      PRIMARY KEY (accountId, eventId)
    );
    CREATE INDEX IF NOT EXISTS idx_event_pool_contribs_listing ON event_pool_contribs (listingId);
    -- Which listings an account quick-added, so they are not offered again. Only that account reads it.
    CREATE TABLE IF NOT EXISTS event_pool_adopted (
      accountId TEXT NOT NULL,
      listingId TEXT NOT NULL,
      eventId   TEXT NOT NULL,
      addedAt   INTEGER NOT NULL,
      PRIMARY KEY (accountId, listingId)
    );
    CREATE TABLE IF NOT EXISTS event_pool_flags (
      listingId TEXT NOT NULL,
      accountId TEXT NOT NULL,
      reason    TEXT NOT NULL,
      note      TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (listingId, accountId)
    );
    -- Setting and report attempts, for the per-account rate limits.
    CREATE TABLE IF NOT EXISTS event_pool_actions (
      accountId TEXT NOT NULL,
      kind      TEXT NOT NULL,
      at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_pool_actions ON event_pool_actions (accountId, kind, at);
    -- The account-level consent. No row means off.
    CREATE TABLE IF NOT EXISTS event_pool_settings (
      accountId TEXT PRIMARY KEY,
      share     INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL
    );
  `);
  // Earlier versions let contributors type a display name; it is gone, stored copies included.
  const cols = db.prepare('PRAGMA table_info(event_pool_contribs)').all() as { name: string }[];
  if (cols.some((c) => c.name === 'displayName')) {
    db.prepare("UPDATE event_pool_contribs SET displayName = ''").run();
    try {
      db.exec('ALTER TABLE event_pool_contribs DROP COLUMN displayName');
    } catch {
      /* an old SQLite cannot drop columns; the values are blank and never read */
    }
  }
  // Per-event sharing is replaced by the account-level setting. A contribution from an account
  // that has not agreed to the new one is withdrawn, so nothing stays shared without consent.
  db.exec(`
    DELETE FROM event_pool_contribs WHERE accountId NOT IN (SELECT accountId FROM event_pool_settings WHERE share = 1);
    DELETE FROM event_pool_listings WHERE id NOT IN (SELECT listingId FROM event_pool_contribs);
    DELETE FROM event_pool_flags WHERE listingId NOT IN (SELECT id FROM event_pool_listings);
    DELETE FROM event_pool_adopted WHERE listingId NOT IN (SELECT id FROM event_pool_listings);
  `);
}

interface Facts {
  name: string;
  edition: string;
  venueName: string;
  street: string;
  postcode: string;
  city: string;
  country: string;
  dateStart: string;
  dateEnd: string;
  url: string;
  description: string;
}

interface Row extends Facts {
  id: string;
  updatedAt: number;
}

/** The account's events, read the way the app does. */
function accountEvents(db: Database.Database, accountId: string) {
  const ops = db
    .prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN ('event.upsert', 'event.close') ORDER BY seq")
    .all(accountId) as { opId: string; type: string; payload: string }[];
  return reduceEvents(ops.map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) })));
}

type SalesEventLike = ReturnType<typeof accountEvents>[number];

/**
 * What one of the account's events publishes, or null when it is not shareable: a store, deleted,
 * opted out, unnamed, undated, without a city or country, or implausibly long or long past. Every
 * field is picked by hand, never spread, so nothing else on the record can leave.
 */
function factsOf(ev: SalesEventLike, today: string): Facts | null {
  if (ev.deletedAt || (ev.kind ?? 'event') !== 'event' || ev.noPool) return null;
  const clip = (s: unknown, n: number) => cleanText(String(s ?? '')).replace(/[<>]/g, '').slice(0, n);
  const name = cleanText(ev.name ?? '');
  const dateStart = ev.dateStart ?? '';
  const dateEnd = ev.dateEnd || dateStart;
  if (!name || name.length > 120 || /[<>]/.test(name)) return null;
  if (!isIsoDate(dateStart) || !isIsoDate(dateEnd) || dateEnd < dateStart) return null;
  if ((Date.parse(dateEnd) - Date.parse(dateStart)) / DAY + 1 > POOL_MAX_DAYS) return null;
  if (Date.parse(dateEnd) < Date.parse(today) - RECENT_DAYS * DAY) return null;
  const city = clip(ev.venue?.city, 80);
  const country = clip(ev.venue?.country, 80);
  if (!city && !country) return null;
  return {
    name,
    edition: '',
    venueName: '',
    street: clip(ev.venue?.street, 120),
    postcode: clip(ev.venue?.postcode, 20),
    city,
    country,
    dateStart,
    dateEnd,
    url: httpsUrl(ev.booth?.link),
    description: clip(ev.booth?.note, 400),
  };
}

export const poolSharing = (db: Database.Database, accountId: string): boolean =>
  Boolean((db.prepare('SELECT share FROM event_pool_settings WHERE accountId = ?').get(accountId) as { share: number } | undefined)?.share);

function overLimit(db: Database.Database, accountId: string, kind: 'setting' | 'report', max: number, window: number): boolean {
  db.prepare('DELETE FROM event_pool_actions WHERE accountId = ? AND at < ?').run(accountId, Date.now() - DAY);
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM event_pool_actions WHERE accountId = ? AND kind = ? AND at >= ?')
    .get(accountId, kind, Date.now() - window) as { n: number };
  return row.n >= max;
}

const noteAction = (db: Database.Database, accountId: string, kind: 'setting' | 'report') =>
  db.prepare('INSERT INTO event_pool_actions (accountId, kind, at) VALUES (?, ?, ?)').run(accountId, kind, Date.now());

/**
 * Rewrites a listing from its first contribution, or removes it when none are left. The first, not
 * the newest: another account joining or leaving then never changes what the listing shows.
 */
function refreshListing(db: Database.Database, listingId: string): void {
  const first = db.prepare('SELECT facts, updatedAt FROM event_pool_contribs WHERE listingId = ? ORDER BY rowid LIMIT 1').get(listingId) as
    | { facts: string; updatedAt: number }
    | undefined;
  if (!first) {
    db.prepare('DELETE FROM event_pool_listings WHERE id = ?').run(listingId);
    db.prepare('DELETE FROM event_pool_flags WHERE listingId = ?').run(listingId);
    db.prepare('DELETE FROM event_pool_adopted WHERE listingId = ?').run(listingId);
    return;
  }
  const f = JSON.parse(first.facts) as Facts;
  db.prepare(
    `UPDATE event_pool_listings SET name = ?, edition = ?, venueName = ?, street = ?, postcode = ?, city = ?, country = ?,
       dateStart = ?, dateEnd = ?, url = ?, description = ?, updatedAt = ? WHERE id = ?`,
  ).run(f.name, f.edition, f.venueName, f.street, f.postcode, f.city, f.country, f.dateStart, f.dateEnd, f.url, f.description, first.updatedAt, listingId);
}

/**
 * Brings the account's contributions in line with its events: adds what newly qualifies, rewrites
 * what changed, withdraws what was deleted, opted out or aged out - and everything when sharing is
 * off. Idempotent, and a run that finds nothing to change writes nothing.
 */
export function reconcilePool(db: Database.Database, accountId: string): void {
  const today = new Date().toISOString().slice(0, 10);
  const desired = new Map<string, Facts>();
  if (poolSharing(db, accountId)) {
    // Soonest first, so the cap drops the farthest-out events rather than the next ones.
    const candidates = accountEvents(db, accountId)
      .map((ev) => [ev.id, factsOf(ev, today)] as const)
      .filter((e): e is readonly [string, Facts] => e[1] !== null)
      .sort((a, b) => a[1].dateStart.localeCompare(b[1].dateStart));
    for (const [id, facts] of candidates.slice(0, MAX_CONTRIBUTIONS)) desired.set(id, facts);
  }
  const have = db.prepare('SELECT eventId, listingId, facts FROM event_pool_contribs WHERE accountId = ?').all(accountId) as {
    eventId: string;
    listingId: string;
    facts: string;
  }[];
  const touched = new Set<string>();
  db.transaction(() => {
    const now = Date.now();
    for (const row of have) {
      if (!desired.has(row.eventId)) {
        db.prepare('DELETE FROM event_pool_contribs WHERE accountId = ? AND eventId = ?').run(accountId, row.eventId);
        touched.add(row.listingId);
      }
    }
    const stored = new Map(have.map((r) => [r.eventId, r]));
    for (const [eventId, facts] of desired) {
      const json = JSON.stringify(facts);
      const existing = stored.get(eventId);
      if (existing?.facts === json) continue;
      const key = poolKey(facts.name, facts.dateStart, facts.city || facts.country);
      let listing = db.prepare('SELECT id FROM event_pool_listings WHERE dedupeKey = ?').get(key) as { id: string } | undefined;
      if (!listing) {
        listing = { id: randomUUID() };
        db.prepare('INSERT INTO event_pool_listings (id, dedupeKey, name, dateStart, dateEnd, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
          listing.id,
          key,
          facts.name,
          facts.dateStart,
          facts.dateEnd,
          now,
        );
      }
      db.prepare(
        `INSERT INTO event_pool_contribs (accountId, eventId, listingId, facts, updatedAt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(accountId, eventId) DO UPDATE SET listingId = excluded.listingId, facts = excluded.facts, updatedAt = excluded.updatedAt`,
      ).run(accountId, eventId, listing.id, json, now);
      touched.add(listing.id);
      // An edit that changed name, date or place moves the contribution; tidy up what it left.
      if (existing && existing.listingId !== listing.id) touched.add(existing.listingId);
    }
    for (const id of touched) refreshListing(db, id);
  })();
}

/** Server hook: follow the account's events as devices push them. Must not throw. */
export function poolOnOps(ctx: ModuleServices, accountId: string, ops: { type: string }[]): void {
  if (!ops.some((o) => o.type === 'event.upsert' || o.type === 'event.close')) return;
  if (!poolSharing(ctx.db, accountId)) return;
  try {
    reconcilePool(ctx.db, accountId);
  } catch {
    /* the pool is a convenience; a failed sync must never fail a push */
  }
}

function toListing(db: Database.Database, row: Row, accountId: string): PoolListing {
  const added = db.prepare('SELECT 1 FROM event_pool_adopted WHERE accountId = ? AND listingId = ?').get(accountId, row.id);
  return {
    id: row.id,
    name: row.name,
    edition: row.edition,
    venueName: row.venueName,
    street: row.street,
    postcode: row.postcode,
    city: row.city,
    country: row.country,
    dateStart: row.dateStart,
    dateEnd: row.dateEnd,
    url: row.url,
    description: row.description,
    added: Boolean(added),
  };
}

const getListing = (db: Database.Database, id: string): Row | undefined =>
  db.prepare('SELECT * FROM event_pool_listings WHERE id = ?').get(id) as Row | undefined;

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const bad = (message: string) => ({ error: 'invalid', message });

export function registerEventPool(app: FastifyInstance, ctx: ModuleContext): void {
  const { db } = ctx;

  /**
   * Search. Upcoming first (soonest start), then past, newest first; ties by name. Nothing here
   * depends on how many accounts share a listing. The caller's own and already-added listings are
   * left out unless asked for - which tells the caller only about itself.
   */
  app.get<{ Querystring: Record<string, string | undefined> }>('/pool/listings', async (req, reply) => {
    const who = ctx.identity(req);
    const q = cleanText(req.query.q ?? '').slice(0, 80);
    const city = cleanText(req.query.city ?? '').slice(0, 80);
    const country = cleanText(req.query.country ?? '').slice(0, 80);
    const from = req.query.from ?? '';
    const to = req.query.to ?? '';
    if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) return reply.code(400).send(bad('Dates look like 2026-09-13.'));
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const today = new Date().toISOString().slice(0, 10);

    const where: string[] = [`(SELECT COUNT(*) FROM event_pool_flags f WHERE f.listingId = l.id) < ${HIDE_AT_FLAGS}`];
    const args: unknown[] = [];
    if (q) {
      where.push("(l.name LIKE ? ESCAPE '\\' OR l.edition LIKE ? ESCAPE '\\' OR l.venueName LIKE ? ESCAPE '\\')");
      args.push(like(q), like(q), like(q));
    }
    if (city) {
      where.push("l.city LIKE ? ESCAPE '\\'");
      args.push(like(city));
    }
    if (country) {
      where.push("l.country LIKE ? ESCAPE '\\'");
      args.push(like(country));
    }
    if (to) {
      where.push('l.dateStart <= ?');
      args.push(to);
    }
    // No explicit start: upcoming and running only, unless the caller asks for the past too.
    if (from) {
      where.push('l.dateEnd >= ?');
      args.push(from);
    } else if (req.query.past !== '1') {
      where.push('l.dateEnd >= ?');
      args.push(today);
    }
    if (req.query.includeAdded !== '1') {
      where.push('NOT EXISTS (SELECT 1 FROM event_pool_adopted a WHERE a.listingId = l.id AND a.accountId = ?)');
      args.push(who.accountId);
      where.push('NOT EXISTS (SELECT 1 FROM event_pool_contribs c WHERE c.listingId = l.id AND c.accountId = ?)');
      args.push(who.accountId);
    }

    const rows = db
      .prepare(
        `SELECT l.* FROM event_pool_listings l WHERE ${where.join(' AND ')}
         ORDER BY (l.dateEnd >= ?) DESC,
                  CASE WHEN l.dateEnd >= ? THEN l.dateStart END ASC,
                  CASE WHEN l.dateEnd < ? THEN l.dateStart END DESC, l.name, l.id
         LIMIT ? OFFSET ?`,
      )
      .all(...args, today, today, today, limit + 1, offset) as Row[];
    return { listings: rows.slice(0, limit).map((r) => toListing(db, r, who.accountId)), more: rows.length > limit };
  });

  /** Whether this account shares its events. Also re-syncs, so opening the screen keeps the pool current. */
  app.get('/pool/settings', async (req) => {
    const who = ctx.identity(req);
    const share = poolSharing(db, who.accountId);
    if (share) reconcilePool(db, who.accountId);
    return { share };
  });

  /** Turn sharing on or off. Off withdraws everything at once; on shares the qualifying events at once. */
  app.put('/pool/settings', async (req, reply) => {
    const who = ctx.identity(req);
    const parsed = PoolSettingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(bad('Say whether to share.'));
    if (overLimit(db, who.accountId, 'setting', SETTING_LIMIT, HOUR)) {
      return reply.code(429).send({ error: 'rate_limited', message: 'You are changing this too fast - try again in a little while.' });
    }
    noteAction(db, who.accountId, 'setting');
    db.prepare(
      `INSERT INTO event_pool_settings (accountId, share, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(accountId) DO UPDATE SET share = excluded.share, updatedAt = excluded.updatedAt`,
    ).run(who.accountId, parsed.data.share ? 1 : 0, Date.now());
    reconcilePool(db, who.accountId);
    return { share: parsed.data.share };
  });

  /** Record that the caller created an event from a listing, so it is not offered again. */
  app.post<{ Params: { id: string } }>('/pool/listings/:id/adopt', async (req, reply) => {
    const who = ctx.identity(req);
    const eventId = (req.body as { eventId?: unknown } | null)?.eventId;
    if (typeof eventId !== 'string' || !eventId || eventId.length > 100) return reply.code(400).send(bad('Missing event id.'));
    const row = getListing(db, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'That listing is gone.' });
    db.prepare(
      `INSERT INTO event_pool_adopted (accountId, listingId, eventId, addedAt) VALUES (?, ?, ?, ?)
       ON CONFLICT(accountId, listingId) DO UPDATE SET eventId = excluded.eventId, addedAt = excluded.addedAt`,
    ).run(who.accountId, row.id, eventId, Date.now());
    return { ok: true };
  });

  /** Flag a listing. One flag per account; enough distinct flags hide it from search. */
  app.post<{ Params: { id: string } }>('/pool/listings/:id/report', async (req, reply) => {
    const who = ctx.identity(req);
    const parsed = PoolReportSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(bad(parsed.error.issues[0]?.message ?? 'Pick a reason.'));
    const row = getListing(db, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'That listing is gone.' });
    if (overLimit(db, who.accountId, 'report', REPORT_LIMIT, DAY)) {
      return reply.code(429).send({ error: 'rate_limited', message: 'Too many reports today.' });
    }
    noteAction(db, who.accountId, 'report');
    db.prepare(
      `INSERT INTO event_pool_flags (listingId, accountId, reason, note, createdAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(listingId, accountId) DO UPDATE SET reason = excluded.reason, note = excluded.note, createdAt = excluded.createdAt`,
    ).run(row.id, who.accountId, parsed.data.reason, parsed.data.note, Date.now());
    return { ok: true };
  });
}
