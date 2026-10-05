import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  FeatureInputSchema,
  SignupInputSchema,
  WorkshopInputSchema,
  placeSignup,
  promoteFromWaitlist,
  seatsTaken,
  seatsWaiting,
  type PublicProgramme,
  type SalesEvent,
  type Signup,
  type StoreFeature,
  type Workshop,
} from '@zollify/shared';
import { issueChallenge, verifyChallenge, type Mailer, type ModuleContext, type PublicModuleContext } from '@zollify/server-core';
import { accountName, consignorRow, parseDoc, replay } from './consignment';
import { accountEmail, address, buildIcs, fmtWhen, get, icsSequence, list, put, remove, tellArtist } from './consignment-planner';
import { POW_SOLVER_JS } from './pow-client';

/**
 * A store's programme - the server half.
 *
 * Features ("artist of the month") and workshops live with the rest of the
 * planner's documents. The discount a feature promises is an ordinary core
 * discount rule, written by the client through the SDK so it syncs to every
 * till; the server only keeps the feature itself and tells the artist.
 *
 * Workshops take sign-ups on a public page, `/p/consignment/s/<token>`. The
 * token is the only thing that page knows about the account, and the owner
 * can replace it to retire a link. Signing up costs a proof-of-work and a
 * rate limit; seats are placed inside one transaction so two people can never
 * take the last seat. Each sign-up gets a cancel link with its own random
 * token, of which only a hash is kept.
 */

export function migrateProgramme(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consignment_signups (
      accountId  TEXT NOT NULL,
      id         TEXT NOT NULL,
      workshopId TEXT NOT NULL,
      doc        TEXT NOT NULL,
      tokenHash  TEXT UNIQUE,
      createdAt  INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_consignment_signups_workshop ON consignment_signups(accountId, workshopId);
    CREATE TABLE IF NOT EXISTS consignment_public (
      accountId TEXT PRIMARY KEY,
      token     TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL
    );
  `);
}

// ── Storage ─────────────────────────────────────────────────────────────────

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const newToken = (): string => randomBytes(16).toString('base64url');
const today = (): string => new Date().toISOString().slice(0, 10);

function signupsOf(db: Database.Database, accountId: string, workshopId: string): Signup[] {
  return (db.prepare('SELECT doc FROM consignment_signups WHERE accountId = ? AND workshopId = ? ORDER BY createdAt').all(accountId, workshopId) as { doc: string }[]).map(
    (r) => JSON.parse(r.doc) as Signup,
  );
}

function saveSignup(db: Database.Database, accountId: string, s: Signup, tokenHash?: string): void {
  db.prepare(
    `INSERT INTO consignment_signups (accountId, id, workshopId, doc, tokenHash, createdAt) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(accountId, id) DO UPDATE SET doc = excluded.doc`,
  ).run(accountId, s.id, s.workshopId, JSON.stringify(s), tokenHash ?? null, s.createdAt);
}

function publicToken(db: Database.Database, accountId: string): string {
  const row = db.prepare('SELECT token FROM consignment_public WHERE accountId = ?').get(accountId) as { token: string } | undefined;
  if (row) return row.token;
  const token = newToken();
  db.prepare('INSERT INTO consignment_public (accountId, token, createdAt) VALUES (?, ?, ?)').run(accountId, token, Date.now());
  return token;
}

const accountForToken = (db: Database.Database, token: string): string | null =>
  (db.prepare('SELECT accountId FROM consignment_public WHERE token = ?').get(token) as { accountId: string } | undefined)?.accountId ?? null;

const eventsById = (db: Database.Database, accountId: string): Map<string, SalesEvent> =>
  new Map(replay(db, accountId).events.filter((e) => !e.deletedAt).map((e) => [e.id, e]));

/** The origin people reach this server at, honouring a reverse proxy, for links in emails. */
function originOf(req: FastifyRequest): string {
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0]!.trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0]!.trim();
  return `${proto}://${host}`;
}

const cancelUrl = (origin: string, token: string): string => `${origin}/p/consignment/cancel#${token}`;

/** Counts the owner's screens show next to a workshop. */
function withCounts(db: Database.Database, accountId: string, w: Workshop) {
  const signups = signupsOf(db, accountId, w.id);
  return { ...w, booked: seatsTaken(signups), waiting: seatsWaiting(signups), signups: signups.filter((s) => s.status !== 'cancelled').length };
}

// ── Telling participants ────────────────────────────────────────────────────

type Notice = 'booked' | 'waitlist' | 'promoted' | 'moved' | 'cancelled' | 'left';

/**
 * One email to one participant. Never in the way: a server without email, a
 * store-added sign-up without an address, a mail server that is down - the
 * booking itself already happened.
 */
async function tellParticipant(
  mail: Mailer,
  db: Database.Database,
  accountId: string,
  w: Workshop,
  s: Signup,
  kind: Notice,
  link: string | null,
): Promise<boolean> {
  if (!s.email || !mail.enabled) return false;
  const store = eventsById(db, accountId).get(w.storeId);
  const shop = accountName(db, accountId) ?? 'The store';
  const where = address(store);
  const when = fmtWhen(w);
  const seats = `${s.seats} place${s.seats === 1 ? '' : 's'}`;
  const price = w.price > 0 ? `${w.currency} ${w.price.toFixed(2)} per place, paid at the store.` : 'Free.';
  const head: Record<Notice, string> = {
    booked: `You're booked: ${w.title}`,
    waitlist: `You're on the waitlist: ${w.title}`,
    promoted: `A place opened up - you're booked: ${w.title}`,
    moved: `${w.title} has moved`,
    cancelled: `Cancelled: ${w.title}`,
    left: `You've cancelled: ${w.title}`,
  };
  const body: Record<Notice, string[]> = {
    booked: [`${seats} for ${w.title} at ${store?.name ?? shop}.`, '', `  ${when}`, ...(where ? [`  ${where}`] : []), '', price],
    waitlist: [`${w.title} is full, so you're on the waitlist for ${seats}. If a place frees up we'll book you and email you.`, '', `  ${when}`],
    promoted: [`Someone cancelled, so your ${seats} for ${w.title} at ${store?.name ?? shop} are now booked.`, '', `  ${when}`, ...(where ? [`  ${where}`] : []), '', price],
    moved: [`${w.title} has a new time:`, '', `  ${when}`, ...(where ? [`  ${where}`] : []), '', s.status === 'waitlist' ? "You're still on the waitlist." : `Your ${seats} moved with it.`],
    cancelled: [`${shop} has called off ${w.title} on ${w.date}. You don't need to do anything.`],
    left: [`Your ${seats} for ${w.title} on ${w.date} ${s.status === 'waitlist' ? 'are off the waitlist' : 'are cancelled'}.`],
  };
  const canLeave = link && (kind === 'booked' || kind === 'waitlist' || kind === 'promoted' || kind === 'moved');
  const text = [`Hi ${s.name},`, '', ...body[kind], ...(canLeave ? ['', `Can't make it? Cancel here so someone else can come: ${link}`] : []), '', `- ${shop}`].join('\n');
  const withCalendar = kind === 'booked' || kind === 'promoted' || (kind === 'moved' && s.status === 'booked');
  const replyTo = accountEmail(db, accountId) ?? undefined;
  return mail.send({
    to: s.email,
    subject: head[kind],
    text,
    ...(replyTo ? { replyTo } : {}),
    ...(withCalendar
      ? { ics: buildIcs({ uid: w.id, sequence: icsSequence(w), date: w.date, time: w.time, durationMin: w.durationMin, summary: w.title, location: where, description: w.description }) }
      : {}),
  });
}

/**
 * Seats freed up: book whoever is next on the waitlist and tell them. Their
 * cancel link is not re-sent - only its hash is kept - so the email points
 * them at the one they already have.
 */
async function promote(mail: Mailer, db: Database.Database, accountId: string, w: Workshop): Promise<number> {
  if (w.cancelledAt) return 0;
  const moved = db.transaction(() => {
    const all = signupsOf(db, accountId, w.id);
    const ids = new Set(promoteFromWaitlist(w, all));
    const out = all.filter((s) => ids.has(s.id)).map((s) => ({ ...s, status: 'booked' as const }));
    for (const s of out) saveSignup(db, accountId, s);
    return out;
  })();
  for (const s of moved) await tellParticipant(mail, db, accountId, w, s, 'promoted', null);
  return moved.length;
}

// ── The owner's side ────────────────────────────────────────────────────────

const StoreSignupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().email().max(254)]).default(''),
  seats: z.number().int().min(1).max(50).default(1),
  note: z.string().trim().max(500).default(''),
  paid: z.boolean().default(false),
});
const SignupPatchSchema = z.object({ paid: z.boolean().optional(), status: z.enum(['booked', 'cancelled']).optional() });

export function registerProgramme(app: FastifyInstance, ctx: ModuleContext): void {
  const { db } = ctx;
  const bad = (message: string) => ({ error: 'invalid_request', message });

  app.get('/programme', async (req) => {
    const who = ctx.identity(req);
    return {
      features: list<StoreFeature>(db, who.accountId, 'features').sort((a, b) => b.startDate.localeCompare(a.startDate)),
      workshops: list<Workshop>(db, who.accountId, 'workshops')
        .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))
        .map((w) => withCounts(db, who.accountId, w)),
      publicPath: `/p/consignment/s/${publicToken(db, who.accountId)}`,
      emailEnabled: ctx.mail.enabled,
    };
  });

  /** A new address for the sign-up page; the old one stops working. */
  app.post('/programme/link', async (req) => {
    const who = ctx.identity(req);
    const token = newToken();
    db.prepare(
      'INSERT INTO consignment_public (accountId, token, createdAt) VALUES (?, ?, ?) ON CONFLICT(accountId) DO UPDATE SET token = excluded.token, createdAt = excluded.createdAt',
    ).run(who.accountId, token, Date.now());
    return { publicPath: `/p/consignment/s/${token}` };
  });

  // ── Features ──────────────────────────────────────────────────────────────

  app.put<{ Params: { id: string } }>('/features/:id', async (req, reply) => {
    const who = ctx.identity(req);
    const body = FeatureInputSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'That feature is not valid.'));
    const row = consignorRow(db, who.accountId, body.data.consignorId);
    if (!row) return reply.code(404).send(bad('No such artist.'));
    const existing = get<StoreFeature>(db, who.accountId, 'features', req.params.id);
    const now = Date.now();
    const feature: StoreFeature = { ...body.data, id: req.params.id, createdAt: existing?.createdAt ?? now, updatedAt: now };
    put(db, who.accountId, 'features', { ...feature, consignorId: feature.consignorId });

    // Tell the artist when they are newly featured or their dates or discount change.
    const news = !existing || existing.consignorId !== feature.consignorId || existing.startDate !== feature.startDate || existing.endDate !== feature.endDate || existing.discountPct !== feature.discountPct;
    if (!news) return { feature, delivery: null };
    const stores = eventsById(db, who.accountId);
    const where = feature.storeIds.map((id) => stores.get(id)?.name).filter(Boolean).join(', ') || accountName(db, who.accountId) || 'the store';
    const title = feature.title || 'Artist of the month';
    const off = feature.discountPct ? ` Your work is ${feature.discountPct}% off at the till during it.` : '';
    const delivery = await tellArtist(ctx, who.accountId, row, {
      title: `You're featured: ${title} at ${where}`,
      body: `${feature.startDate} to ${feature.endDate}.${off}`,
      subject: `You're featured at ${where}: ${feature.startDate} to ${feature.endDate}`,
      text: [`Hi ${parseDoc(row.doc).name},`, '', `${accountName(db, who.accountId)} is featuring you - "${title}" - at ${where} from ${feature.startDate} to ${feature.endDate}.${off}`, ...(feature.description ? ['', feature.description] : [])].join('\n'),
    });
    return { feature, delivery };
  });

  app.delete<{ Params: { id: string } }>('/features/:id', async (req, reply) => {
    const who = ctx.identity(req);
    if (!remove(db, who.accountId, 'features', req.params.id)) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // ── Workshops ─────────────────────────────────────────────────────────────

  app.put<{ Params: { id: string } }>('/workshops/:id', async (req, reply) => {
    const who = ctx.identity(req);
    const body = WorkshopInputSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'That workshop is not valid.'));
    if (!eventsById(db, who.accountId).has(body.data.storeId)) return reply.code(400).send(bad('No such store.'));
    const host = body.data.hostConsignorId ? consignorRow(db, who.accountId, body.data.hostConsignorId) : null;
    if (body.data.hostConsignorId && !host) return reply.code(400).send(bad('No such artist.'));
    const existing = get<Workshop>(db, who.accountId, 'workshops', req.params.id);
    if (existing?.cancelledAt) return reply.code(409).send(bad('This workshop was cancelled.'));
    const signups = existing ? signupsOf(db, who.accountId, existing.id) : [];
    if (seatsTaken(signups) > body.data.capacity) {
      return reply.code(409).send(bad(`${seatsTaken(signups)} places are already booked - cancel some first, or keep at least that many.`));
    }
    const now = Date.now();
    const w: Workshop = { ...body.data, id: req.params.id, cancelledAt: null, createdAt: existing?.createdAt ?? now, updatedAt: now };
    put(db, who.accountId, 'workshops', { ...w, ...(w.hostConsignorId ? { consignorId: w.hostConsignorId } : {}) });

    // A new time or place: everyone who signed up hears about it.
    const moved = existing && (existing.date !== w.date || existing.time !== w.time || existing.storeId !== w.storeId);
    if (moved) for (const s of signups.filter((x) => x.status !== 'cancelled')) await tellParticipant(ctx.mail, db, who.accountId, w, s, 'moved', null);
    // More room: the waitlist moves up.
    const promoted = existing ? await promote(ctx.mail, db, who.accountId, w) : 0;

    // The host hears when they are newly hosting or the time changes.
    let delivery = null;
    if (host && (!existing || existing.hostConsignorId !== w.hostConsignorId || moved)) {
      const store = eventsById(db, who.accountId).get(w.storeId);
      delivery = await tellArtist(ctx, who.accountId, host, {
        title: `${existing?.hostConsignorId === w.hostConsignorId ? 'Workshop moved' : "You're hosting"}: ${w.title}`,
        body: `${fmtWhen(w)} at ${store?.name ?? 'the store'}`,
        subject: `Workshop: ${w.title}, ${w.date} ${w.time}`,
        text: [`Hi ${parseDoc(host.doc).name},`, '', `You're down to host "${w.title}" at ${store?.name ?? 'the store'}:`, '', `  ${fmtWhen(w)}`, ...(address(store) ? [`  ${address(store)}`] : []), '', `${w.capacity} places.`].join('\n'),
        ics: buildIcs({ uid: w.id, sequence: icsSequence(w), date: w.date, time: w.time, durationMin: w.durationMin, summary: w.title, location: address(store), description: w.description }),
      });
    }
    return { workshop: withCounts(db, who.accountId, w), promoted, delivery };
  });

  /** Calls a workshop off. Everyone signed up is told; nothing is deleted. */
  app.post<{ Params: { id: string } }>('/workshops/:id/cancel', async (req, reply) => {
    const who = ctx.identity(req);
    const existing = get<Workshop>(db, who.accountId, 'workshops', req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    if (existing.cancelledAt) return { workshop: withCounts(db, who.accountId, existing), told: 0 };
    const w: Workshop = { ...existing, cancelledAt: Date.now(), signupsOpen: false, updatedAt: Date.now() };
    put(db, who.accountId, 'workshops', { ...w, ...(w.hostConsignorId ? { consignorId: w.hostConsignorId } : {}) });
    let told = 0;
    for (const s of signupsOf(db, who.accountId, w.id).filter((x) => x.status !== 'cancelled')) {
      if (await tellParticipant(ctx.mail, db, who.accountId, w, s, 'cancelled', null)) told++;
    }
    return { workshop: withCounts(db, who.accountId, w), told };
  });

  app.delete<{ Params: { id: string } }>('/workshops/:id', async (req, reply) => {
    const who = ctx.identity(req);
    if (signupsOf(db, who.accountId, req.params.id).length) {
      return reply.code(409).send(bad('People have signed up - cancel the workshop instead, so they are told.'));
    }
    if (!remove(db, who.accountId, 'workshops', req.params.id)) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/workshops/:id/signups', async (req, reply) => {
    const who = ctx.identity(req);
    if (!get<Workshop>(db, who.accountId, 'workshops', req.params.id)) return reply.code(404).send({ error: 'not_found' });
    return { signups: signupsOf(db, who.accountId, req.params.id) };
  });

  /** The store books someone itself - a phone call, someone at the counter. */
  app.post<{ Params: { id: string } }>('/workshops/:id/signups', async (req, reply) => {
    const who = ctx.identity(req);
    const w = get<Workshop>(db, who.accountId, 'workshops', req.params.id);
    if (!w || w.cancelledAt) return reply.code(404).send({ error: 'not_found' });
    const body = StoreSignupSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send(bad('A sign-up needs a name.'));
    const token = newToken();
    const result = db.transaction(() => {
      const place = placeSignup(w, signupsOf(db, who.accountId, w.id), body.data.seats);
      if (place === 'full') return null;
      const s: Signup = { id: randomUUID(), workshopId: w.id, ...body.data, status: place, source: 'store', createdAt: Date.now(), cancelledAt: null };
      saveSignup(db, who.accountId, s, sha256(token));
      return s;
    })();
    if (!result) return reply.code(409).send(bad('There are not enough places left.'));
    const emailed = await tellParticipant(ctx.mail, db, who.accountId, w, result, result.status === 'booked' ? 'booked' : 'waitlist', cancelUrl(originOf(req), token));
    return reply.code(201).send({ signup: result, emailed });
  });

  app.put<{ Params: { id: string } }>('/signups/:id', async (req, reply) => {
    const who = ctx.identity(req);
    const row = db.prepare('SELECT doc FROM consignment_signups WHERE accountId = ? AND id = ?').get(who.accountId, req.params.id) as { doc: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const body = SignupPatchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send(bad('That change is not valid.'));
    const current = JSON.parse(row.doc) as Signup;
    const w = get<Workshop>(db, who.accountId, 'workshops', current.workshopId)!;
    let next: Signup = { ...current, ...(body.data.paid !== undefined ? { paid: body.data.paid } : {}) };
    if (body.data.status === 'cancelled' && current.status !== 'cancelled') next = { ...next, status: 'cancelled', cancelledAt: Date.now() };
    // Booking someone off the waitlist by hand is the store's call, even over capacity.
    if (body.data.status === 'booked' && current.status === 'waitlist') next = { ...next, status: 'booked' };
    saveSignup(db, who.accountId, next);
    if (next.status !== current.status && next.status === 'booked') await tellParticipant(ctx.mail, db, who.accountId, w, next, 'promoted', null);
    const promoted = next.status === 'cancelled' && current.status === 'booked' ? await promote(ctx.mail, db, who.accountId, w) : 0;
    return { signup: next, promoted };
  });
}

/** What a linked artist sees of the programme: features of them, workshops they host. */
export function programmeForArtist(db: Database.Database, storeAccountId: string, consignorId: string) {
  return {
    features: list<StoreFeature>(db, storeAccountId, 'features').filter((f) => f.consignorId === consignorId && f.endDate >= today()),
    workshops: list<Workshop>(db, storeAccountId, 'workshops')
      .filter((w) => w.hostConsignorId === consignorId && w.date >= today())
      .map((w) => {
        const signups = signupsOf(db, storeAccountId, w.id);
        return { id: w.id, title: w.title, storeId: w.storeId, date: w.date, time: w.time, durationMin: w.durationMin, capacity: w.capacity, booked: seatsTaken(signups), cancelled: !!w.cancelledAt };
      }),
  };
}

// ── The public page ─────────────────────────────────────────────────────────

const DIFFICULTY = Math.min(22, Math.max(10, Number(process.env.SIGNUP_CAPTCHA_BITS || 15)));
const SIGNUP_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, bodyLimit: 4096 };

/** The page as the world sees it: published, current, and only the fields picked here. */
function publicProgramme(db: Database.Database, accountId: string): PublicProgramme {
  const stores = eventsById(db, accountId);
  const day = today();
  const artist = (id: string | null): string | null => (id ? (consignorRow(db, accountId, id) ? parseDoc(consignorRow(db, accountId, id)!.doc).name : null) : null);
  return {
    name: accountName(db, accountId) ?? '',
    features: list<StoreFeature>(db, accountId, 'features')
      .filter((f) => f.published && f.endDate >= day)
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
      .map((f) => ({
        id: f.id,
        artist: artist(f.consignorId) ?? '',
        title: f.title || 'Artist of the month',
        description: f.description,
        startDate: f.startDate,
        endDate: f.endDate,
        discountPct: f.discountPct,
        stores: f.storeIds.map((id) => stores.get(id)?.name).filter((n): n is string => !!n),
      })),
    workshops: list<Workshop>(db, accountId, 'workshops')
      .filter((w) => w.published && !w.cancelledAt && w.date >= day && stores.has(w.storeId))
      .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))
      .map((w) => {
        const signups = signupsOf(db, accountId, w.id);
        const left = Math.max(0, w.capacity - seatsTaken(signups));
        const waiting = seatsWaiting(signups) > 0;
        const availability = !w.signupsOpen ? 'closed' : left > 0 && !waiting ? 'open' : w.waitlist ? 'waitlist' : 'full';
        return {
          id: w.id,
          title: w.title,
          description: w.description,
          date: w.date,
          time: w.time,
          durationMin: w.durationMin,
          store: stores.get(w.storeId)!.name,
          address: address(stores.get(w.storeId)),
          host: artist(w.hostConsignorId),
          price: w.price,
          currency: w.currency,
          seatsLeft: waiting ? 0 : left,
          availability,
        };
      }),
  };
}

export function registerProgrammePublic(app: FastifyInstance, ctx: PublicModuleContext): void {
  const { db } = ctx;
  const live = (token: string): string | null => {
    const accountId = accountForToken(db, token);
    return accountId && ctx.isEnabled(accountId) ? accountId : null;
  };

  // Personal details travel here; nothing is cached or indexed but the page itself.
  app.addHook('onSend', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    if (req.url.startsWith('/p/consignment/cancel')) reply.header('x-robots-tag', 'noindex, nofollow');
  });

  app.get('/s/:token', async (_req, reply) => reply.type('text/html; charset=utf-8').send(PAGE));
  app.get('/programme.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').send(SCRIPT));
  app.get('/challenge', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => issueChallenge('signup', DIFFICULTY));

  app.get<{ Params: { token: string } }>('/s/:token/data', async (req, reply) => {
    const accountId = live(req.params.token);
    if (!accountId) return reply.code(404).send({ error: 'not_found' });
    return publicProgramme(db, accountId);
  });

  app.post<{ Params: { token: string; id: string }; Body: Record<string, unknown> }>('/s/:token/workshops/:id/signup', SIGNUP_LIMIT, async (req, reply) => {
    const accountId = live(req.params.token);
    if (!accountId) return reply.code(404).send({ error: 'not_found' });
    const body = req.body ?? {};
    if (!verifyChallenge(String(body.captchaToken ?? ''), String(body.captchaSolution ?? ''), 'signup').ok) {
      return reply.code(403).send({ error: 'challenge_failed', message: 'Please try again.' });
    }
    const input = SignupInputSchema.safeParse(body);
    if (!input.success) return reply.code(400).send({ error: 'invalid', message: 'Enter your name and a valid email address.' });
    const w = get<Workshop>(db, accountId, 'workshops', req.params.id);
    if (!w || !w.published || w.cancelledAt || w.date < today()) return reply.code(404).send({ error: 'not_found' });
    if (!w.signupsOpen) return reply.code(409).send({ error: 'closed', message: 'Sign-ups for this workshop are closed.' });

    // The honeypot: answer like a success, store nothing.
    if (input.data.website) return { status: 'booked', seats: input.data.seats };

    const { website: _w, ...fields } = input.data;
    // One sign-up per address per workshop - a second one would double-book a seat.
    if (signupsOf(db, accountId, w.id).some((s) => s.email === fields.email && s.status !== 'cancelled')) {
      return reply.code(409).send({ error: 'duplicate', message: "You're already signed up with this email address - check your inbox for the details." });
    }
    const token = newToken();
    const signup = db.transaction(() => {
      const place = placeSignup(w, signupsOf(db, accountId, w.id), fields.seats);
      if (place === 'full') return null;
      const s: Signup = { id: randomUUID(), workshopId: w.id, ...fields, status: place, paid: false, source: 'public', createdAt: Date.now(), cancelledAt: null };
      saveSignup(db, accountId, s, sha256(token));
      return s;
    })();
    if (!signup) return reply.code(409).send({ error: 'full', message: 'Sorry - there are not enough places left.' });

    const link = cancelUrl(originOf(req), token);
    const emailed = await tellParticipant(ctx.mail, db, accountId, w, signup, signup.status === 'booked' ? 'booked' : 'waitlist', link);
    const taken = seatsTaken(signupsOf(db, accountId, w.id));
    ctx.notify(accountId, {
      title: `${signup.name} ${signup.status === 'booked' ? 'signed up for' : 'joined the waitlist for'} ${w.title}`,
      body: `${signup.seats} place${signup.seats === 1 ? '' : 's'} · ${taken} of ${w.capacity} booked`,
      link: '/m/consignment?tab=programme',
      minRole: 'admin',
    });
    // The cancel link goes back to the page too: without email it is the only copy.
    return { status: signup.status, seats: signup.seats, emailed, cancelPath: `/p/consignment/cancel#${token}` };
  });

  // ── Cancelling a place ──────────────────────────────────────────────────

  app.get('/cancel', async (_req, reply) => reply.type('text/html; charset=utf-8').send(CANCEL_PAGE));
  app.get('/cancel.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').send(CANCEL_SCRIPT));

  const CancelBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{22}$/), confirm: z.boolean().default(false) });
  app.post('/cancel', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } }, bodyLimit: 1024 }, async (req, reply) => {
    const body = CancelBody.safeParse(req.body);
    if (!body.success) return reply.code(404).send({ error: 'not_found' });
    const row = db.prepare('SELECT accountId, doc FROM consignment_signups WHERE tokenHash = ?').get(sha256(body.data.token)) as
      | { accountId: string; doc: string }
      | undefined;
    if (!row || !ctx.isEnabled(row.accountId)) return reply.code(404).send({ error: 'not_found' });
    const s = JSON.parse(row.doc) as Signup;
    const w = get<Workshop>(db, row.accountId, 'workshops', s.workshopId);
    if (!w) return reply.code(404).send({ error: 'not_found' });
    const info = { title: w.title, date: w.date, time: w.time, seats: s.seats, status: s.status, workshopCancelled: !!w.cancelledAt };
    if (!body.data.confirm || s.status === 'cancelled' || w.cancelledAt) return info;

    const was = s.status;
    const next: Signup = { ...s, status: 'cancelled', cancelledAt: Date.now() };
    saveSignup(db, row.accountId, next);
    await tellParticipant(ctx.mail, db, row.accountId, w, { ...s }, 'left', null);
    const promoted = was === 'booked' ? await promote(ctx.mail, db, row.accountId, w) : 0;
    ctx.notify(row.accountId, {
      title: `${s.name} cancelled ${s.seats === 1 ? 'their place' : `${s.seats} places`} for ${w.title}`,
      body: promoted ? `${promoted} from the waitlist moved up.` : '',
      link: '/m/consignment?tab=programme',
      minRole: 'admin',
    });
    return { ...info, status: 'cancelled' };
  });
}

// ── Pages ───────────────────────────────────────────────────────────────────
// Static: they hold no data. Their scripts fetch it, and build every node
// with textContent - never markup from what a store or visitor typed.

const STYLE = `
:root { --ink: #1a2230; --muted: #5a6472; --line: #d6dde4; --card: #fff; --bg: #f1f4f6; --accent: #0e7c66; --accent-soft: #deeee9; --warn: #8a5a1e; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --ink: #e6ebf0; --muted: #9aa5b1; --line: #2c3642; --card: #1a2129; --bg: #10151b; --accent: #3fb59b; --accent-soft: #173a33; --warn: #e0b36a; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--ink); }
main { max-width: 44rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; display: flex; flex-direction: column; gap: 1rem; }
h1 { margin: 0; font-size: 1.6rem; } h2 { margin: .5rem 0 0; font-size: 1.05rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: .45rem; }
.card h3 { margin: 0; font-size: 1.15rem; }
.muted { color: var(--muted); font-size: .92rem; margin: 0; }
.desc { margin: 0; white-space: pre-line; }
.tag { align-self: flex-start; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; border-radius: 999px; padding: .15rem .55rem; background: var(--accent-soft); color: var(--accent); }
.tag.warn { color: var(--warn); background: transparent; border: 1px solid currentColor; }
form { display: flex; flex-direction: column; gap: .55rem; border-top: 1px solid var(--line); padding-top: .7rem; margin-top: .2rem; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .9rem; }
input, textarea, select { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: .5rem .6rem; }
.hp { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
button { font: inherit; border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 8px; padding: .6rem 1rem; cursor: pointer; font-weight: 600; }
button.ghost { background: transparent; color: var(--accent); }
button:disabled { opacity: .6; cursor: default; }
.msg { margin: 0; padding: .6rem .75rem; border-radius: 8px; background: var(--accent-soft); }
.msg.err { background: transparent; border: 1px solid #c6512f; color: #c6512f; }
.status { text-align: center; padding: 2rem 1rem; }
a { color: var(--accent); }
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Events and workshops</title>
<style>${STYLE}</style>
</head>
<body>
<main id="app"><div class="card status" role="status"><p>Loading…</p></div></main>
<noscript><p class="status">Please enable JavaScript to sign up.</p></noscript>
<script src="/p/consignment/programme.js"></script>
</body>
</html>
`;

const SCRIPT = String.raw`(function () {
  'use strict';
${POW_SOLVER_JS}
  var app = document.getElementById('app');
  var token = location.pathname.split('/').pop();
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function money(n, cur) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n); } catch (e) { return cur + ' ' + n.toFixed(2); } }
  function day(d, opts) { return new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, Object.assign({ timeZone: 'UTC' }, opts || { weekday: 'long', day: 'numeric', month: 'long' })); }
  function status(text) { app.textContent = ''; var c = el('div', 'card status'); c.appendChild(el('p', '', text)); app.appendChild(c); }

  function field(label, input) { var l = el('label'); l.appendChild(el('span', '', label)); l.appendChild(input); return l; }
  function input(type, name, required) { var i = el('input'); i.type = type; i.name = name; if (required) i.required = true; return i; }

  function signupForm(w) {
    var f = el('form');
    var name = input('text', 'name', true); name.autocomplete = 'name'; name.maxLength = 100;
    var email = input('email', 'email', true); email.autocomplete = 'email'; email.maxLength = 254;
    var seats = el('select'); for (var i = 1; i <= 10; i++) { var o = el('option', '', String(i)); o.value = String(i); seats.appendChild(o); }
    var note = el('textarea'); note.rows = 2; note.maxLength = 500;
    var hp = input('text', 'website'); hp.tabIndex = -1; hp.autocomplete = 'off';
    var hpWrap = el('div', 'hp'); hpWrap.setAttribute('aria-hidden', 'true'); hpWrap.appendChild(field('Website', hp));
    f.appendChild(field('Your name', name));
    f.appendChild(field('Email', email));
    f.appendChild(field('Places', seats));
    f.appendChild(field('Anything we should know? (optional)', note));
    f.appendChild(hpWrap);
    var btn = el('button', '', w.availability === 'waitlist' ? 'Join the waitlist' : 'Sign up'); btn.type = 'submit';
    var msg = el('p', 'msg'); msg.hidden = true;
    f.appendChild(btn); f.appendChild(msg);
    f.onsubmit = function (e) {
      e.preventDefault();
      btn.disabled = true; msg.hidden = false; msg.className = 'msg'; msg.textContent = 'Signing you up…';
      fetch('/p/consignment/challenge', { cache: 'no-store', credentials: 'omit' })
        .then(function (r) { if (!r.ok) throw r; return r.json(); })
        .then(function (ch) { return new Promise(function (ok) { setTimeout(function () { ok({ ch: ch, solution: solve(ch.nonce, ch.difficulty) }); }, 30); }); })
        .then(function (s) {
          return fetch('/p/consignment/s/' + encodeURIComponent(token) + '/workshops/' + encodeURIComponent(w.id) + '/signup', {
            method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name.value, email: email.value, seats: Number(seats.value), note: note.value, website: hp.value, captchaToken: s.ch.token, captchaSolution: s.solution }),
          });
        })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
        .then(function (res) {
          if (!res.ok) { btn.disabled = false; msg.className = 'msg err'; msg.textContent = res.status === 429 ? 'Too many attempts - please try again later.' : (res.body && res.body.message) || 'Something went wrong. Please try again.'; return; }
          f.textContent = '';
          var done = el('p', 'msg', res.body.status === 'booked'
            ? "You're booked for " + res.body.seats + (res.body.seats === 1 ? ' place.' : ' places.') + (res.body.emailed ? ' We sent the details to your email.' : '')
            : "You're on the waitlist. If a place frees up you'll be booked" + (res.body.emailed ? ' and we will email you.' : '.'));
          f.appendChild(done);
          var p = el('p', 'muted', "Can't make it? ");
          var a = el('a', '', 'Cancel your place'); a.href = res.body.cancelPath;
          p.appendChild(a); p.appendChild(document.createTextNode(res.body.emailed ? '' : ' - keep this link, it is the only copy.'));
          f.appendChild(p);
        })
        .catch(function () { btn.disabled = false; msg.className = 'msg err'; msg.textContent = 'Could not reach the server. Check your connection and try again.'; });
    };
    return f;
  }

  function render(d) {
    app.textContent = '';
    document.title = d.name ? d.name + ' - events and workshops' : 'Events and workshops';
    app.appendChild(el('h1', '', d.name || 'Events and workshops'));
    if (d.features.length) {
      app.appendChild(el('h2', '', 'Featured'));
      d.features.forEach(function (f) {
        var c = el('article', 'card');
        c.appendChild(el('span', 'tag', f.title));
        c.appendChild(el('h3', '', f.artist));
        c.appendChild(el('p', 'muted', day(f.startDate, { day: 'numeric', month: 'long' }) + ' - ' + day(f.endDate, { day: 'numeric', month: 'long', year: 'numeric' }) + (f.stores.length ? ' · ' + f.stores.join(', ') : '')));
        if (f.discountPct) c.appendChild(el('p', '', f.discountPct + '% off their work while featured'));
        if (f.description) c.appendChild(el('p', 'desc', f.description));
        app.appendChild(c);
      });
    }
    app.appendChild(el('h2', '', 'Workshops'));
    if (!d.workshops.length) app.appendChild(el('p', 'muted', 'No workshops planned right now - check back soon.'));
    d.workshops.forEach(function (w) {
      var c = el('article', 'card');
      c.appendChild(el('h3', '', w.title));
      c.appendChild(el('p', 'muted', day(w.date) + ' · ' + w.time + ' · ' + w.durationMin + ' min'));
      c.appendChild(el('p', 'muted', w.store + (w.address ? ' · ' + w.address : '')));
      if (w.host) c.appendChild(el('p', 'muted', 'With ' + w.host));
      c.appendChild(el('p', '', w.price > 0 ? money(w.price, w.currency) + ' per place, paid at the store' : 'Free'));
      if (w.description) c.appendChild(el('p', 'desc', w.description));
      if (w.availability === 'open') { c.appendChild(el('span', 'tag', w.seatsLeft + (w.seatsLeft === 1 ? ' place left' : ' places left'))); c.appendChild(signupForm(w)); }
      else if (w.availability === 'waitlist') { c.appendChild(el('span', 'tag warn', 'Full - waitlist open')); c.appendChild(signupForm(w)); }
      else c.appendChild(el('span', 'tag warn', w.availability === 'full' ? 'Full' : 'Sign-ups closed'));
      app.appendChild(c);
    });
  }

  fetch('/p/consignment/s/' + encodeURIComponent(token) + '/data', { cache: 'no-store', credentials: 'omit' })
    .then(function (r) { if (r.status === 404) { status('This page is no longer available.'); throw null; } if (!r.ok) throw r; return r.json(); })
    .then(render)
    .catch(function (e) { if (e !== null) status('Could not load the programme. Please try again in a moment.'); });
})();
`;

const CANCEL_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Cancel your place</title>
<style>${STYLE}</style>
</head>
<body>
<main id="app"><div class="card status" role="status"><p>Loading…</p></div></main>
<script src="/p/consignment/cancel.js"></script>
</body>
</html>
`;

const CANCEL_SCRIPT = String.raw`(function () {
  'use strict';
  var app = document.getElementById('app');
  var token = (location.hash || '').slice(1);
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function card(lines) { app.textContent = ''; var c = el('div', 'card'); lines.forEach(function (n) { c.appendChild(n); }); app.appendChild(c); return c; }
  function post(confirm) {
    return fetch('/p/consignment/cancel', { method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: token, confirm: confirm }) })
      .then(function (r) { if (r.status === 404) throw 404; if (r.status === 429) throw 429; if (!r.ok) throw r; return r.json(); });
  }
  function when(i) { return new Date(i.date + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) + ' · ' + i.time; }
  function fail(e) { card([el('p', '', e === 404 ? 'This link is not valid any more.' : e === 429 ? 'Too many attempts - please try again later.' : 'Something went wrong. Please try again.')]); }
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) { card([el('p', '', 'This link is incomplete. Please use the link from your email.')]); return; }
  post(false).then(function (i) {
    if (i.workshopCancelled) return card([el('h1', '', i.title), el('p', '', 'This workshop was called off by the store - there is nothing to cancel.')]);
    if (i.status === 'cancelled') return card([el('h1', '', i.title), el('p', '', 'Your place is already cancelled.')]);
    var btn = el('button', '', i.status === 'waitlist' ? 'Leave the waitlist' : 'Cancel my place');
    var c = card([el('h1', '', i.title), el('p', 'muted', when(i)), el('p', '', i.status === 'waitlist' ? "You're on the waitlist for " + i.seats + (i.seats === 1 ? ' place.' : ' places.') : "You're booked for " + i.seats + (i.seats === 1 ? ' place.' : ' places.')), btn]);
    btn.onclick = function () {
      btn.disabled = true;
      post(true).then(function () { c.textContent = ''; c.appendChild(el('h1', '', i.title)); c.appendChild(el('p', 'msg', 'Done - your place is cancelled. Thanks for letting us know.')); }).catch(fail);
    };
  }).catch(fail);
})();
`;
