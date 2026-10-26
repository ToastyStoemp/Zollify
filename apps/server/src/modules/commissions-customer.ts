import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import webpush from 'web-push';
import { z } from 'zod';
import {
  BRIEF_MAX_PICTURES,
  COMMISSION_PUBLIC_PATH,
  COMMISSION_REQUEST_PATH,
  COMMISSION_REQUEST_TOKEN_RE,
  COMMISSION_STATUS_LABEL,
  COMMISSION_TOKEN_RE,
  CommissionRequestSchema,
  CustomerBriefSchema,
  CustomerEmailSchema,
  PUSH_MAX_PER_COMMISSION,
  PushSubscriptionSchema,
  base64BodyLimit,
  findDuplicates,
  isClosedStatus,
  maxBytesFor,
  type BriefPicture,
  type Commission,
  type CommissionSettings,
} from '@zollify/shared';
import { addStorageSource, checkQuota, decodeUpload, issueChallenge, reportProblem, sendRefusal, verifyChallenge, type ModuleContext, type ModuleServices, type PublicModuleContext } from '@zollify/server-core';
import { POW_SOLVER_JS } from './pow-client';

/**
 * Commissions - what the customer brings: a request from the public page,
 * the brief and reference pictures on their tracking page, and browser
 * notifications when the commission moves on.
 *
 * Everything here is reached with a secret in the address: the request
 * page's token (one per account, replaceable), or the commission's own
 * tracking token. Signing up a request costs a proof-of-work and is rate
 * limited like the workshop sign-up. The customer's text and pictures and
 * their push subscriptions are personal data: erased with the customer's
 * other details (see `eraseCustomerFiles`).
 *
 * Push: the server holds one VAPID key pair, made on first start. A
 * subscription's address comes from a stranger's browser and the server
 * posts to it, so only the browsers' own push services are accepted
 * (`isPushEndpoint`) - never an address inside the server's network.
 */

const MODULE_ID = 'commissions';
const DIFFICULTY = Math.min(22, Math.max(10, Number(process.env.SIGNUP_CAPTCHA_BITS || 15)));
/** Requests waiting for an answer, from the public page, before the page stops taking more. */
const MAX_WAITING_REQUESTS = 100;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const bad = (message: string) => ({ error: 'invalid_request', message });


/** A commission made in test mode says so wherever it reaches a person: email subjects and notifications. */
export const testSubject = (c: Pick<Commission, 'test'>, subject: string): string => (c.test ? `[TEST] ${subject}` : subject);

export function migrateCustomerSide(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS commission_files (
      accountId    TEXT NOT NULL,
      id           TEXT NOT NULL,
      commissionId TEXT NOT NULL,
      name         TEXT NOT NULL,
      mime         TEXT NOT NULL,
      size         INTEGER NOT NULL,
      bytes        BLOB NOT NULL,
      createdAt    INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_commission_files ON commission_files(accountId, commissionId);
    CREATE TABLE IF NOT EXISTS commission_push (
      accountId    TEXT NOT NULL,
      commissionId TEXT NOT NULL,
      endpoint     TEXT NOT NULL,
      p256dh       TEXT NOT NULL,
      auth         TEXT NOT NULL,
      createdAt    INTEGER NOT NULL,
      PRIMARY KEY (accountId, commissionId, endpoint)
    );
    CREATE TABLE IF NOT EXISTS commission_request_pages (
      accountId TEXT PRIMARY KEY,
      tokenHash TEXT NOT NULL UNIQUE,
      token     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS commission_push_keys (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      publicKey  TEXT NOT NULL,
      privateKey TEXT NOT NULL
    );
  `);
  // Reference pictures count toward the account's file storage.
  addStorageSource('commission_files', 'size');
  if (!db.prepare('SELECT 1 FROM commission_push_keys WHERE id = 1').get()) {
    const keys = webpush.generateVAPIDKeys();
    db.prepare('INSERT INTO commission_push_keys (id, publicKey, privateKey) VALUES (1, ?, ?)').run(keys.publicKey, keys.privateKey);
  }
}

export function deleteCustomerSide(db: Database.Database, accountId: string): void {
  for (const t of ['commission_files', 'commission_push', 'commission_request_pages']) db.prepare(`DELETE FROM ${t} WHERE accountId = ?`).run(accountId);
}

/** Erasing a customer's details: their pictures and devices go too. */
export function eraseCustomerFiles(db: Database.Database, accountId: string, commissionId: string): void {
  db.prepare('DELETE FROM commission_files WHERE accountId = ? AND commissionId = ?').run(accountId, commissionId);
  db.prepare('DELETE FROM commission_push WHERE accountId = ? AND commissionId = ?').run(accountId, commissionId);
}

// ── Pictures ────────────────────────────────────────────────────────────────

export function picturesOf(db: Database.Database, accountId: string, commissionId: string): BriefPicture[] {
  return db
    .prepare('SELECT id, name, mime, size, createdAt FROM commission_files WHERE accountId = ? AND commissionId = ? ORDER BY createdAt')
    .all(accountId, commissionId) as BriefPicture[];
}

function pictureBytes(db: Database.Database, accountId: string, commissionId: string, id: string): { name: string; mime: string; bytes: Buffer } | undefined {
  return db.prepare('SELECT name, mime, bytes FROM commission_files WHERE accountId = ? AND commissionId = ? AND id = ?').get(accountId, commissionId, id) as
    | { name: string; mime: string; bytes: Buffer }
    | undefined;
}

const PictureBody = z.object({ name: z.string().max(200).default('picture'), data: z.string() });

// ── Push ────────────────────────────────────────────────────────────────────

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export type PushSender = (target: PushTarget, payload: string) => Promise<{ statusCode: number }>;

function vapidSubject(): string {
  if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
  const from = /[^\s<>]+@[^\s<>]+/.exec(process.env.MAIL_FROM ?? '')?.[0];
  if (from) return `mailto:${from}`;
  const origin = process.env.PUBLIC_ORIGIN ?? '';
  return origin.startsWith('https://') ? origin : 'mailto:push@zollify.invalid';
}

let sender: PushSender | null = null;
/** For tests: replaces the real push service. */
export function setPushSender(s: PushSender | null): void {
  sender = s;
}

const pushKeys = (db: Database.Database): { publicKey: string; privateKey: string } =>
  db.prepare('SELECT publicKey, privateKey FROM commission_push_keys WHERE id = 1').get() as { publicKey: string; privateKey: string };

export const pushCount = (db: Database.Database, accountId: string, commissionId: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM commission_push WHERE accountId = ? AND commissionId = ?').get(accountId, commissionId) as { n: number }).n;

/**
 * Tells the customer's devices the commission moved on. Never throws and
 * never holds up the update: a device the push service no longer knows
 * (404, 410) is forgotten, and once the commission is closed every device
 * is, since nothing more will be said.
 */
export async function pushUpdate(svc: Pick<ModuleServices, 'db' | 'problems'>, accountId: string, c: Commission, link: string, shop: string, message: string): Promise<number> {
  const { db } = svc;
  const subs = db.prepare('SELECT endpoint, p256dh, auth FROM commission_push WHERE accountId = ? AND commissionId = ?').all(accountId, c.id) as { endpoint: string; p256dh: string; auth: string }[];
  if (!subs.length) return 0;
  const keys = pushKeys(db);
  const send: PushSender =
    sender ??
    ((target, payload) =>
      webpush.sendNotification(target, payload, { vapidDetails: { subject: vapidSubject(), publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3 * 86400, timeout: 10_000 }));
  const payload = JSON.stringify({
    title: testSubject(c, `${c.title}: ${COMMISSION_STATUS_LABEL[c.status]}`),
    body: message ? `${shop ? `${shop}: ` : ''}${message}`.slice(0, 300) : shop ? `From ${shop}` : '',
    url: link,
    tag: `commission-${c.id}`,
  });
  let sent = 0;
  for (const s of subs) {
    try {
      const res = await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      if (res.statusCode >= 200 && res.statusCode < 300) sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        db.prepare('DELETE FROM commission_push WHERE accountId = ? AND commissionId = ? AND endpoint = ?').run(accountId, c.id, s.endpoint);
      } else {
        reportProblem(svc, accountId, { kind: 'commission-push', key: 'send', severity: 'warning', message: `A browser notification to a customer could not be sent${status ? ` (HTTP ${status})` : ''}.` });
      }
    }
  }
  if (isClosedStatus(c.status)) db.prepare('DELETE FROM commission_push WHERE accountId = ? AND commissionId = ?').run(accountId, c.id);
  return sent;
}

// ── Request page ────────────────────────────────────────────────────────────

/** The request page's token for an account, made on first ask. */
export function requestToken(db: Database.Database, accountId: string, replace = false): string {
  const row = db.prepare('SELECT token FROM commission_request_pages WHERE accountId = ?').get(accountId) as { token: string } | undefined;
  if (row && !replace) return row.token;
  const token = randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO commission_request_pages (accountId, tokenHash, token) VALUES (?, ?, ?) ON CONFLICT(accountId) DO UPDATE SET tokenHash = excluded.tokenHash, token = excluded.token').run(accountId, sha256(token), token);
  return token;
}

const accountForRequestToken = (db: Database.Database, token: string): string | null =>
  (db.prepare('SELECT accountId FROM commission_request_pages WHERE tokenHash = ?').get(sha256(token)) as { accountId: string } | undefined)?.accountId ?? null;

// ── What the commission side lends us ───────────────────────────────────────

export interface CommissionDeps {
  rowOf(db: Database.Database, accountId: string, id: string): { doc: string; token: string } | undefined;
  byToken(db: Database.Database, token: string): { accountId: string; c: Commission } | null;
  save(db: Database.Database, accountId: string, c: Commission, token?: string): void;
  readSettings(db: Database.Database, accountId: string): CommissionSettings;
  shopName(db: Database.Database, accountId: string): string;
  replyTo(db: Database.Database, accountId: string): string | null;
  customers(db: Database.Database, accountId: string): { id: string; name: string; email: string; phone: string }[];
  insertCustomer(db: Database.Database, accountId: string, c: { id: string; name: string; email: string; phone: string; keepFrom: number; createdAt: number; updatedAt: number }): void;
  customerOf(db: Database.Database, accountId: string, id: string): { id: string; name: string; email: string; phone: string } | undefined;
  setCustomerEmail(db: Database.Database, accountId: string, id: string, email: string): void;
  newToken(): string;
  originOf(req: FastifyRequest): string;
}

// ── The owner's routes ─────────────────────────────────────────────────────

export function registerOwnerSide(app: FastifyInstance, ctx: ModuleContext, deps: CommissionDeps): void {
  const { db } = ctx;
  const adminOnly = (role: string) => role === 'member';
  const forbidden = { error: 'forbidden', message: 'Only an admin can do that.' };

  /** A reference picture, for the owner's screen (JSON, since the app fetches with its token). */
  app.get<{ Params: { id: string; pid: string } }>('/commissions/:id/pictures/:pid', async (req, reply) => {
    const who = ctx.identity(req);
    const f = pictureBytes(db, who.accountId, req.params.id, req.params.pid);
    if (!f) return reply.code(404).send({ error: 'not_found' });
    return { name: f.name, mime: f.mime, base64: Buffer.from(f.bytes).toString('base64') };
  });

  app.delete<{ Params: { id: string; pid: string } }>('/commissions/:id/pictures/:pid', async (req, reply) => {
    const who = ctx.identity(req);
    const res = db.prepare('DELETE FROM commission_files WHERE accountId = ? AND commissionId = ? AND id = ?').run(who.accountId, req.params.id, req.params.pid);
    return res.changes ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  /** The request page's address. Made on first ask; the page takes requests only while switched on in the settings. */
  app.get('/request-page', async (req, reply) => {
    const who = ctx.identity(req);
    if (adminOnly(who.role)) return reply.code(403).send(forbidden);
    const token = requestToken(db, who.accountId);
    return { open: deps.readSettings(db, who.accountId).requestsOpen, path: `${COMMISSION_REQUEST_PATH}${token}`, url: `${deps.originOf(req)}${COMMISSION_REQUEST_PATH}${token}` };
  });

  /** A new address; the old one stops working. */
  app.post('/request-page/link', async (req, reply) => {
    const who = ctx.identity(req);
    if (adminOnly(who.role)) return reply.code(403).send(forbidden);
    const token = requestToken(db, who.accountId, true);
    return { open: deps.readSettings(db, who.accountId).requestsOpen, path: `${COMMISSION_REQUEST_PATH}${token}`, url: `${deps.originOf(req)}${COMMISSION_REQUEST_PATH}${token}` };
  });
}

// ── The customer's routes ───────────────────────────────────────────────────

export function registerCustomerSide(app: FastifyInstance, ctx: PublicModuleContext, deps: CommissionDeps): void {
  const { db } = ctx;

  /** The commission behind a tracking token, when its account has the module on. */
  const tracked = (token: string): { accountId: string; c: Commission } | null => {
    if (!COMMISSION_TOKEN_RE.test(token)) return null;
    const found = deps.byToken(db, token);
    return found && ctx.isEnabled(found.accountId) ? found : null;
  };
  /** The account behind a request-page token, while it takes requests. */
  const requestAccount = (token: string): string | null => {
    if (!COMMISSION_REQUEST_TOKEN_RE.test(token)) return null;
    const accountId = accountForRequestToken(db, token);
    return accountId && ctx.isEnabled(accountId) ? accountId : null;
  };
  const tellOwner = (accountId: string, title: string, body: string, groupKey?: string) =>
    ctx.notify(accountId, { kind: 'other', title, body, link: '/m/commissions', minRole: 'member', ...(groupKey ? { groupKey } : {}) });

  app.get('/commission.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(TRACKING_SCRIPT));
  app.get('/request.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(REQUEST_SCRIPT));
  // The service worker: its address decides its scope, so it sits right under /p/commissions/.
  app.get('/sw.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(SERVICE_WORKER));
  app.get('/push-key', async () => ({ publicKey: pushKeys(db).publicKey }));
  app.get('/challenge', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => issueChallenge('signup', DIFFICULTY));

  // ── The request page ──────────────────────────────────────────────────
  app.get<{ Params: { token: string } }>('/request/:token', async (req, reply) => {
    if (!requestAccount(req.params.token)) return reply.code(404).type('text/plain').send('This page is not available.');
    return reply.type('text/html; charset=utf-8').send(REQUEST_PAGE);
  });

  app.get<{ Params: { token: string } }>('/request/:token/data', async (req, reply) => {
    const accountId = requestAccount(req.params.token);
    if (!accountId) return reply.code(404).send({ error: 'not_found' });
    const s = deps.readSettings(db, accountId);
    return { shop: s.shopName || deps.shopName(db, accountId), intro: s.requestIntro, open: s.requestsOpen, maxPictures: BRIEF_MAX_PICTURES, emailEnabled: ctx.mail.enabled };
  });

  app.post<{ Params: { token: string }; Body: Record<string, unknown> }>(
    '/request/:token',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } }, bodyLimit: 16 * 1024 },
    async (req, reply) => {
      const accountId = requestAccount(req.params.token);
      if (!accountId) return reply.code(404).send({ error: 'not_found' });
      const settings = deps.readSettings(db, accountId);
      if (!settings.requestsOpen) return reply.code(409).send(bad('Not taking new requests right now.'));
      const body = req.body ?? {};
      if (!verifyChallenge(String(body.captchaToken ?? ''), String(body.captchaSolution ?? ''), 'signup').ok) {
        return reply.code(403).send({ error: 'challenge_failed', message: 'Please try again.' });
      }
      const input = CommissionRequestSchema.safeParse(body);
      if (!input.success) return reply.code(400).send(bad(input.error.issues[0]?.message ?? 'Check the form.'));
      // The honeypot: answer like a success, store nothing.
      if (input.data.website) return { trackingPath: `${COMMISSION_PUBLIC_PATH}${'A'.repeat(32)}`, emailed: false };

      const waiting = (db.prepare("SELECT COUNT(*) AS n FROM commissions WHERE accountId = ? AND doc LIKE '%\"source\":\"request\"%' AND doc LIKE '%\"status\":\"requested\"%'").get(accountId) as { n: number }).n;
      if (waiting >= MAX_WAITING_REQUESTS) return reply.code(503).send(bad('Too many requests are waiting for an answer - please try again later.'));

      const { name, email, phone, title, text, budget, wantedBy } = input.data;
      const now = Date.now();
      // Always a new customer record: a stranger's form never joins someone else's record. The owner is told when it looks like a returning one.
      const looksKnown = findDuplicates({ email, phone }, deps.customers(db, accountId)).length > 0;
      const customer = { id: randomUUID(), name, email, phone, keepFrom: 0, createdAt: now, updatedAt: now };
      const c: Commission = {
        id: randomUUID(),
        title,
        description: '',
        currency: settings.currency,
        price: 0,
        depositAsked: 0,
        dueDate: '',
        notes: '',
        customerId: customer.id,
        customerErasedAt: null,
        status: 'requested',
        updates: [{ id: randomUUID(), at: now, status: 'requested', changed: true, message: '' }],
        brief: { text, budget, wantedBy, updatedAt: now },
        source: 'request',
        createdAt: now,
        updatedAt: now,
        createdBy: null,
      };
      const token = deps.newToken();
      db.transaction(() => {
        deps.insertCustomer(db, accountId, customer);
        deps.save(db, accountId, c, token);
      })();

      tellOwner(accountId, `New commission request: ${title}`, [name, budget && `budget ${budget}`, wantedBy && `wanted by ${wantedBy}`, looksKnown && 'looks like a returning customer'].filter(Boolean).join(' · '));
      const link = `${deps.originOf(req)}${COMMISSION_PUBLIC_PATH}${token}`;
      const shop = settings.shopName || deps.shopName(db, accountId) || 'The shop';
      let emailed = false;
      if (ctx.mail.enabled) {
        const replyTo = deps.replyTo(db, accountId);
        emailed = await ctx.mail.send({
          to: email,
          accountId,
          subject: `Your request: ${title}`,
          text: [`Hi ${name},`, '', `${shop} got your request "${title}" and will get back to you.`, '', `Follow it, add reference pictures or change what you wrote here: ${link}`, '', `- ${shop}`].join('\n'),
          ...(replyTo ? { replyTo } : {}),
        });
      }
      return reply.code(201).send({ trackingPath: `${COMMISSION_PUBLIC_PATH}${token}`, emailed });
    },
  );

  // ── The brief and pictures on the tracking page ───────────────────────
  type Tok = { Params: { token: string } };

  app.post<Tok>('/:token/brief', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } }, bodyLimit: 16 * 1024 }, async (req, reply) => {
    const found = tracked(req.params.token);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    if (isClosedStatus(found.c.status)) return reply.code(409).send(bad('This commission is closed.'));
    const body = CustomerBriefSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'Check the text.'));
    const prev = found.c.brief;
    if ((prev?.text ?? '') === body.data.text) return { ok: true };
    const now = Date.now();
    deps.save(db, found.accountId, { ...found.c, brief: { text: body.data.text, budget: prev?.budget ?? '', wantedBy: prev?.wantedBy ?? '', updatedAt: now }, updatedAt: now });
    tellOwner(found.accountId, `The customer changed the brief: ${found.c.title}`, body.data.text.slice(0, 140), `brief:${found.c.id}`);
    return { ok: true };
  });

  app.post<Tok>(
    '/:token/pictures',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } }, bodyLimit: base64BodyLimit(maxBytesFor('referenceImage')) },
    async (req, reply) => {
      const found = tracked(req.params.token);
      if (!found) return reply.code(404).send({ error: 'not_found' });
      if (isClosedStatus(found.c.status)) return reply.code(409).send(bad('This commission is closed.'));
      const body = PictureBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad('The picture could not be read. Try again.'));
      if (picturesOf(db, found.accountId, found.c.id).length >= BRIEF_MAX_PICTURES) return reply.code(409).send(bad(`Up to ${BRIEF_MAX_PICTURES} pictures - remove one first.`));
      const file = decodeUpload('referenceImage', body.data.data, { name: body.data.name });
      if (!file.ok) return sendRefusal(reply, file);
      const over = checkQuota(db, found.accountId, file.bytes.length);
      if (over) return sendRefusal(reply, { ...over, message: 'The shop cannot take more pictures right now - please send them another way.' });
      const id = randomUUID();
      const name = body.data.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'picture';
      db.prepare('INSERT INTO commission_files (accountId, id, commissionId, name, mime, size, bytes, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        found.accountId,
        id,
        found.c.id,
        name,
        file.mime,
        file.bytes.length,
        file.bytes,
        Date.now(),
      );
      const n = picturesOf(db, found.accountId, found.c.id).length;
      tellOwner(found.accountId, `Reference pictures: ${found.c.title}`, `${n} picture${n === 1 ? '' : 's'} from the customer`, `pictures:${found.c.id}`);
      return reply.code(201).send({ picture: { id, name, mime: file.mime, size: file.bytes.length } });
    },
  );

  /** A picture on the customer's own page. Photos only (png, jpeg, webp), served so nothing in them can run. */
  app.get<{ Params: { token: string; pid: string } }>('/:token/pictures/:pid', async (req, reply) => {
    const found = tracked(req.params.token);
    const f = found ? pictureBytes(db, found.accountId, found.c.id, req.params.pid) : undefined;
    if (!f) return reply.code(404).send({ error: 'not_found' });
    return reply
      .headers({ 'content-type': f.mime, 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'", 'content-disposition': 'inline' })
      .send(Buffer.from(f.bytes));
  });

  app.post<{ Params: { token: string; pid: string } }>('/:token/pictures/:pid/remove', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const found = tracked(req.params.token);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    if (isClosedStatus(found.c.status)) return reply.code(409).send(bad('This commission is closed.'));
    const res = db.prepare('DELETE FROM commission_files WHERE accountId = ? AND commissionId = ? AND id = ?').run(found.accountId, found.c.id, req.params.pid);
    return res.changes ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  // ── An email for updates, left by the customer ───────────────────────
  // Only while none is on file: whoever holds the link may add an address,
  // never change or read the one the shop has. A commission made at the
  // till with no email gets one this way, from the customer's own phone.
  app.post<Tok>('/:token/email', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } }, bodyLimit: 1024 }, async (req, reply) => {
    const found = tracked(req.params.token);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    if (isClosedStatus(found.c.status) || !found.c.customerId) return reply.code(409).send(bad('This commission is closed.'));
    const body = CustomerEmailSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'Enter a valid email address.'));
    const customer = deps.customerOf(db, found.accountId, found.c.customerId);
    if (!customer) return reply.code(409).send(bad('This commission is closed.'));
    if (customer.email) return reply.code(409).send(bad('The shop already has an email for this commission.'));
    if (!ctx.mail.enabled) return reply.code(409).send(bad('The shop cannot send email right now.'));
    deps.setCustomerEmail(db, found.accountId, customer.id, body.data.email);
    tellOwner(found.accountId, `Email left for updates: ${found.c.title}`, customer.name, `email:${found.c.id}`);
    let emailed = false;
    if (ctx.mail.enabled) {
      const s = deps.readSettings(db, found.accountId);
      const shop = s.shopName || deps.shopName(db, found.accountId) || 'The shop';
      const replyTo = deps.replyTo(db, found.accountId);
      emailed = await ctx.mail.send({
        to: body.data.email,
        accountId: found.accountId,
        subject: testSubject(found.c, `Updates on ${found.c.title}`),
        text: [`${shop} will email you here as "${found.c.title}" moves on.`, '', `Your page: ${deps.originOf(req)}${COMMISSION_PUBLIC_PATH}${req.params.token}`, '', 'Not you? Reply to this email and we will remove the address.', '', `- ${shop}`].join('\n'),
        ...(replyTo ? { replyTo } : {}),
      });
    }
    return { ok: true, emailed };
  });

  // ── Notifications on this device ─────────────────────────────────────
  app.post<Tok>('/:token/push', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, bodyLimit: 4096 }, async (req, reply) => {
    const found = tracked(req.params.token);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    if (isClosedStatus(found.c.status)) return reply.code(409).send(bad('This commission is closed - there will be no more updates.'));
    if (!found.c.customerId) return reply.code(409).send(bad('This commission has no customer any more.'));
    const sub = PushSubscriptionSchema.safeParse(req.body);
    if (!sub.success) return reply.code(400).send(bad(sub.error.issues[0]?.message ?? 'That subscription is not valid.'));
    const known = db.prepare('SELECT 1 FROM commission_push WHERE accountId = ? AND commissionId = ? AND endpoint = ?').get(found.accountId, found.c.id, sub.data.endpoint);
    if (!known && pushCount(db, found.accountId, found.c.id) >= PUSH_MAX_PER_COMMISSION) return reply.code(409).send(bad('Enough devices are notified for this commission already.'));
    db.prepare(
      `INSERT INTO commission_push (accountId, commissionId, endpoint, p256dh, auth, createdAt) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(accountId, commissionId, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    ).run(found.accountId, found.c.id, sub.data.endpoint, sub.data.keys.p256dh, sub.data.keys.auth, Date.now());
    return { ok: true };
  });

  app.post<Tok>('/:token/push/remove', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } }, bodyLimit: 2048 }, async (req, reply) => {
    const found = tracked(req.params.token);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    const endpoint = z.object({ endpoint: z.string().max(1000) }).safeParse(req.body);
    if (!endpoint.success) return reply.code(400).send(bad('Which device?'));
    db.prepare('DELETE FROM commission_push WHERE accountId = ? AND commissionId = ? AND endpoint = ?').run(found.accountId, found.c.id, endpoint.data.endpoint);
    return { ok: true };
  });

  /** So the page can be added to a phone's home screen - on an iPhone, the only way it may notify. */
  app.get<Tok>('/:token/manifest.webmanifest', async (req, reply: FastifyReply) => {
    const found = tracked(req.params.token);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    const s = deps.readSettings(db, found.accountId);
    return reply.type('application/manifest+json').send({
      name: `${found.c.title} - ${s.shopName || deps.shopName(db, found.accountId)}`.slice(0, 80),
      short_name: found.c.title.slice(0, 30),
      start_url: `${COMMISSION_PUBLIC_PATH}${req.params.token}`,
      scope: COMMISSION_PUBLIC_PATH,
      display: 'standalone',
      background_color: '#f1f4f6',
      theme_color: '#0e7c66',
    });
  });
}

// ── Scripts ─────────────────────────────────────────────────────────────────
// Served as files, never inline, so the strict CSP stays. They build every
// node with textContent - never markup from what a shop or customer typed.

const TRACKING_SCRIPT = String.raw`(function () {
  'use strict';
  var token = location.pathname.split('/').filter(Boolean)[2] || '';
  var base = '/p/commissions/' + encodeURIComponent(token);
  function $(id) { return document.getElementById(id); }
  function say(el, text, bad) { if (!el) return; el.hidden = !text; el.textContent = text || ''; el.className = 'msg' + (bad ? ' err' : ''); }
  function post(url, body) {
    return fetch(url, { method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { if (!r.ok) throw new Error((b && b.message) || 'Something went wrong. Please try again.'); return b; }); });
  }
  function toBase64(file) {
    return new Promise(function (ok, fail) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { fail(new Error('Could not read ' + file.name)); };
      r.readAsDataURL(file);
    });
  }
  var busy = false;
  var dirty = false;

  // ── The brief ──
  var form = $('brief');
  if (form) {
    var text = $('brief-text');
    var files = $('brief-files');
    var msg = $('brief-msg');
    text.addEventListener('input', function () { dirty = true; });
    files.addEventListener('change', function () { dirty = true; });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      busy = true;
      say(msg, 'Saving…');
      var picked = Array.prototype.slice.call(files.files || []);
      post(base + '/brief', { text: text.value })
        .then(function () {
          return picked.reduce(function (p, f, i) {
            return p.then(function () {
              say(msg, 'Sending picture ' + (i + 1) + ' of ' + picked.length + '…');
              return toBase64(f).then(function (data) { return post(base + '/pictures', { name: f.name, data: data }); });
            });
          }, Promise.resolve());
        })
        .then(function () { dirty = false; location.reload(); })
        .catch(function (err) { busy = false; say(msg, err.message, true); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-remove]'), function (b) {
      b.addEventListener('click', function () {
        if (busy) return;
        busy = true;
        post(base + '/pictures/' + encodeURIComponent(b.getAttribute('data-remove')) + '/remove', {})
          .then(function () { location.reload(); })
          .catch(function (err) { busy = false; say(msg, err.message, true); });
      });
    });
  }

  // ── An email for updates ──
  var mailForm = $('email-form');
  if (mailForm) {
    var mailInput = $('email-input');
    var mailMsg = $('email-msg');
    mailInput.addEventListener('input', function () { dirty = true; });
    mailForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      busy = true;
      say(mailMsg, 'Saving…');
      post(base + '/email', { email: mailInput.value })
        .then(function (res) { busy = false; dirty = false; mailForm.textContent = ''; var p = document.createElement('p'); p.className = 'msg'; p.textContent = 'Thanks - you will get updates by email.' + (res && res.emailed ? ' We sent you a note to check it arrives.' : ''); mailForm.appendChild(p); })
        .catch(function (err) { busy = false; say(mailMsg, err.message, true); });
    });
  }

  // ── Notifications on this device ──
  var pushBox = $('push');
  if (pushBox) {
    var pushBtn = $('push-btn');
    var pushMsg = $('push-msg');
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    var can = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
    function keyBytes(b64) {
      var s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4));
      var out = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }
    function reg() { return navigator.serviceWorker.register('/p/commissions/sw.js', { scope: '/p/commissions/' }); }
    function show(on) {
      pushBox.hidden = false;
      pushBtn.hidden = false;
      pushBtn.textContent = on ? 'Turn off notifications on this device' : 'Notify me on this device';
      pushBtn.setAttribute('data-on', on ? '1' : '');
      say(pushMsg, on ? 'This device gets a notification when your commission moves on.' : '');
    }
    if (!can) {
      pushBox.hidden = false;
      pushBtn.hidden = true;
      say(pushMsg, ios && !standalone ? 'On an iPhone or iPad: tap Share, then "Add to Home Screen", open the page from there, and turn notifications on.' : 'This browser cannot show notifications from this page. We will email you instead, if you gave us your address.');
    } else {
      reg().then(function (r) { return r.pushManager.getSubscription(); }).then(function (s) { show(!!s); }).catch(function () { show(false); });
      pushBtn.addEventListener('click', function () {
        pushBtn.disabled = true;
        var on = pushBtn.getAttribute('data-on') === '1';
        var done = function () { pushBtn.disabled = false; };
        if (on) {
          reg().then(function (r) { return r.pushManager.getSubscription(); })
            .then(function (s) { if (!s) return null; var ep = s.endpoint; return s.unsubscribe().then(function () { return post(base + '/push/remove', { endpoint: ep }); }); })
            .then(function () { show(false); done(); })
            .catch(function (err) { say(pushMsg, err.message, true); done(); });
          return;
        }
        Notification.requestPermission()
          .then(function (p) { if (p !== 'granted') throw new Error('Notifications are blocked for this page - allow them in the browser settings to turn them on.'); return reg(); })
          .then(function (r) {
            return fetch('/p/commissions/push-key', { cache: 'no-store', credentials: 'omit' }).then(function (x) { return x.json(); })
              .then(function (k) { return r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(k.publicKey) }); })
              // The browser's own push service said no (offline, or a browser without one): say so in words.
              .catch(function () { throw new Error('This browser could not turn on notifications right now. Try again later, or rely on email if you gave us your address.'); });
          })
          .then(function (s) { return post(base + '/push', s.toJSON()); })
          .then(function () { show(true); done(); })
          .catch(function (err) { say(pushMsg, err.message, true); done(); });
      });
    }
  }

  // ── Fresh news, unless the customer is in the middle of writing ──
  if (document.body.getAttribute('data-watch') === '1') {
    setInterval(function () { if (!busy && !dirty && !document.hidden) location.reload(); }, 300000);
  }
})();
`;

const SERVICE_WORKER = String.raw`'use strict';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: e.data ? e.data.text() : 'Your commission' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Your commission', { body: d.body || '', tag: d.tag || undefined, data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if (list[i].url === url && 'focus' in list[i]) return list[i].focus();
    return self.clients.openWindow(url);
  }));
});
`;

const REQUEST_STYLE = `
:root{--bg:#f1f4f6;--surface:#fff;--text:#141a22;--muted:#5a6472;--border:#d6dde4;--accent:#0e7c66;--accent-ink:#0a5a4a;--bad:#c6512f;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#020617;--surface:#0f172a;--text:#f1f5f9;--muted:#a3aebd;--border:#273449;--accent:#34d399;--accent-ink:#6ee7b7;--bad:#e57a5a}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);padding:0 16px 48px}
main{max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
header{padding:32px 0 4px}
.shop{font-size:.78rem;letter-spacing:.16em;text-transform:uppercase;color:var(--accent-ink);font-weight:700;overflow-wrap:anywhere}
h1{font-size:1.6rem;margin:6px 0 0}
.intro{white-space:pre-wrap;color:var(--muted);margin:0;overflow-wrap:anywhere}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:12px}
label{display:flex;flex-direction:column;gap:4px;font-size:.92rem}
label small{color:var(--muted)}
input,textarea{font:inherit;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);width:100%}
textarea{min-height:8rem;resize:vertical}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button{font:inherit;font-weight:700;padding:12px 16px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.thumbs{display:flex;gap:8px;flex-wrap:wrap}
.thumbs img{width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--border)}
.msg{margin:0;font-size:.92rem}.msg.err{color:var(--bad)}
.muted{color:var(--muted);font-size:.85rem;margin:0}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
a{color:var(--accent-ink)}
@media(max-width:420px){.two{grid-template-columns:1fr}}
`;

const REQUEST_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="referrer" content="no-referrer" />
<title>Request a commission</title>
<style>${REQUEST_STYLE}</style>
</head>
<body>
<main id="app"><div class="card" role="status"><p class="muted">Loading…</p></div></main>
<noscript><p class="muted">Please enable JavaScript to send a request.</p></noscript>
<script src="/p/commissions/request.js"></script>
</body>
</html>
`;

const REQUEST_SCRIPT = String.raw`(function () {
  'use strict';
${POW_SOLVER_JS}
  var app = document.getElementById('app');
  var token = location.pathname.split('/').filter(Boolean)[3] || '';
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function field(label, input, hint) { var l = el('label'); var s = el('span', '', label); if (hint) { s.appendChild(document.createTextNode(' ')); s.appendChild(el('small', '', hint)); } l.appendChild(s); l.appendChild(input); return l; }
  function input(type, max, required) { var i = el(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') i.type = type; if (max) i.maxLength = max; if (required) i.required = true; return i; }
  function status(text, bad) { app.textContent = ''; var c = el('div', 'card'); c.appendChild(el('p', bad ? 'msg err' : 'msg', text)); app.appendChild(c); }
  function post(url, body) {
    return fetch(url, { method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { if (!r.ok) { var e = new Error(r.status === 429 ? 'Too many attempts - please try again later.' : (b && b.message) || 'Something went wrong. Please try again.'); throw e; } return b; }); });
  }
  function toBase64(file) {
    return new Promise(function (ok, fail) { var r = new FileReader(); r.onload = function () { ok(String(r.result).split(',')[1] || ''); }; r.onerror = function () { fail(new Error('Could not read ' + file.name)); }; r.readAsDataURL(file); });
  }

  function render(d) {
    app.textContent = '';
    document.title = d.shop ? 'Request a commission - ' + d.shop : 'Request a commission';
    var h = el('header');
    if (d.shop) h.appendChild(el('div', 'shop', d.shop));
    h.appendChild(el('h1', '', 'Request a commission'));
    app.appendChild(h);
    if (d.intro) app.appendChild(el('p', 'intro', d.intro));
    if (!d.open) { var c0 = el('div', 'card'); c0.appendChild(el('p', 'msg', 'Not taking new requests right now - please check back later.')); app.appendChild(c0); return; }

    var f = el('form', 'card');
    var name = input('text', 120, true); name.autocomplete = 'name';
    var email = input('email', 254, true); email.autocomplete = 'email';
    var phone = input('tel', 40, false); phone.autocomplete = 'tel';
    var title = input('text', 120, true); title.placeholder = 'e.g. Fox portrait, A4, charcoal';
    var text = input('textarea', 4000, true); text.placeholder = 'What you would like, the style, size, colours, anything we should know.';
    var budget = input('text', 80, false); budget.placeholder = 'e.g. around 150';
    var wanted = input('date', 0, false);
    var pics = el('input'); pics.type = 'file'; pics.accept = 'image/png,image/jpeg,image/webp'; pics.multiple = true;
    var thumbs = el('div', 'thumbs');
    var hp = input('text', 200, false); hp.tabIndex = -1; hp.autocomplete = 'off';
    var hpWrap = el('div', 'hp'); hpWrap.setAttribute('aria-hidden', 'true'); hpWrap.appendChild(field('Website', hp));
    f.appendChild(field('Your name', name));
    f.appendChild(field('Email', email, 'we send you a link to follow your request'));
    f.appendChild(field('Phone', phone, 'optional'));
    f.appendChild(field('What would you like?', title));
    f.appendChild(field('Tell us more', text));
    var two = el('div', 'two'); two.appendChild(field('Budget', budget, 'optional')); two.appendChild(field('Wanted by', wanted, 'optional')); f.appendChild(two);
    f.appendChild(field('Reference pictures', pics, 'optional, up to ' + d.maxPictures + ', PNG, JPEG or WebP, 5 MB each'));
    f.appendChild(thumbs);
    f.appendChild(hpWrap);
    var btn = el('button', '', 'Send request'); btn.type = 'submit';
    var msg = el('p', 'msg'); msg.hidden = true;
    f.appendChild(btn); f.appendChild(msg);
    f.appendChild(el('p', 'muted', 'We keep your name and contact details only to make and hand over your commission, and erase them once it is done.'));
    app.appendChild(f);

    pics.addEventListener('change', function () {
      thumbs.textContent = '';
      var list = Array.prototype.slice.call(pics.files || []);
      if (list.length > d.maxPictures) { msg.hidden = false; msg.className = 'msg err'; msg.textContent = 'Up to ' + d.maxPictures + ' pictures, please.'; }
      list.slice(0, d.maxPictures).forEach(function (file) { var i = el('img'); i.alt = file.name; i.src = URL.createObjectURL(file); thumbs.appendChild(i); });
    });

    f.onsubmit = function (e) {
      e.preventDefault();
      var list = Array.prototype.slice.call(pics.files || []).slice(0, d.maxPictures);
      btn.disabled = true; msg.hidden = false; msg.className = 'msg'; msg.textContent = 'Sending…';
      fetch('/p/commissions/challenge', { cache: 'no-store', credentials: 'omit' })
        .then(function (r) { if (!r.ok) throw new Error('Could not reach the server. Please try again.'); return r.json(); })
        .then(function (ch) { return new Promise(function (ok) { setTimeout(function () { ok({ ch: ch, solution: solve(ch.nonce, ch.difficulty) }); }, 30); }); })
        .then(function (s) {
          return post('/p/commissions/request/' + encodeURIComponent(token), { name: name.value, email: email.value, phone: phone.value, title: title.value, text: text.value, budget: budget.value, wantedBy: wanted.value, website: hp.value, captchaToken: s.ch.token, captchaSolution: s.solution });
        })
        .then(function (res) {
          var sent = 0;
          return list.reduce(function (p, file, i) {
            return p.then(function () {
              msg.textContent = 'Sending picture ' + (i + 1) + ' of ' + list.length + '…';
              return toBase64(file).then(function (data) { return post(res.trackingPath + '/pictures', { name: file.name, data: data }); }).then(function () { sent++; }, function () {});
            });
          }, Promise.resolve()).then(function () { return { res: res, sent: sent }; });
        })
        .then(function (r) {
          f.textContent = '';
          f.appendChild(el('p', 'msg', 'Thank you - your request is in.' + (r.res.emailed ? ' We sent the link to your email.' : '')));
          if (r.sent < list.length) f.appendChild(el('p', 'msg err', (list.length - r.sent) + ' picture(s) could not be sent - add them on your page.'));
          var p = el('p', 'msg'); var a = el('a', '', 'Follow your request'); a.href = r.res.trackingPath; p.appendChild(a);
          p.appendChild(document.createTextNode(r.res.emailed ? '' : ' - keep this link, it is the only copy.'));
          f.appendChild(p);
        })
        .catch(function (err) { btn.disabled = false; msg.className = 'msg err'; msg.textContent = err.message || 'Could not reach the server. Check your connection and try again.'; });
    };
  }

  fetch('/p/commissions/request/' + encodeURIComponent(token) + '/data', { cache: 'no-store', credentials: 'omit' })
    .then(function (r) { if (!r.ok) throw r; return r.json(); })
    .then(render)
    .catch(function () { status('This page is not available.', true); });
})();
`;
