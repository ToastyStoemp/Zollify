import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  POOL_MAX_DAYS,
  PoolReportSchema,
  PoolShareSchema,
  cleanText,
  httpsUrl,
  isIsoDate,
  poolKey,
  type PoolListing,
} from '@zollify/shared';
import { reduceEvents, type ModuleContext } from '@zollify/server-core';

/**
 * The shared event pool - the server half. Part of public-events: both publish
 * an event's public facts, and the pool reuses its op-log reader and its
 * enablement gate instead of standing up a second module.
 *
 * Data crossing accounts is only what `PoolListing` holds. Name, dates and
 * address are read from the contributor's own event on the server; the request
 * supplies only a few bounded extras. A listing is derived from its
 * contributions, so withdrawing the last one removes it entirely.
 */

/** Publishes per account per hour, edits included. */
const SHARE_LIMIT = 20;
/** Reports per account per day. */
const REPORT_LIMIT = 30;
/** Distinct reporters after which a listing stops showing in search until the server owner looks. */
const HIDE_AT_FLAGS = 3;
const MAX_CONTRIBUTIONS = 200;
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
    -- One row per account event shared. The listing mirrors the newest of these.
    CREATE TABLE IF NOT EXISTS event_pool_contribs (
      accountId   TEXT NOT NULL,
      eventId     TEXT NOT NULL,
      listingId   TEXT NOT NULL,
      displayName TEXT NOT NULL DEFAULT '',
      facts       TEXT NOT NULL,
      updatedAt   INTEGER NOT NULL,
      PRIMARY KEY (accountId, eventId)
    );
    CREATE INDEX IF NOT EXISTS idx_event_pool_contribs_listing ON event_pool_contribs (listingId);
    -- Which listings an account quick-added, so they are not offered again.
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
    -- Publish and report attempts, for the per-account rate limits.
    CREATE TABLE IF NOT EXISTS event_pool_actions (
      accountId TEXT NOT NULL,
      kind      TEXT NOT NULL,
      at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_pool_actions ON event_pool_actions (accountId, kind, at);
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

/** The account's own event, read the way the app does; null when it is gone or not a convention. */
function ownEvent(db: Database.Database, accountId: string, eventId: string) {
  const ops = db
    .prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN ('event.upsert', 'event.close') ORDER BY seq")
    .all(accountId) as { opId: string; type: string; payload: string }[];
  const ev = reduceEvents(ops.map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) }))).find((e) => e.id === eventId);
  return ev && !ev.deletedAt && (ev.kind ?? 'event') === 'event' ? ev : null;
}

function overLimit(db: Database.Database, accountId: string, kind: 'share' | 'report', max: number, window: number): boolean {
  db.prepare('DELETE FROM event_pool_actions WHERE accountId = ? AND at < ?').run(accountId, Date.now() - DAY);
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM event_pool_actions WHERE accountId = ? AND kind = ? AND at >= ?')
    .get(accountId, kind, Date.now() - window) as { n: number };
  return row.n >= max;
}

const noteAction = (db: Database.Database, accountId: string, kind: 'share' | 'report') =>
  db.prepare('INSERT INTO event_pool_actions (accountId, kind, at) VALUES (?, ?, ?)').run(accountId, kind, Date.now());

/** Rewrites a listing from its newest contribution, or removes it when none are left. */
function refreshListing(db: Database.Database, listingId: string): void {
  const latest = db
    .prepare('SELECT facts, updatedAt FROM event_pool_contribs WHERE listingId = ? ORDER BY updatedAt DESC LIMIT 1')
    .get(listingId) as { facts: string; updatedAt: number } | undefined;
  if (!latest) {
    db.prepare('DELETE FROM event_pool_listings WHERE id = ?').run(listingId);
    db.prepare('DELETE FROM event_pool_flags WHERE listingId = ?').run(listingId);
    db.prepare('DELETE FROM event_pool_adopted WHERE listingId = ?').run(listingId);
    return;
  }
  const f = JSON.parse(latest.facts) as Facts;
  db.prepare(
    `UPDATE event_pool_listings SET name = ?, edition = ?, venueName = ?, street = ?, postcode = ?, city = ?, country = ?,
       dateStart = ?, dateEnd = ?, url = ?, description = ?, updatedAt = ? WHERE id = ?`,
  ).run(f.name, f.edition, f.venueName, f.street, f.postcode, f.city, f.country, f.dateStart, f.dateEnd, f.url, f.description, latest.updatedAt, listingId);
}

function toListing(db: Database.Database, row: Row, accountId: string): PoolListing {
  const contribs = db.prepare('SELECT accountId, displayName FROM event_pool_contribs WHERE listingId = ? ORDER BY updatedAt').all(row.id) as {
    accountId: string;
    displayName: string;
  }[];
  const accounts = new Set(contribs.map((c) => c.accountId));
  const names = [...new Set(contribs.filter((c) => c.displayName).map((c) => c.displayName))];
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
    going: accounts.size,
    names,
    mine: accounts.has(accountId),
    added: Boolean(added),
    updatedAt: row.updatedAt,
  };
}

const getListing = (db: Database.Database, id: string): Row | undefined =>
  db.prepare('SELECT * FROM event_pool_listings WHERE id = ?').get(id) as Row | undefined;

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const bad = (message: string) => ({ error: 'invalid', message });

export function registerEventPool(app: FastifyInstance, ctx: ModuleContext): void {
  const { db } = ctx;

  /** Search. Upcoming first (soonest start), then past, newest first. Hidden and already-added listings are left out unless asked for. */
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
                  CASE WHEN l.dateEnd < ? THEN l.dateStart END DESC, l.name
         LIMIT ? OFFSET ?`,
      )
      .all(...args, today, today, today, limit + 1, offset) as Row[];
    return { listings: rows.slice(0, limit).map((r) => toListing(db, r, who.accountId)), more: rows.length > limit };
  });

  /** The caller's own contributions, with the extras they typed. */
  app.get('/pool/mine', async (req) => {
    const who = ctx.identity(req);
    const rows = db
      .prepare(
        `SELECT c.eventId, c.displayName, l.* FROM event_pool_contribs c JOIN event_pool_listings l ON l.id = c.listingId WHERE c.accountId = ?`,
      )
      .all(who.accountId) as (Row & { eventId: string; displayName: string })[];
    return {
      shared: rows.map((r) => ({ eventId: r.eventId, displayName: r.displayName, listing: toListing(db, r, who.accountId) })),
    };
  });

  /** Share an event, or update what was shared. One contribution per event; matching listings merge. */
  app.put('/pool/share', async (req, reply) => {
    const who = ctx.identity(req);
    const parsed = PoolShareSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(bad(parsed.error.issues[0]?.message ?? 'Check the details.'));
    const body = parsed.data;
    if (who.allowedEventIds && !who.allowedEventIds.includes(body.eventId)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Not your event.' });
    }

    const ev = ownEvent(db, who.accountId, body.eventId);
    if (!ev) return reply.code(404).send({ error: 'not_found', message: 'That event was not found.' });

    // Everything below comes from the event record, bounded here; none of it from the request.
    const clip = (s: unknown, n: number) => cleanText(String(s ?? '')).replace(/[<>]/g, '').slice(0, n);
    const name = cleanText(ev.name ?? '');
    const dateStart = ev.dateStart ?? '';
    const dateEnd = ev.dateEnd || dateStart;
    const city = clip(ev.venue?.city, 80);
    if (!name || name.length > 120 || /[<>]/.test(name)) return reply.code(400).send(bad('Give the event a plain name of up to 120 characters first.'));
    if (!isIsoDate(dateStart) || !isIsoDate(dateEnd) || dateEnd < dateStart) {
      return reply.code(400).send(bad('Set valid start and end dates on the event first.'));
    }
    if ((Date.parse(dateEnd) - Date.parse(dateStart)) / DAY + 1 > POOL_MAX_DAYS) {
      return reply.code(400).send(bad(`Listings can run at most ${POOL_MAX_DAYS} days.`));
    }
    if (!city) return reply.code(400).send(bad("Add the event's city first, so others can find it."));
    const facts: Facts = {
      name,
      edition: body.edition,
      venueName: body.venueName,
      street: clip(ev.venue?.street, 120),
      postcode: clip(ev.venue?.postcode, 20),
      city,
      country: clip(ev.venue?.country, 80),
      dateStart,
      dateEnd,
      url: httpsUrl(body.url),
      description: body.description,
    };

    const existing = db.prepare('SELECT listingId FROM event_pool_contribs WHERE accountId = ? AND eventId = ?').get(who.accountId, body.eventId) as
      | { listingId: string }
      | undefined;
    if (!existing) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM event_pool_contribs WHERE accountId = ?').get(who.accountId) as { n: number };
      if (n.n >= MAX_CONTRIBUTIONS) return reply.code(429).send({ error: 'limit', message: 'Too many shared events - withdraw some first.' });
    }
    if (overLimit(db, who.accountId, 'share', SHARE_LIMIT, HOUR)) {
      return reply.code(429).send({ error: 'rate_limited', message: 'You are sharing too fast - try again in a little while.' });
    }

    const key = poolKey(facts.name, facts.dateStart, facts.city);
    const now = Date.now();
    const listingId = db.transaction(() => {
      noteAction(db, who.accountId, 'share');
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
        `INSERT INTO event_pool_contribs (accountId, eventId, listingId, displayName, facts, updatedAt) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(accountId, eventId) DO UPDATE SET listingId = excluded.listingId, displayName = excluded.displayName,
           facts = excluded.facts, updatedAt = excluded.updatedAt`,
      ).run(who.accountId, body.eventId, listing.id, body.displayName, JSON.stringify(facts), now);
      refreshListing(db, listing.id);
      // An edit that changed name, date or city moves the contribution; tidy up what it left.
      if (existing && existing.listingId !== listing.id) refreshListing(db, existing.listingId);
      return listing.id;
    })();
    return { listing: toListing(db, getListing(db, listingId)!, who.accountId) };
  });

  /** Withdraw an event from the pool. The listing goes with it when nobody else shares it. */
  app.delete<{ Params: { eventId: string } }>('/pool/share/:eventId', async (req, reply) => {
    const who = ctx.identity(req);
    const row = db.prepare('SELECT listingId FROM event_pool_contribs WHERE accountId = ? AND eventId = ?').get(who.accountId, req.params.eventId) as
      | { listingId: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'That event is not shared.' });
    db.transaction(() => {
      db.prepare('DELETE FROM event_pool_contribs WHERE accountId = ? AND eventId = ?').run(who.accountId, req.params.eventId);
      refreshListing(db, row.listingId);
    })();
    return { ok: true };
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
