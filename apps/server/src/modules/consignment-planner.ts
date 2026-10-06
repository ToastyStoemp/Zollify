import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  RentalInputSchema,
  SetupInputSchema,
  SetupResponseSchema,
  SpaceInputSchema,
  UpgradeInputSchema,
  rentalEnd,
  type ConsignmentRental,
  type ConsignmentSpace,
  type Delivery,
  type SalesEvent,
  type SetupMoment,
  type NotificationLevel,
} from '@zollify/shared';
import { isEnabled, type ModuleContext } from '@zollify/server-core';
import { MODULE_ID, accountName, consignorRow, parseDoc, replay, type ConsignorRow } from './consignment';
import type { Side } from './consignment';

/**
 * The consignment planner - the server half.
 *
 * A store rents space to its artists by the month: kinds of space per store
 * ("Small shelf", "Window spot", with a monthly fee and how many there are),
 * rentals of one space for some months, and upgrades that stop one rental
 * and start a bigger one from a date. It also books setup moments - a time
 * for the artist to come in and fill their space - and tells the artist:
 * an in-app notification on their linked account and an email with a
 * calendar file. The artist answers from their side, and the store hears
 * back the same way.
 */

export type Coll = 'spaces' | 'rentals' | 'setups' | 'features' | 'workshops';

export function migratePlanner(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consignment_planner (
      accountId   TEXT NOT NULL,
      coll        TEXT NOT NULL,
      id          TEXT NOT NULL,
      consignorId TEXT,
      doc         TEXT NOT NULL,
      updatedAt   INTEGER NOT NULL,
      PRIMARY KEY (accountId, coll, id)
    );
    CREATE INDEX IF NOT EXISTS idx_consignment_planner_consignor ON consignment_planner(accountId, consignorId);
  `);
}

// ── Storage ─────────────────────────────────────────────────────────────────

export function list<T>(db: Database.Database, accountId: string, coll: Coll, consignorId?: string): T[] {
  const rows = (
    consignorId
      ? db.prepare('SELECT doc FROM consignment_planner WHERE accountId = ? AND coll = ? AND consignorId = ?').all(accountId, coll, consignorId)
      : db.prepare('SELECT doc FROM consignment_planner WHERE accountId = ? AND coll = ?').all(accountId, coll)
  ) as { doc: string }[];
  return rows.map((r) => JSON.parse(r.doc) as T);
}

export function get<T>(db: Database.Database, accountId: string, coll: Coll, id: string): T | undefined {
  const row = db.prepare('SELECT doc FROM consignment_planner WHERE accountId = ? AND coll = ? AND id = ?').get(accountId, coll, id) as
    | { doc: string }
    | undefined;
  return row ? (JSON.parse(row.doc) as T) : undefined;
}

export function put(db: Database.Database, accountId: string, coll: Coll, doc: { id: string; updatedAt: number; consignorId?: string }): void {
  db.prepare(
    `INSERT INTO consignment_planner (accountId, coll, id, consignorId, doc, updatedAt) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(accountId, coll, id) DO UPDATE SET consignorId = excluded.consignorId, doc = excluded.doc, updatedAt = excluded.updatedAt`,
  ).run(accountId, coll, doc.id, doc.consignorId ?? null, JSON.stringify(doc), doc.updatedAt);
}

export const remove = (db: Database.Database, accountId: string, coll: Coll, id: string): number =>
  db.prepare('DELETE FROM consignment_planner WHERE accountId = ? AND coll = ? AND id = ?').run(accountId, coll, id).changes;

const bySoonest = (a: SetupMoment, b: SetupMoment): number => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`);

/** What the artist's side shows of one store: their rentals and setup moments there. */
export function plannerForArtist(db: Database.Database, storeAccountId: string, consignorId: string) {
  const spaces = new Map(list<ConsignmentSpace>(db, storeAccountId, 'spaces').map((s) => [s.id, s]));
  return {
    rentals: list<ConsignmentRental>(db, storeAccountId, 'rentals', consignorId)
      .map((r) => ({ ...r, spaceName: spaces.get(r.spaceId)?.name ?? 'Space' }))
      .sort((a, b) => b.startDate.localeCompare(a.startDate)),
    setups: list<SetupMoment>(db, storeAccountId, 'setups', consignorId).sort(bySoonest),
  };
}

/** The deductible rentals of a store account, for its statement. */
export const rentalsOf = (db: Database.Database, accountId: string): ConsignmentRental[] => list<ConsignmentRental>(db, accountId, 'rentals');

// ── Telling people ──────────────────────────────────────────────────────────

/** The address an account's notices go to: its owner, or failing that an admin. */
export function accountEmail(db: Database.Database, accountId: string): string | null {
  const row = db
    .prepare("SELECT email FROM users WHERE accountId = ? AND role IN ('owner','admin') ORDER BY role = 'owner' DESC, createdAt LIMIT 1")
    .get(accountId) as { email: string } | undefined;
  return row?.email ?? null;
}

export function storeOf(db: Database.Database, accountId: string, storeId: string): SalesEvent | undefined {
  return replay(db, accountId).events.find((e) => e.id === storeId && !e.deletedAt);
}

export const fmtWhen = (s: Pick<SetupMoment, 'date' | 'time' | 'durationMin'>): string => {
  const d = new Date(`${s.date}T00:00:00Z`);
  const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `${day} at ${s.time} (${s.durationMin} min)`;
};

export const address = (e: SalesEvent | undefined): string =>
  [e?.venue?.street, [e?.venue?.postcode, e?.venue?.city].filter(Boolean).join(' '), e?.venue?.country].filter(Boolean).join(', ');

export const icsText = (s: string): string => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** A calendar entry. Floating local time: everyone meets on the store's clock. */
export function buildIcs(e: {
  uid: string;
  /** Must rise with every change, so a calendar replaces the old entry. */
  sequence: number;
  date: string;
  time: string;
  durationMin: number;
  summary: string;
  location?: string;
  description?: string;
}): string {
  const [h, m] = e.time.split(':').map(Number) as [number, number];
  const [y, mo, d] = e.date.split('-').map(Number) as [number, number, number];
  const start = new Date(Date.UTC(y, mo - 1, d, h, m));
  const end = new Date(start.getTime() + e.durationMin * 60_000);
  const local = (t: Date): string => t.toISOString().replace(/[-:]/g, '').slice(0, 15);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Zollify//Consignment//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.uid}@zollify`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${local(start)}`,
    `DTEND:${local(end)}`,
    `SUMMARY:${icsText(e.summary)}`,
    ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** Seconds since creation - rises with every edit, which is all SEQUENCE needs. */
export const icsSequence = (doc: { createdAt: number; updatedAt: number }): number => Math.floor(doc.updatedAt / 1000) - Math.floor(doc.createdAt / 1000);

/** A calendar entry for a setup. */
export function setupIcs(setup: SetupMoment, storeName: string, where: string): string {
  return buildIcs({
    uid: setup.id,
    sequence: icsSequence(setup),
    date: setup.date,
    time: setup.time,
    durationMin: setup.durationMin,
    summary: `Setup at ${storeName}`,
    location: where,
    description: setup.note,
  });
}

/**
 * Tells the artist behind a consignor: a notification on their linked account
 * (whatever modules it runs - the bell is the shell's), and an email to the
 * address the store has for them, else their account's.
 */
export async function tellArtist(
  ctx: ModuleContext,
  storeAccountId: string,
  row: ConsignorRow,
  note: { kind: string; title: string; body: string; subject: string; text: string; ics?: string; level?: NotificationLevel },
): Promise<Delivery> {
  const linked = row.linkedAccountId && accountName(ctx.db, row.linkedAccountId) !== null ? row.linkedAccountId : null;
  if (linked) ctx.notify(linked, { kind: note.kind, title: note.title, body: note.body, link: '/m/consignment-artist', minRole: 'admin', ...(note.level ? { level: note.level } : {}) });
  const to = parseDoc(row.doc).email || (linked ? accountEmail(ctx.db, linked) : null);
  const base = { notified: !!linked };
  if (!to) return { ...base, emailedTo: null, emailSkipped: 'no_address' };
  if (!ctx.mail.enabled) return { ...base, emailedTo: null, emailSkipped: 'not_configured' };
  const replyTo = accountEmail(ctx.db, storeAccountId) ?? undefined;
  const sent = await ctx.mail.send({ to, subject: note.subject, text: note.text, ...(replyTo ? { replyTo } : {}), ...(note.ics ? { ics: note.ics } : {}) });
  return sent ? { ...base, emailedTo: to } : { ...base, emailedTo: null, emailSkipped: 'failed' };
}

// ── Routes ──────────────────────────────────────────────────────────────────

const Id = z.string().min(1).max(80);
const EndBody = z.object({ on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export function registerPlanner(app: FastifyInstance, ctx: ModuleContext, side: Side): void {
  const { db } = ctx;
  const bad = (message: string) => ({ error: 'invalid_request', message });

  if (side === 'store') {
    /** Everything the planner screen needs. */
    app.get('/planner', async (req) => {
      const who = ctx.identity(req);
      return {
        spaces: list<ConsignmentSpace>(db, who.accountId, 'spaces'),
        rentals: list<ConsignmentRental>(db, who.accountId, 'rentals'),
        setups: list<SetupMoment>(db, who.accountId, 'setups').sort(bySoonest),
        emailEnabled: ctx.mail.enabled,
      };
    });
  }

  // ── Spaces ────────────────────────────────────────────────────────────────

  if (side === 'store') {
    app.put<{ Params: { id: string } }>('/spaces/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const id = Id.safeParse(req.params.id);
      const body = SpaceInputSchema.safeParse(req.body);
      if (!id.success || !body.success) return reply.code(400).send(bad('A space needs a store, a name and a monthly fee.'));
      const existing = get<ConsignmentSpace>(db, who.accountId, 'spaces', id.data);
      const now = Date.now();
      const space: ConsignmentSpace = { ...body.data, id: id.data, createdAt: existing?.createdAt ?? now, updatedAt: now };
      put(db, who.accountId, 'spaces', space);
      return { space };
    });

    /** A space someone has rented stays for the record - archive it instead. */
    app.delete<{ Params: { id: string } }>('/spaces/:id', async (req, reply) => {
      const who = ctx.identity(req);
      if (list<ConsignmentRental>(db, who.accountId, 'rentals').some((r) => r.spaceId === req.params.id)) {
        return reply.code(409).send({ error: 'in_use', message: 'This space has rentals on record - archive it instead.' });
      }
      if (!remove(db, who.accountId, 'spaces', req.params.id)) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    });
  }

  // ── Rentals ───────────────────────────────────────────────────────────────

  /** The space and artist must be this account's, and the space must be at the rental's store. */
  function checkRental(accountId: string, r: { consignorId: string; storeId: string; spaceId: string }): string | null {
    if (!consignorRow(db, accountId, r.consignorId)) return 'No such artist.';
    const space = get<ConsignmentSpace>(db, accountId, 'spaces', r.spaceId);
    if (!space || space.storeId !== r.storeId) return 'That space is not at this store.';
    return null;
  }

  async function announceRental(accountId: string, rental: ConsignmentRental, what: string): Promise<Delivery> {
    const row = consignorRow(db, accountId, rental.consignorId)!;
    const space = get<ConsignmentSpace>(db, accountId, 'spaces', rental.spaceId);
    const store = storeOf(db, accountId, rental.storeId);
    const line = `${space?.name ?? 'Space'} at ${store?.name ?? 'the store'}, ${rental.startDate} to ${rentalEnd(rental)} (${rental.months} month${rental.months === 1 ? '' : 's'}, ${rental.currency} ${rental.monthlyFee.toFixed(2)}/month)`;
    // Rentals are agreed in person; the in-app note is a record of it, not news worth an email.
    const linked = row.linkedAccountId && accountName(db, row.linkedAccountId) !== null ? row.linkedAccountId : null;
    if (linked) ctx.notify(linked, { kind: 'planner', title: `${what}: ${space?.name ?? 'space'} at ${accountName(db, accountId)}`, body: line, link: '/m/consignment-artist', minRole: 'admin' });
    return { notified: !!linked, emailedTo: null };
  }

  if (side === 'store') {
    app.post('/rentals', async (req, reply) => {
      const who = ctx.identity(req);
      const body = RentalInputSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad('A rental needs an artist, a space, a start date and a number of months.'));
      const problem = checkRental(who.accountId, body.data);
      if (problem) return reply.code(400).send(bad(problem));
      const now = Date.now();
      const rental: ConsignmentRental = { ...body.data, id: randomUUID(), endedOn: null, upgradedFromId: null, createdAt: now, updatedAt: now };
      put(db, who.accountId, 'rentals', rental);
      return reply.code(201).send({ rental, delivery: await announceRental(who.accountId, rental, 'Space booked') });
    });

    /** Edits a rental in place - extending it is changing its months. */
    app.put<{ Params: { id: string } }>('/rentals/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const existing = get<ConsignmentRental>(db, who.accountId, 'rentals', req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      const body = RentalInputSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad('That rental is not valid.'));
      const problem = checkRental(who.accountId, body.data);
      if (problem) return reply.code(400).send(bad(problem));
      const rental: ConsignmentRental = { ...existing, ...body.data, updatedAt: Date.now() };
      put(db, who.accountId, 'rentals', rental);
      return { rental };
    });

    /**
     * Moves the artist to another space from a date: the current rental stops
     * there and a new one starts, so both stay on record with their own price.
     */
    app.post<{ Params: { id: string } }>('/rentals/:id/upgrade', async (req, reply) => {
      const who = ctx.identity(req);
      const old = get<ConsignmentRental>(db, who.accountId, 'rentals', req.params.id);
      if (!old) return reply.code(404).send({ error: 'not_found' });
      const body = UpgradeInputSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad('An upgrade needs a space, a start date and a number of months.'));
      const { spaceId, from, months, monthlyFee } = body.data;
      if (from <= old.startDate || from > rentalEnd(old)) {
        return reply.code(400).send(bad(`Start the upgrade after ${old.startDate} and no later than ${rentalEnd(old)} - edit the rental instead to change it from its start.`));
      }
      const problem = checkRental(who.accountId, { consignorId: old.consignorId, storeId: old.storeId, spaceId });
      if (problem) return reply.code(400).send(bad(problem));
      const space = get<ConsignmentSpace>(db, who.accountId, 'spaces', spaceId)!;
      const now = Date.now();
      const next: ConsignmentRental = {
        id: randomUUID(),
        consignorId: old.consignorId,
        storeId: old.storeId,
        spaceId,
        startDate: from,
        months,
        monthlyFee,
        currency: space.currency,
        deductFromSales: old.deductFromSales,
        note: '',
        endedOn: null,
        upgradedFromId: old.id,
        createdAt: now,
        updatedAt: now,
      };
      db.transaction(() => {
        const ended: ConsignmentRental = { ...old, endedOn: from, updatedAt: now };
        if (from < rentalEnd(old)) put(db, who.accountId, 'rentals', ended);
        put(db, who.accountId, 'rentals', next);
      })();
      return reply.code(201).send({ rental: next, delivery: await announceRental(who.accountId, next, 'Space upgraded') });
    });

    /** Stops a rental early; months that have not started are no longer charged. */
    app.post<{ Params: { id: string } }>('/rentals/:id/end', async (req, reply) => {
      const who = ctx.identity(req);
      const r = get<ConsignmentRental>(db, who.accountId, 'rentals', req.params.id);
      if (!r) return reply.code(404).send({ error: 'not_found' });
      const body = EndBody.safeParse(req.body);
      if (!body.success || body.data.on < r.startDate) return reply.code(400).send(bad(`End it on or after ${r.startDate}.`));
      const rental = { ...r, endedOn: body.data.on, updatedAt: Date.now() };
      put(db, who.accountId, 'rentals', rental);
      return { rental };
    });

    app.delete<{ Params: { id: string } }>('/rentals/:id', async (req, reply) => {
      const who = ctx.identity(req);
      if (!remove(db, who.accountId, 'rentals', req.params.id)) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    });
  }

  // ── Setup moments ─────────────────────────────────────────────────────────

  async function announceSetup(accountId: string, setup: SetupMoment, kind: 'new' | 'moved' | 'cancelled'): Promise<Delivery> {
    const row = consignorRow(db, accountId, setup.consignorId)!;
    const store = storeOf(db, accountId, setup.storeId);
    const storeName = store?.name ?? 'the store';
    const owner = accountName(db, accountId) ?? storeName;
    const where = address(store);
    const when = fmtWhen(setup);
    const head = { new: 'Setup scheduled', moved: 'Setup moved', cancelled: 'Setup cancelled' }[kind];
    const lines = [
      `Hi ${parseDoc(row.doc).name},`,
      '',
      kind === 'cancelled'
        ? `${owner} has cancelled your setup at ${storeName} on ${when}.`
        : `${owner} has ${kind === 'moved' ? 'moved your setup at' : 'scheduled a setup for you at'} ${storeName}:`,
      ...(kind === 'cancelled' ? [] : ['', `  ${when}`, ...(where ? [`  ${where}`] : [])]),
      ...(setup.note && kind !== 'cancelled' ? ['', setup.note] : []),
      '',
      kind === 'cancelled'
        ? 'Reply to this email if you have questions.'
        : 'Confirm or let them know you cannot make it in Zollify under Stores → My stores, or reply to this email.',
    ];
    // A setup to confirm is the one thing here that needs an answer soon.
    return tellArtist(ctx, accountId, row, { kind: 'planner', level: kind === 'cancelled' ? 'normal' : 'urgent',
      title: `${head} at ${storeName}`,
      body: kind === 'cancelled' ? `${when} is off.` : `${when}${where ? ` · ${where}` : ''}`,
      subject: `${head}: ${storeName}, ${setup.date} ${setup.time}`,
      text: lines.join('\n'),
      ...(kind === 'cancelled' ? {} : { ics: setupIcs(setup, storeName, where) }),
    });
  }

  if (side === 'store') {
    app.post('/setups', async (req, reply) => {
      const who = ctx.identity(req);
      const body = SetupInputSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad('A setup needs an artist, a store, a date and a time.'));
      if (!consignorRow(db, who.accountId, body.data.consignorId)) return reply.code(404).send({ error: 'not_found', message: 'No such artist.' });
      const now = Date.now();
      const setup: SetupMoment = { ...body.data, id: randomUUID(), status: 'scheduled', artistNote: '', respondedAt: null, createdAt: now, updatedAt: now };
      put(db, who.accountId, 'setups', setup);
      return reply.code(201).send({ setup, delivery: await announceSetup(who.accountId, setup, 'new') });
    });

    /** Moving a setup asks the artist again: whatever they said about the old time no longer holds. */
    app.put<{ Params: { id: string } }>('/setups/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const existing = get<SetupMoment>(db, who.accountId, 'setups', req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      const body = SetupInputSchema.safeParse(req.body);
      if (!body.success || body.data.consignorId !== existing.consignorId) return reply.code(400).send(bad('That setup is not valid.'));
      const moved = body.data.date !== existing.date || body.data.time !== existing.time || body.data.storeId !== existing.storeId;
      const setup: SetupMoment = {
        ...existing,
        ...body.data,
        ...(moved ? { status: 'scheduled' as const, artistNote: '', respondedAt: null } : {}),
        updatedAt: Date.now(),
      };
      put(db, who.accountId, 'setups', setup);
      return { setup, delivery: moved ? await announceSetup(who.accountId, setup, 'moved') : null };
    });

    app.post<{ Params: { id: string } }>('/setups/:id/cancel', async (req, reply) => {
      const who = ctx.identity(req);
      const existing = get<SetupMoment>(db, who.accountId, 'setups', req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (existing.status === 'cancelled') return { setup: existing, delivery: null };
      const setup: SetupMoment = { ...existing, status: 'cancelled', updatedAt: Date.now() };
      put(db, who.accountId, 'setups', setup);
      return { setup, delivery: await announceSetup(who.accountId, setup, 'cancelled') };
    });

    /**
     * Removes a setup from the planner altogether. One still on and still to
     * come is called off first, so the artist is never left expecting it; one
     * with a missed-setup fee charged stays, as the fee's record.
     */
    app.delete<{ Params: { id: string } }>('/setups/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const existing = get<SetupMoment>(db, who.accountId, 'setups', req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      const fee = db
        .prepare("SELECT 1 FROM consignment_fees WHERE accountId = ? AND json_extract(doc, '$.setupId') = ? AND json_extract(doc, '$.status') = 'charged'")
        .get(who.accountId, existing.id);
      if (fee) return reply.code(409).send(bad('A fee is charged for this setup - waive the fee first, then remove the setup.'));
      let delivery: Delivery | null = null;
      if (existing.status !== 'cancelled' && existing.date >= new Date().toISOString().slice(0, 10)) {
        delivery = await announceSetup(who.accountId, { ...existing, status: 'cancelled', updatedAt: Date.now() }, 'cancelled');
      }
      remove(db, who.accountId, 'setups', existing.id);
      return { ok: true, delivery };
    });
  }

  // ── The artist answering ──────────────────────────────────────────────────

  if (side === 'artist') {
    /**
     * The artist's account confirms or declines a setup at a store it is
     * linked to. The link is checked here, so a setup id alone gets nowhere.
     */
    app.post<{ Params: { storeAccountId: string; consignorId: string; id: string } }>(
      '/links/:storeAccountId/:consignorId/setups/:id/respond',
      async (req, reply) => {
        const who = ctx.identity(req);
        const { storeAccountId, consignorId, id } = req.params;
        const row = consignorRow(db, storeAccountId, consignorId);
        if (!row || row.linkedAccountId !== who.accountId || !isEnabled(db, storeAccountId, MODULE_ID)) return reply.code(404).send({ error: 'not_found' });
        const existing = get<SetupMoment>(db, storeAccountId, 'setups', id);
        if (!existing || existing.consignorId !== consignorId) return reply.code(404).send({ error: 'not_found' });
        if (existing.status === 'cancelled') return reply.code(409).send({ error: 'cancelled', message: 'The store has cancelled this setup.' });
        const body = SetupResponseSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send(bad('Confirm or decline.'));
        const now = Date.now();
        const setup: SetupMoment = { ...existing, status: body.data.status, artistNote: body.data.note.trim(), respondedAt: now, updatedAt: now };
        put(db, storeAccountId, 'setups', setup);

        // Back to the store: the bell for its admins, and an email to its owner.
        const artist = parseDoc(row.doc).name;
        const store = storeOf(db, storeAccountId, setup.storeId);
        const verb = setup.status === 'confirmed' ? 'confirmed' : "can't make";
        const title = `${artist} ${verb} the setup on ${setup.date} ${setup.time}`;
        ctx.notify(storeAccountId, { kind: 'planner', level: setup.status === 'declined' ? 'urgent' : 'normal', title, body: setup.artistNote || (store ? `At ${store.name}.` : ''), link: '/m/consignment/planner', minRole: 'admin' });
        const to = accountEmail(db, storeAccountId);
        if (to && ctx.mail.enabled) {
          const replyTo = accountEmail(db, who.accountId) ?? undefined;
          await ctx.mail.send({
            to,
            subject: title,
            text: [`${title}${store ? ` at ${store.name}` : ''}.`, ...(setup.artistNote ? ['', setup.artistNote] : [])].join('\n'),
            ...(replyTo ? { replyTo } : {}),
          });
        }
        return { setup };
      },
    );
  }
}
