import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  COUNTRIES,
  NOTIFY_KIND_LABEL,
  NOTIFY_PUBLIC_PATH,
  NOTIFY_TOKEN_RE,
  NewsInputSchema,
  NotifySettingsSchema,
  SubscribeInputSchema,
  dayInZone,
  eraseReason,
  eventRecipients,
  fmtDayRange,
  isLive,
  newsRecipients,
  restockRecipients,
  type InventoryItem,
  type NotifyKind,
  type NotifySettings,
  type SalesEvent,
  type Subscriber,
  type WireOp,
} from '@zollify/shared';
import { isEnabled, issueChallenge, reduceEvents, reduceProducts, verifyChallenge, type ModuleContext, type ModuleServices, type PublicModuleContext, type ServerModule } from '@zollify/server-core';
import { POW_SOLVER_JS } from './pow-client';

/**
 * Notify me - the server half.
 *
 * A customer scans a code at the booth and asks to hear from the business:
 * when an item is back in stock, when it is next at an event near them,
 * when the webstore has news. Addresses are personal data of people who
 * are not customers of record, so: every address is confirmed by mail
 * before anything is sent (double opt-in), every mail carries its own
 * leave link, signing up costs a proof-of-work and is rate limited like the
 * workshop sign-up, and a sweep erases the unconfirmed, the gone and the
 * silent (see `eraseReason`). The page is `/p/notify-me/<slug>`, static
 * HTML whose script fetches what it shows and builds every node with
 * textContent.
 *
 * Restocks follow the till's own counts: an item counted back above zero
 * after it stood at zero is announced to those who asked, once per cooldown.
 * Events are announced when one appears with dates ahead, once each.
 */

const MODULE_ID = 'notify-me';
const SWEEP_MS = 6 * 3600_000;
const DIFFICULTY = Math.min(22, Math.max(10, Number(process.env.SIGNUP_CAPTCHA_BITS || 15)));
const MAX_SUBSCRIBERS = 5000;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const bad = (message: string) => ({ error: 'invalid_request', message });
const newToken = (): string => randomBytes(24).toString('base64url');

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notify_settings (
      accountId TEXT PRIMARY KEY,
      slug      TEXT UNIQUE,
      doc       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notify_subscribers (
      accountId TEXT NOT NULL,
      id        TEXT NOT NULL,
      email     TEXT NOT NULL,
      doc       TEXT NOT NULL,
      tokenHash TEXT UNIQUE,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_notify_subscribers_email ON notify_subscribers(accountId, email);
    CREATE TABLE IF NOT EXISTS notify_sent (
      accountId    TEXT NOT NULL,
      subscriberId TEXT NOT NULL,
      key          TEXT NOT NULL,
      at           INTEGER NOT NULL,
      PRIMARY KEY (accountId, subscriberId, key)
    );
    CREATE TABLE IF NOT EXISTS notify_stock (
      accountId TEXT NOT NULL,
      key       TEXT NOT NULL,
      onHand    INTEGER NOT NULL,
      PRIMARY KEY (accountId, key)
    );
    CREATE TABLE IF NOT EXISTS notify_news (
      accountId TEXT NOT NULL,
      id        TEXT NOT NULL,
      doc       TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
  `);
}

// ── Storage ─────────────────────────────────────────────────────────────────

function readSettings(db: Database.Database, accountId: string): NotifySettings {
  const row = db.prepare('SELECT doc FROM notify_settings WHERE accountId = ?').get(accountId) as { doc: string } | undefined;
  const parsed = NotifySettingsSchema.safeParse(row ? JSON.parse(row.doc) : {});
  return parsed.success ? parsed.data : NotifySettingsSchema.parse({});
}

const accountForSlug = (db: Database.Database, slug: string): string | null =>
  (db.prepare('SELECT accountId FROM notify_settings WHERE slug = ?').get(slug) as { accountId: string } | undefined)?.accountId ?? null;

const accountName = (db: Database.Database, accountId: string): string => (db.prepare('SELECT name FROM accounts WHERE id = ?').get(accountId) as { name: string } | undefined)?.name ?? '';

const accountEmail = (db: Database.Database, accountId: string): string | null =>
  (db.prepare("SELECT email FROM users WHERE accountId = ? AND role IN ('owner','admin') ORDER BY role = 'owner' DESC, createdAt LIMIT 1").get(accountId) as { email: string } | undefined)?.email ?? null;

const parseSub = (doc: string): Subscriber => JSON.parse(doc) as Subscriber;

function subscribersOf(db: Database.Database, accountId: string): Subscriber[] {
  return (db.prepare('SELECT doc FROM notify_subscribers WHERE accountId = ? ORDER BY createdAt DESC').all(accountId) as { doc: string }[]).map((r) => parseSub(r.doc));
}

function subscriberByEmail(db: Database.Database, accountId: string, email: string): Subscriber | undefined {
  const row = db.prepare('SELECT doc FROM notify_subscribers WHERE accountId = ? AND email = ?').get(accountId, email) as { doc: string } | undefined;
  return row ? parseSub(row.doc) : undefined;
}

function subscriberByToken(db: Database.Database, token: string): { accountId: string; s: Subscriber } | null {
  const row = db.prepare('SELECT accountId, doc FROM notify_subscribers WHERE tokenHash = ?').get(sha256(token)) as { accountId: string; doc: string } | undefined;
  return row ? { accountId: row.accountId, s: parseSub(row.doc) } : null;
}

function saveSubscriber(db: Database.Database, accountId: string, s: Subscriber, tokenHash?: string): void {
  db.prepare(
    `INSERT INTO notify_subscribers (accountId, id, email, doc, tokenHash, createdAt) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(accountId, id) DO UPDATE SET email = excluded.email, doc = excluded.doc, tokenHash = COALESCE(excluded.tokenHash, notify_subscribers.tokenHash)`,
  ).run(accountId, s.id, s.email, JSON.stringify(s), tokenHash ?? null, s.createdAt);
}

const removeSubscriber = (db: Database.Database, accountId: string, id: string): number => {
  db.prepare('DELETE FROM notify_sent WHERE accountId = ? AND subscriberId = ?').run(accountId, id);
  return db.prepare('DELETE FROM notify_subscribers WHERE accountId = ? AND id = ?').run(accountId, id).changes;
};

const toldAt = (db: Database.Database, accountId: string, subscriberId: string, key: string): number | null =>
  (db.prepare('SELECT at FROM notify_sent WHERE accountId = ? AND subscriberId = ? AND key = ?').get(accountId, subscriberId, key) as { at: number } | undefined)?.at ?? null;

const markSent = (db: Database.Database, accountId: string, subscriberId: string, key: string, at: number): void => {
  db.prepare('INSERT INTO notify_sent (accountId, subscriberId, key, at) VALUES (?, ?, ?, ?) ON CONFLICT(accountId, subscriberId, key) DO UPDATE SET at = excluded.at').run(accountId, subscriberId, key, at);
};

/** The origin people reach this server at, for links in mails and codes. */
function originOf(req: FastifyRequest): string {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  return `${req.protocol}://${req.host}`;
}

/** The origin for mails sent from a background trigger, where there is no request: what was last seen. */
let lastOrigin = process.env.PUBLIC_ORIGIN?.replace(/\/+$/, '') ?? '';

type Ops = { opId: string; type: string; payload: string }[];
const opsFor = (db: Database.Database, accountId: string, types: string[]): { opId: string; type: string; payload: unknown }[] =>
  (db.prepare(`SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY seq`).all(accountId, ...types) as Ops).map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) }));

const productsOf = (db: Database.Database, accountId: string) => reduceProducts(opsFor(db, accountId, ['product.upsert', 'product.delete', 'product.merge']));

/** The last count the till recorded for an item, replayed from the op-log. */
function lastCount(db: Database.Database, accountId: string, productId: string): number | null {
  const rows = db.prepare("SELECT payload FROM ops WHERE accountId = ? AND type = 'inventory.set' AND payload LIKE ? ORDER BY seq").all(accountId, `%${productId}%`) as { payload: string }[];
  let best: InventoryItem | null = null;
  let sum = 0;
  const byVariant = new Map<string, InventoryItem>();
  for (const r of rows) {
    const item = JSON.parse(r.payload) as InventoryItem;
    if (item.productId !== productId) continue;
    const prev = byVariant.get(item.variantId);
    if (!prev || item.updatedAt >= prev.updatedAt) byVariant.set(item.variantId, item);
    best = item;
  }
  if (!best) return null;
  for (const v of byVariant.values()) sum += v.onHand;
  return sum;
}

// ── Mail ────────────────────────────────────────────────────────────────────

const link = (origin: string, action: 'confirm' | 'leave', token: string): string => `${origin}${NOTIFY_PUBLIC_PATH}${action}#${token}`;

async function sendTo(svc: Pick<ModuleServices, 'mail' | 'db'>, accountId: string, s: Subscriber, token: string | null, subject: string, lines: string[], origin: string): Promise<boolean> {
  if (!svc.mail.enabled) return false;
  const shop = accountName(svc.db, accountId) || 'The shop';
  const foot = token ? ['', `You asked ${shop} to tell you this. To stop: ${link(origin, 'leave', token)}`] : [];
  const replyTo = accountEmail(svc.db, accountId) ?? undefined;
  const ok = await svc.mail.send({ to: s.email, accountId, subject, text: [...lines, '', `- ${shop}`, ...foot].join('\n'), ...(replyTo ? { replyTo } : {}) });
  if (ok) saveSubscriber(svc.db, accountId, { ...s, lastSentAt: Date.now() });
  return ok;
}

/**
 * Subscribers keep their token only as a hash, so a mail can only carry a
 * link while the token is at hand: at sign-up (the confirm mail) and, for
 * later mails, a fresh token minted for the purpose. Rotating it means an
 * old mail's leave link stops working once a newer mail went out - the
 * newest mail always has a working one.
 */
function freshToken(db: Database.Database, accountId: string, s: Subscriber): string {
  const token = newToken();
  db.prepare('UPDATE notify_subscribers SET tokenHash = ? WHERE accountId = ? AND id = ?').run(sha256(token), accountId, s.id);
  return token;
}

async function tellMany(svc: ModuleServices, accountId: string, recipients: Subscriber[], key: string, subject: string, lines: string[], origin: string): Promise<number> {
  let sent = 0;
  for (const s of recipients) {
    const token = freshToken(svc.db, accountId, s);
    if (await sendTo(svc, accountId, s, token, subject, lines, origin)) {
      markSent(svc.db, accountId, s.id, key, Date.now());
      sent++;
    }
  }
  return sent;
}

// ── Triggers ────────────────────────────────────────────────────────────────

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

function followOps(svc: ModuleServices, accountId: string, ops: WireOp[]): void {
  const { db } = svc;
  const settings = readSettings(db, accountId);
  const subs = subscribersOf(db, accountId);
  if (!subs.some(isLive) || !svc.mail.enabled) {
    // Keep the counts current anyway, so the first subscriber starts from the truth.
    for (const op of ops) if (op.type === 'inventory.set') rememberCount(db, accountId, op.payload as InventoryItem);
    return;
  }
  const origin = lastOrigin;
  const products = () => new Map(productsOf(db, accountId).map((p) => [p.id, p]));
  let catalogue: ReturnType<typeof products> | null = null;

  for (const op of ops) {
    if (op.type === 'inventory.set') {
      const item = op.payload as InventoryItem;
      const before = storedCount(db, accountId, item.productId);
      rememberCount(db, accountId, item);
      const after = storedCount(db, accountId, item.productId);
      if (before == null || before > 0 || !(after != null && after > 0)) continue;
      const recipients = restockRecipients(subs, item.productId, (id) => toldAt(db, accountId, id, `restock:${item.productId}`), settings.restockCooldownDays);
      if (!recipients.length) continue;
      catalogue ??= products();
      const product = catalogue.get(item.productId);
      if (!product || product.deletedAt) continue;
      const lines = [`${product.title} is back in stock.`, ...(settings.storeUrl ? ['', `Find it here: ${settings.storeUrl}`] : [])];
      void tellMany(svc, accountId, recipients, `restock:${item.productId}`, `${product.title} is back in stock`, lines, origin);
    } else if (op.type === 'event.upsert') {
      const e = op.payload as SalesEvent;
      if (e.kind === 'store' || e.deletedAt || !e.dateStart || e.dateStart < todayUtc()) continue;
      if (toldAt(db, accountId, '*', `event:${e.id}`)) continue;
      const country = e.venue?.country ?? '';
      const recipients = eventRecipients(subs, country);
      markSent(db, accountId, '*', `event:${e.id}`, Date.now());
      if (!recipients.length) continue;
      const where = [e.venue?.city, e.venue?.country].filter(Boolean).join(', ');
      const when = fmtDayRange(e.dateStart, e.dateEnd ?? e.dateStart);
      const lines = [`We'll be at ${e.name}${when ? ` on ${when}` : ''}${where ? `, ${where}` : ''}.`, ...(e.booth?.hall || e.booth?.number ? [`Find us: ${[e.booth?.hall, e.booth?.number].filter(Boolean).join(', ')}`] : []), ...(settings.storeUrl ? ['', settings.storeUrl] : [])];
      void tellMany(svc, accountId, recipients, `event:${e.id}`, `Next event: ${e.name}`, lines, origin);
    }
  }
}

function storedCount(db: Database.Database, accountId: string, productId: string): number | null {
  const rows = db.prepare('SELECT onHand FROM notify_stock WHERE accountId = ? AND (key = ? OR key LIKE ?)').all(accountId, productId, `${productId}:%`) as { onHand: number }[];
  if (!rows.length) return null;
  return rows.reduce((s, r) => s + r.onHand, 0);
}

function rememberCount(db: Database.Database, accountId: string, item: InventoryItem): void {
  const key = item.variantId ? `${item.productId}:${item.variantId}` : item.productId;
  db.prepare('INSERT INTO notify_stock (accountId, key, onHand) VALUES (?, ?, ?) ON CONFLICT(accountId, key) DO UPDATE SET onHand = excluded.onHand').run(accountId, key, Math.max(0, Math.floor(item.onHand)));
}

/** A subscriber asked about an item: start from its count today, so a later count above zero reads as a restock. */
function baseline(db: Database.Database, accountId: string, productId: string): void {
  if (storedCount(db, accountId, productId) != null) return;
  const count = lastCount(db, accountId, productId);
  db.prepare('INSERT OR IGNORE INTO notify_stock (accountId, key, onHand) VALUES (?, ?, ?)').run(accountId, productId, count ?? 0);
}

export function sweep(db: Database.Database, now = Date.now()): number {
  const accounts = db.prepare('SELECT DISTINCT accountId FROM notify_subscribers').all() as { accountId: string }[];
  let erased = 0;
  for (const { accountId } of accounts) {
    if (!isEnabled(db, accountId, MODULE_ID)) continue;
    const months = readSettings(db, accountId).eraseAfterMonths;
    for (const s of subscribersOf(db, accountId)) {
      if (!eraseReason(s, months, now)) continue;
      removeSubscriber(db, accountId, s.id);
      erased++;
    }
  }
  return erased;
}

// ── Routes ──────────────────────────────────────────────────────────────────

const IdParam = z.string().min(1).max(80);
const TokenBody = z.object({ token: z.string().regex(NOTIFY_TOKEN_RE) });

export const notifyMeServerModule: ServerModule = {
  id: MODULE_ID,
  // Subscribers are personal data the business is answerable for: admins only.
  minRole: 'admin',
  migrate,
  onAccountDeleted: (db, accountId) => {
    for (const t of ['notify_settings', 'notify_subscribers', 'notify_sent', 'notify_stock', 'notify_news']) db.prepare(`DELETE FROM ${t} WHERE accountId = ?`).run(accountId);
  },
  onOps: (svc, accountId, ops) => {
    try {
      followOps(svc, accountId, ops);
    } catch {
      /* must not throw into the sync */
    }
  },
  webhookReport: (svc, accountId, period) => {
    const n = subscribersOf(svc.db, accountId).filter((s) => s.confirmedAt != null && dayInZone(s.confirmedAt, period.timeZone) >= period.from && dayInZone(s.confirmedAt, period.timeZone) <= period.to).length;
    return n ? [{ name: 'Notify me', value: `${n} new subscriber${n === 1 ? '' : 's'}`, inline: true }] : [];
  },

  routes: (ctx: ModuleContext) => async (app) => {
    const { db } = ctx;

    const sweeper = () => {
      try {
        sweep(db);
      } catch {
        /* next time */
      }
    };
    app.addHook('onReady', async () => sweeper());
    const timer = setInterval(sweeper, SWEEP_MS);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
    app.addHook('onRequest', async (req) => {
      lastOrigin = originOf(req);
    });

    const overview = (req: FastifyRequest, accountId: string) => {
      const settings = readSettings(db, accountId);
      const subs = subscribersOf(db, accountId);
      const live = subs.filter(isLive);
      return {
        settings,
        mailEnabled: ctx.mail.enabled,
        publicUrl: settings.slug ? `${originOf(req)}${NOTIFY_PUBLIC_PATH}${settings.slug}` : null,
        counts: { live: live.length, unconfirmed: subs.filter((s) => s.confirmedAt == null).length, byKind: Object.fromEntries((['restock', 'events', 'news'] as NotifyKind[]).map((k) => [k, live.filter((s) => s.kinds.includes(k)).length])) },
      };
    };

    app.get('/settings', async (req) => overview(req, ctx.identity(req).accountId));

    app.put('/settings', async (req, reply) => {
      const who = ctx.identity(req);
      const body = NotifySettingsSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'Those settings are not valid.'));
      if (body.data.slug) {
        const owner = accountForSlug(db, body.data.slug);
        if (owner && owner !== who.accountId) return reply.code(409).send({ error: 'slug_taken', message: 'That address is already taken - try another.' });
      }
      db.prepare('INSERT INTO notify_settings (accountId, slug, doc) VALUES (?, ?, ?) ON CONFLICT(accountId) DO UPDATE SET slug = excluded.slug, doc = excluded.doc').run(who.accountId, body.data.slug || null, JSON.stringify(body.data));
      return overview(req, who.accountId);
    });

    app.get<{ Querystring: { q?: string } }>('/subscribers', async (req) => {
      const who = ctx.identity(req);
      const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 80) : '';
      const subs = subscribersOf(db, who.accountId).filter((s) => !q || s.email.includes(q));
      const products = subs.some((s) => s.productIds.length) ? new Map(productsOf(db, who.accountId).map((p) => [p.id, p.title])) : new Map<string, string>();
      return { subscribers: subs.map((s) => ({ ...s, products: s.productIds.map((id) => products.get(id) ?? id) })) };
    });

    app.delete<{ Params: { id: string } }>('/subscribers/:id', async (req, reply) => {
      const who = ctx.identity(req);
      return removeSubscriber(db, who.accountId, IdParam.parse(req.params.id)) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
    });

    app.get('/news', async (req) => {
      const who = ctx.identity(req);
      return { news: (db.prepare('SELECT doc FROM notify_news WHERE accountId = ? ORDER BY createdAt DESC LIMIT 100').all(who.accountId) as { doc: string }[]).map((r) => JSON.parse(r.doc)) };
    });

    /** A note to everyone who asked for webstore news. Goes out now, one mail each. */
    app.post('/news', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
      const who = ctx.identity(req);
      const body = NewsInputSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'Check the message.'));
      if (!ctx.mail.enabled) return reply.code(409).send(bad('This server cannot send email.'));
      const settings = readSettings(db, who.accountId);
      const recipients = newsRecipients(subscribersOf(db, who.accountId));
      const id = randomUUID();
      const sent = await tellMany(ctx, who.accountId, recipients, `news:${id}`, body.data.subject, [body.data.text, ...(settings.storeUrl ? ['', settings.storeUrl] : [])], originOf(req));
      const item = { id, ...body.data, recipients: recipients.length, sent, createdAt: Date.now(), by: who.userId };
      db.prepare('INSERT INTO notify_news (accountId, id, doc, createdAt) VALUES (?, ?, ?, ?)').run(who.accountId, id, JSON.stringify(item), item.createdAt);
      return reply.code(201).send({ news: item });
    });
  },

  /** The public page and its sign-up, confirm and leave endpoints: `/p/notify-me/…`. */
  publicRoutes: (ctx: PublicModuleContext) => async (app) => {
    const { db } = ctx;
    const live = (slug: string): string | null => {
      if (!/^[a-z0-9-]{3,40}$/.test(slug)) return null;
      const accountId = accountForSlug(db, slug);
      return accountId && ctx.isEnabled(accountId) ? accountId : null;
    };

    // Addresses travel here: nothing cached, nothing indexed but the sign-up page.
    app.addHook('onSend', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      reply.header('referrer-policy', 'no-referrer');
      if (/^\/p\/notify-me\/(confirm|leave)/.test(req.url)) reply.header('x-robots-tag', 'noindex, nofollow');
    });
    app.addHook('onRequest', async (req) => {
      lastOrigin = originOf(req);
    });

    app.get('/notify.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').send(SCRIPT));
    app.get('/action.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').send(ACTION_SCRIPT));
    app.get('/challenge', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => issueChallenge('signup', DIFFICULTY));
    app.get('/confirm', async (_req, reply) => reply.type('text/html; charset=utf-8').send(ACTION_PAGE));
    app.get('/leave', async (_req, reply) => reply.type('text/html; charset=utf-8').send(ACTION_PAGE));

    type Slug = { Params: { slug: string } };
    const page = async (req: FastifyRequest<Slug>, reply: FastifyReply) => {
      if (!live(req.params.slug)) return reply.code(404).type('text/plain').send('No such page.');
      return reply.type('text/html; charset=utf-8').send(PAGE);
    };
    app.get<Slug>('/:slug', page);
    app.get<{ Params: { slug: string; productId: string } }>('/:slug/i/:productId', page);

    /** What the page shows: the business, what it offers, the item scanned. */
    app.get<Slug & { Querystring: { product?: string } }>('/:slug/data', async (req, reply) => {
      const accountId = live(req.params.slug);
      if (!accountId) return reply.code(404).send({ error: 'not_found' });
      const settings = readSettings(db, accountId);
      const pid = typeof req.query.product === 'string' ? req.query.product.slice(0, 80) : '';
      const product = pid ? productsOf(db, accountId).find((p) => p.id === pid && !p.deletedAt) : undefined;
      return {
        name: accountName(db, accountId),
        intro: settings.intro,
        kinds: settings.kinds.map((k) => ({ id: k, label: NOTIFY_KIND_LABEL[k] })),
        storeUrl: settings.storeUrl,
        product: product ? { id: product.id, title: product.title } : null,
        countries: COUNTRIES,
        mailEnabled: ctx.mail.enabled,
      };
    });

    app.post<Slug & { Body: Record<string, unknown> }>('/:slug/subscribe', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, bodyLimit: 4096 }, async (req, reply) => {
      const accountId = live(req.params.slug);
      if (!accountId) return reply.code(404).send({ error: 'not_found' });
      const body = req.body ?? {};
      if (!verifyChallenge(String(body.captchaToken ?? ''), String(body.captchaSolution ?? ''), 'signup').ok) {
        return reply.code(403).send({ error: 'challenge_failed', message: 'Please try again.' });
      }
      const input = SubscribeInputSchema.safeParse(body);
      if (!input.success) return reply.code(400).send(bad(input.error.issues[0]?.message ?? 'Enter a valid email address and tick what you want to hear about.'));
      if (!ctx.mail.enabled) return reply.code(503).send(bad('This page cannot send email right now - please try again later.'));
      // The honeypot: answer like a success, store nothing.
      if (input.data.website) return { status: 'sent' };
      const settings = readSettings(db, accountId);
      const kinds = input.data.kinds.filter((k) => settings.kinds.includes(k));
      if (!kinds.length) return reply.code(400).send(bad('Tick at least one.'));
      const productIds = kinds.includes('restock') && input.data.productId ? [input.data.productId] : [];
      const country = kinds.includes('events') ? input.data.country : '';
      const now = Date.now();
      const origin = originOf(req);

      const existing = subscriberByEmail(db, accountId, input.data.email);
      let s: Subscriber;
      if (existing) {
        // Already with us: widen what they hear about, and confirm again only if they never did.
        s = {
          ...existing,
          kinds: [...new Set([...existing.kinds, ...kinds])],
          productIds: [...new Set([...existing.productIds, ...productIds])],
          country: country || existing.country,
          unsubscribedAt: null,
        };
      } else {
        if (subscribersOf(db, accountId).length >= MAX_SUBSCRIBERS) return reply.code(503).send(bad('This list is full.'));
        s = { id: randomUUID(), email: input.data.email, kinds, productIds, country, source: input.data.productId ? `product:${input.data.productId}` : 'page', createdAt: now, confirmedAt: null, unsubscribedAt: null, lastSentAt: null };
      }
      const token = newToken();
      saveSubscriber(db, accountId, s, sha256(token));
      for (const pid of productIds) baseline(db, accountId, pid);
      const shop = accountName(db, accountId) || 'The shop';
      if (s.confirmedAt == null) {
        const what = s.kinds.map((k) => `- ${NOTIFY_KIND_LABEL[k]}`);
        await sendTo(ctx, accountId, s, null, `Confirm: hear from ${shop}`, [`You asked ${shop} to tell you about:`, ...what, '', `Confirm here: ${link(origin, 'confirm', token)}`, '', `Not you? Ignore this mail and nothing more will come. The address is erased after a week unless confirmed.`], origin);
        return { status: 'sent' };
      }
      await sendTo(ctx, accountId, s, token, `Updated: what you hear from ${shop}`, [`You now hear from ${shop} about:`, ...s.kinds.map((k) => `- ${NOTIFY_KIND_LABEL[k]}`)], origin);
      return { status: 'updated' };
    });

    app.post('/confirm', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } }, bodyLimit: 1024 }, async (req, reply) => {
      const body = TokenBody.safeParse(req.body);
      const found = body.success ? subscriberByToken(db, body.data.token) : null;
      if (!found || !ctx.isEnabled(found.accountId)) return reply.code(404).send({ error: 'not_found' });
      const s = found.s.confirmedAt == null ? { ...found.s, confirmedAt: Date.now() } : found.s;
      saveSubscriber(db, found.accountId, s);
      ctx.notify(found.accountId, { kind: 'other', title: 'Someone signed up to hear from you', body: s.kinds.map((k) => NOTIFY_KIND_LABEL[k]).join(', '), link: '/m/notify-me', minRole: 'admin' });
      return { status: 'confirmed', shop: accountName(db, found.accountId), kinds: s.kinds.map((k) => NOTIFY_KIND_LABEL[k]) };
    });

    app.post('/leave', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } }, bodyLimit: 1024 }, async (req, reply) => {
      const body = TokenBody.safeParse(req.body);
      const found = body.success ? subscriberByToken(db, body.data.token) : null;
      if (!found || !ctx.isEnabled(found.accountId)) return reply.code(404).send({ error: 'not_found' });
      if (found.s.unsubscribedAt == null) saveSubscriber(db, found.accountId, { ...found.s, unsubscribedAt: Date.now() });
      return { status: 'left', shop: accountName(db, found.accountId) };
    });
  },
};

// ── Pages ───────────────────────────────────────────────────────────────────
// Static: they hold no data. Their scripts fetch it and build every node
// with textContent - never markup from what a business or visitor typed.

const STYLE = `
:root { --ink: #1a2230; --muted: #5a6472; --line: #d6dde4; --card: #fff; --bg: #f1f4f6; --accent: #0e7c66; --accent-soft: #deeee9; --bad: #c6512f; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --ink: #e6ebf0; --muted: #9aa5b1; --line: #2c3642; --card: #1a2129; --bg: #10151b; --accent: #3fb59b; --accent-soft: #173a33; --bad: #e57a5a; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--ink); }
main { max-width: 30rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; display: flex; flex-direction: column; gap: 1rem; }
h1 { margin: 0; font-size: 1.5rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: .7rem; }
.muted { color: var(--muted); font-size: .92rem; margin: 0; }
label { display: flex; flex-direction: column; gap: .25rem; font-size: .9rem; }
label.check { flex-direction: row; align-items: center; gap: .5rem; }
input, select { font: inherit; padding: .55rem .7rem; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--ink); }
button { font: inherit; font-weight: 600; padding: .65rem 1rem; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; }
button:disabled { opacity: .6; cursor: default; }
.msg { margin: 0; font-size: .92rem; } .msg.err { color: var(--bad); }
.hp { position: absolute; left: -10000px; top: auto; width: 1px; height: 1px; overflow: hidden; }
a { color: var(--accent); }
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Hear from us</title>
<style>${STYLE}</style>
</head>
<body>
<main id="app"><div class="card" role="status"><p class="muted">Loading…</p></div></main>
<noscript><p class="muted">Please enable JavaScript to sign up.</p></noscript>
<script src="/p/notify-me/notify.js"></script>
</body>
</html>
`;

const SCRIPT = String.raw`(function () {
  'use strict';
${POW_SOLVER_JS}
  var app = document.getElementById('app');
  var parts = location.pathname.split('/').filter(Boolean);
  var slug = parts[2] || '';
  var productId = parts[3] === 'i' ? decodeURIComponent(parts[4] || '') : '';
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function status(text, bad) { app.textContent = ''; var c = el('div', 'card'); var p = el('p', bad ? 'msg err' : 'muted', text); c.appendChild(p); app.appendChild(c); }
  function field(label, input) { var l = el('label'); l.appendChild(el('span', '', label)); l.appendChild(input); return l; }

  function render(d) {
    app.textContent = '';
    document.title = d.name ? 'Hear from ' + d.name : 'Hear from us';
    app.appendChild(el('h1', '', d.name || 'Hear from us'));
    if (d.intro) app.appendChild(el('p', 'muted', d.intro));
    var c = el('div', 'card');
    if (!d.mailEnabled) { c.appendChild(el('p', 'msg err', 'Sign-ups are not available right now - please try again later.')); app.appendChild(c); return; }
    var f = el('form');
    var email = el('input'); email.type = 'email'; email.required = true; email.autocomplete = 'email'; email.maxLength = 254; email.placeholder = 'you@example.com';
    f.appendChild(field('Your email', email));
    var boxes = [];
    var countrySel = null;
    d.kinds.forEach(function (k) {
      var l = el('label', 'check'); var cb = el('input'); cb.type = 'checkbox'; cb.value = k.id;
      var text = k.label;
      if (k.id === 'restock' && d.product) text = 'Tell me when "' + d.product.title + '" is back';
      if (k.id === 'restock' && !d.product) text = 'Tell me when something comes back in stock';
      cb.checked = (k.id === 'restock' && !!d.product) || (k.id === 'events' && !d.product);
      l.appendChild(cb); l.appendChild(el('span', '', text)); f.appendChild(l); boxes.push(cb);
      if (k.id === 'events') {
        countrySel = el('select'); var any = el('option', '', 'Anywhere'); any.value = ''; countrySel.appendChild(any);
        d.countries.forEach(function (co) { var o = el('option', '', co.name); o.value = co.code; countrySel.appendChild(o); });
        f.appendChild(field('Events in', countrySel));
      }
    });
    var hp = el('input'); hp.type = 'text'; hp.name = 'website'; hp.tabIndex = -1; hp.autocomplete = 'off';
    var hpWrap = el('div', 'hp'); hpWrap.setAttribute('aria-hidden', 'true'); hpWrap.appendChild(field('Website', hp)); f.appendChild(hpWrap);
    var btn = el('button', '', 'Keep me posted'); btn.type = 'submit';
    var msg = el('p', 'msg'); msg.hidden = true;
    f.appendChild(btn); f.appendChild(msg);
    f.appendChild(el('p', 'muted', 'We send a mail to confirm your address first. Every mail has a link to stop. Your address is kept only for this and erased when you leave.'));
    f.onsubmit = function (e) {
      e.preventDefault();
      var kinds = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
      if (!kinds.length) { msg.hidden = false; msg.className = 'msg err'; msg.textContent = 'Tick at least one.'; return; }
      btn.disabled = true; msg.hidden = false; msg.className = 'msg'; msg.textContent = 'One moment…';
      fetch('/p/notify-me/challenge', { cache: 'no-store', credentials: 'omit' })
        .then(function (r) { if (!r.ok) throw r; return r.json(); })
        .then(function (ch) { return new Promise(function (ok) { setTimeout(function () { ok({ ch: ch, solution: solve(ch.nonce, ch.difficulty) }); }, 30); }); })
        .then(function (s) {
          return fetch('/p/notify-me/' + encodeURIComponent(slug) + '/subscribe', {
            method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: email.value, kinds: kinds, productId: productId, country: countrySel ? countrySel.value : '', website: hp.value, captchaToken: s.ch.token, captchaSolution: s.solution }),
          });
        })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
        .then(function (res) {
          if (!res.ok) { btn.disabled = false; msg.className = 'msg err'; msg.textContent = res.status === 429 ? 'Too many attempts - please try again later.' : (res.body && res.body.message) || 'Something went wrong. Please try again.'; return; }
          f.textContent = '';
          f.appendChild(el('p', 'msg', res.body.status === 'updated' ? 'Updated - you already confirmed this address, so you are all set.' : 'Check your inbox and click the link to confirm. Nothing is sent until you do.'));
        })
        .catch(function () { btn.disabled = false; msg.className = 'msg err'; msg.textContent = 'Could not reach the server. Check your connection and try again.'; });
    };
    c.appendChild(f);
    app.appendChild(c);
    if (d.storeUrl) { var p = el('p', 'muted', 'Webstore: '); var a = el('a', '', d.storeUrl.replace(/^https?:\/\//, '')); a.href = d.storeUrl; a.rel = 'noopener'; p.appendChild(a); app.appendChild(p); }
  }

  fetch('/p/notify-me/' + encodeURIComponent(slug) + '/data' + (productId ? '?product=' + encodeURIComponent(productId) : ''), { cache: 'no-store', credentials: 'omit' })
    .then(function (r) { if (!r.ok) throw r; return r.json(); })
    .then(render)
    .catch(function () { status('This page is not available.', true); });
})();
`;

const ACTION_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>One moment</title>
<style>${STYLE}</style>
</head>
<body>
<main id="app"><div class="card" role="status"><p class="muted">One moment…</p></div></main>
<script src="/p/notify-me/action.js"></script>
</body>
</html>
`;

const ACTION_SCRIPT = String.raw`(function () {
  'use strict';
  var app = document.getElementById('app');
  var action = location.pathname.indexOf('/leave') >= 0 ? 'leave' : 'confirm';
  var token = location.hash.slice(1);
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function show(lines, bad) { app.textContent = ''; var c = el('div', 'card'); lines.forEach(function (t) { c.appendChild(el('p', bad ? 'msg err' : 'msg', t)); }); app.appendChild(c); }
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) { show(['This link is not valid.'], true); return; }
  fetch('/p/notify-me/' + action, { method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: token }) })
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
    .then(function (res) {
      if (!res.ok) { show(['This link has expired or was already used.'], true); return; }
      document.title = res.body.shop || document.title;
      if (action === 'leave') show(['Done - ' + (res.body.shop || 'the shop') + ' will not write to you any more.', 'Your address is erased after a month.']);
      else show(['Confirmed. ' + (res.body.shop || 'The shop') + ' will tell you about: ' + (res.body.kinds || []).join(', ') + '.', 'Every mail has a link to stop.']);
    })
    .catch(function () { show(['Could not reach the server. Please try again.'], true); });
})();
`;
