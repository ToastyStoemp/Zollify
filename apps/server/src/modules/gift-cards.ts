import { randomInt, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  GIFT_CARD_ALPHABET,
  GIFT_CARD_CODE_LENGTH,
  GIFT_CARD_LOAD_REF_KIND,
  GIFT_CARD_MODULE_ID,
  GIFT_CARD_REDEEM_REF_KIND,
  GiftCardCreateSchema,
  GiftCardNoteSchema,
  GiftCardSettingsSchema,
  formatGiftCardCode,
  giftCardCodeFrom,
  giftCardExpiry,
  giftCardPeriod,
  giftCardState,
  giftCardTotals,
  isGiftCardCode,
  maskGiftCardCode,
  normaliseGiftCardCode,
  type GiftCard,
  type GiftCardMovement,
  type GiftCardSettings,
  type Transaction,
} from '@zollify/shared';
import { reduceTransactions, type ModuleContext, type ServerModule } from '@zollify/server-core';

/**
 * Gift cards - the server half.
 *
 * A card is a code and a currency, kept here so every till of the account
 * can look it up. What is on it is never stored: selling a card is an
 * ordinary sale line that points at it (`load`), spending it is a settling
 * line that points at it (`redeem`, negative), and the balance is summed
 * from those sale lines every time it is asked for - like stock, so a
 * reverted sale gives the money back with no compensating write, and an
 * offline sale counts the moment it syncs.
 *
 * The code is what spends the card, so a list shows it masked to staff; an
 * admin, who could issue any card anyway, sees it whole. Voiding a card and
 * granting value without a sale are admin work, and refused from a shared
 * till (see TILL_DENIED in server-core's auth).
 */

const MODULE_ID = GIFT_CARD_MODULE_ID;
const MAX_LIST = 500;

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gift_cards (
      accountId TEXT NOT NULL,
      id        TEXT NOT NULL,
      code      TEXT NOT NULL UNIQUE,
      doc       TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_gift_cards_account ON gift_cards(accountId, createdAt);
    CREATE TABLE IF NOT EXISTS gift_cards_settings (
      accountId TEXT PRIMARY KEY,
      doc       TEXT NOT NULL
    );
  `);
}

// ── Storage ─────────────────────────────────────────────────────────────────

const parse = (r: { doc: string }): GiftCard => JSON.parse(r.doc) as GiftCard;

function cardsOf(db: Database.Database, accountId: string): GiftCard[] {
  return (db.prepare('SELECT doc FROM gift_cards WHERE accountId = ? ORDER BY createdAt DESC').all(accountId) as { doc: string }[]).map(parse);
}

function cardOf(db: Database.Database, accountId: string, id: string): GiftCard | undefined {
  const row = db.prepare('SELECT doc FROM gift_cards WHERE accountId = ? AND id = ?').get(accountId, id) as { doc: string } | undefined;
  return row ? parse(row) : undefined;
}

function cardByCode(db: Database.Database, accountId: string, code: string): GiftCard | undefined {
  const row = db.prepare('SELECT doc FROM gift_cards WHERE accountId = ? AND code = ?').get(accountId, code) as { doc: string } | undefined;
  return row ? parse(row) : undefined;
}

function save(db: Database.Database, accountId: string, c: GiftCard): void {
  db.prepare(
    `INSERT INTO gift_cards (accountId, id, code, doc, createdAt) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(accountId, id) DO UPDATE SET doc = excluded.doc`,
  ).run(accountId, c.id, c.code, JSON.stringify(c), c.createdAt);
}

/** A code no card on this server has. The space is 2^79, so a clash is a bug, not a chance - but it is checked anyway. */
function newCode(db: Database.Database): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = giftCardCodeFrom(Array.from({ length: GIFT_CARD_CODE_LENGTH }, () => randomInt(GIFT_CARD_ALPHABET.length)));
    if (!db.prepare('SELECT 1 FROM gift_cards WHERE code = ?').get(code)) return code;
  }
  throw new Error('Could not mint a gift card code.');
}

function readSettings(db: Database.Database, accountId: string): GiftCardSettings {
  const row = db.prepare('SELECT doc FROM gift_cards_settings WHERE accountId = ?').get(accountId) as { doc: string } | undefined;
  const parsed = GiftCardSettingsSchema.safeParse(row ? JSON.parse(row.doc) : {});
  return parsed.success ? parsed.data : GiftCardSettingsSchema.parse({});
}

// ── What is on a card, from the till's own records ──────────────────────────

/** A sale line's amount in the card's currency (the book currency when the till converted). */
function lineAmount(tx: Transaction, lineTotal: number, baseLineTotal: number | undefined, currency: string): number {
  if (tx.currency !== currency && tx.baseCurrency === currency && typeof baseLineTotal === 'number') return baseLineTotal;
  return lineTotal;
}

/**
 * Movements per card: every sale line that refers to one, in a sale that was
 * not reverted. Derived on each call. A line's module is stamped by the host
 * that recorded the sale, so another module's line cannot load a card.
 */
export function movementsByCard(db: Database.Database, accountId: string, currencyOf: (id: string) => string | undefined): Map<string, GiftCardMovement[]> {
  // Only the sales that mention this module are parsed; the revert ops are few and tiny.
  const creates = db
    .prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type = 'tx.create' AND payload LIKE ? ORDER BY seq")
    .all(accountId, `%${MODULE_ID}%`) as { opId: string; type: string; payload: string }[];
  const out = new Map<string, GiftCardMovement[]>();
  if (!creates.length) return out;
  const reverts = db.prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type = 'tx.revert' ORDER BY seq").all(accountId) as { opId: string; type: string; payload: string }[];
  const txs = reduceTransactions([...creates, ...reverts].map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) })));
  for (const tx of txs) {
    if (tx.revertedAt || tx.revertedBy) continue;
    for (const item of tx.items) {
      const ref = item.ref;
      if (!ref || ref.moduleId !== MODULE_ID) continue;
      if (ref.kind !== GIFT_CARD_LOAD_REF_KIND && ref.kind !== GIFT_CARD_REDEEM_REF_KIND) continue;
      const currency = currencyOf(ref.id);
      if (!currency) continue;
      const amount = lineAmount(tx, item.lineTotal, item.baseLineTotal, currency);
      // A load puts money on, a redemption takes it off: the sign says which, whatever the line claims.
      if (ref.kind === GIFT_CARD_LOAD_REF_KIND ? amount <= 0 : amount >= 0) continue;
      const list = out.get(ref.id) ?? [];
      list.push({ saleId: tx.id, at: tx.timestamp, kind: ref.kind, amount, label: item.title });
      out.set(ref.id, list);
    }
  }
  return out;
}

function movementsFor(db: Database.Database, accountId: string, cards: GiftCard[]): Map<string, GiftCardMovement[]> {
  const byId = new Map(cards.map((c) => [c.id, c]));
  return movementsByCard(db, accountId, (id) => byId.get(id)?.currency);
}

// ── Views ───────────────────────────────────────────────────────────────────

/** A card as the screens get it. Staff see the code masked: it is what spends the card. */
function view(c: GiftCard, movements: GiftCardMovement[], whole: boolean, now = Date.now()) {
  const totals = giftCardTotals(c, movements);
  return {
    ...c,
    code: whole ? formatGiftCardCode(c.code) : maskGiftCardCode(c.code),
    ...totals,
    state: giftCardState(c, totals, now),
  };
}
export type GiftCardView = ReturnType<typeof view>;

// ── Routes ──────────────────────────────────────────────────────────────────

const IdParam = z.string().min(1).max(80);
const Period = z.object({ from: z.coerce.number().int().min(0), to: z.coerce.number().int().min(0) }).refine((p) => p.to > p.from, { message: 'The period ends before it starts.' });

export const giftCardsServerModule: ServerModule = {
  id: MODULE_ID,
  // Staff sell, look up and redeem cards at the till. Voiding, granting,
  // settings and the report are admin-only below.
  minRole: 'member',
  migrate,
  onAccountDeleted: (db, accountId) => {
    for (const t of ['gift_cards', 'gift_cards_settings']) db.prepare(`DELETE FROM ${t} WHERE accountId = ?`).run(accountId);
  },

  routes: (ctx: ModuleContext) => async (app) => {
    const { db } = ctx;
    const bad = (message: string) => ({ error: 'invalid_request', message });
    const isStaff = (role: string) => role === 'member';
    const forbidden = { error: 'forbidden', message: 'Only an admin can do that.' };

    const viewOf = (accountId: string, c: GiftCard, whole: boolean) => view(c, movementsFor(db, accountId, [c]).get(c.id) ?? [], whole);

    app.get<{ Querystring: { q?: string } }>('/cards', async (req) => {
      const who = ctx.identity(req);
      const q = typeof req.query.q === 'string' ? normaliseGiftCardCode(req.query.q.slice(0, 80)) : '';
      const all = cardsOf(db, who.accountId);
      const movements = movementsFor(db, who.accountId, all);
      const whole = !isStaff(who.role);
      // A search is by the end of the code (what a mask shows) or the note.
      const shown = q ? all.filter((c) => c.code.endsWith(q) || normaliseGiftCardCode(c.note).includes(q)) : all;
      return { cards: shown.slice(0, MAX_LIST).map((c) => view(c, movements.get(c.id) ?? [], whole)), settings: readSettings(db, who.accountId) };
    });

    /** The card behind a scanned or typed code, with what is on it. For the till: any role. */
    app.get<{ Querystring: { code?: string } }>('/cards/lookup', { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async (req, reply) => {
      const who = ctx.identity(req);
      const code = typeof req.query.code === 'string' ? normaliseGiftCardCode(req.query.code.slice(0, 40)) : '';
      if (!isGiftCardCode(code)) return reply.code(400).send(bad('That is not a gift card code.'));
      const c = cardByCode(db, who.accountId, code);
      if (!c) return reply.code(404).send({ error: 'not_found', message: 'No card with that code.' });
      // Whoever holds the code already has it: shown whole.
      return viewOf(who.accountId, c, true);
    });

    app.get<{ Params: { id: string } }>('/cards/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const c = cardOf(db, who.accountId, IdParam.parse(req.params.id));
      if (!c) return reply.code(404).send({ error: 'not_found' });
      return viewOf(who.accountId, c, !isStaff(who.role));
    });

    /** A new card. The value is what the till sells it for; nothing is on it until that sale lands. */
    const create = (granted: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
      const who = ctx.identity(req);
      if (granted && isStaff(who.role)) return reply.code(403).send(forbidden);
      const body = GiftCardCreateSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'That card is not valid.'));
      const settings = readSettings(db, who.accountId);
      if (!granted && body.data.value > settings.maxValue) return reply.code(400).send(bad(`A card can be sold for at most ${settings.maxValue} - change that under Settings.`));
      const now = Date.now();
      const c: GiftCard = {
        id: randomUUID(),
        code: newCode(db),
        currency: body.data.currency,
        value: body.data.value,
        granted: granted ? body.data.value : 0,
        note: body.data.note,
        createdAt: now,
        createdBy: who.userId,
        voidedAt: null,
        expiresAt: giftCardExpiry(now, settings.expiryMonths),
      };
      save(db, who.accountId, c);
      // The code goes back whole: the seller prints it or hands it over now.
      return reply.code(201).send(view(c, [], true, now));
    };
    app.post('/cards', create(false));
    /** Value put on a card without a sale - goodwill, a prize. Admin only, and never from a shared till. */
    app.post('/cards/grant', create(true));

    app.put<{ Params: { id: string } }>('/cards/:id', async (req, reply) => {
      const who = ctx.identity(req);
      const body = GiftCardNoteSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad('That note is not valid.'));
      const c = cardOf(db, who.accountId, IdParam.parse(req.params.id));
      if (!c) return reply.code(404).send({ error: 'not_found' });
      const next = { ...c, note: body.data.note };
      save(db, who.accountId, next);
      return viewOf(who.accountId, next, !isStaff(who.role));
    });

    /** Takes a card out of use: lost, stolen, refunded. The sales that loaded it stay in the books. */
    app.post<{ Params: { id: string } }>('/cards/:id/void', async (req, reply) => {
      const who = ctx.identity(req);
      if (isStaff(who.role)) return reply.code(403).send(forbidden);
      const c = cardOf(db, who.accountId, IdParam.parse(req.params.id));
      if (!c) return reply.code(404).send({ error: 'not_found' });
      if (c.voidedAt) return viewOf(who.accountId, c, true);
      const next = { ...c, voidedAt: Date.now() };
      save(db, who.accountId, next);
      return viewOf(who.accountId, next, true);
    });

    /** Issued, redeemed and still owed per currency, for the books. Admin only: it is the account's money. */
    app.get<{ Querystring: { from?: string; to?: string } }>('/report', async (req, reply) => {
      const who = ctx.identity(req);
      if (isStaff(who.role)) return reply.code(403).send(forbidden);
      const period = Period.safeParse(req.query);
      if (!period.success) return reply.code(400).send(bad(period.error.issues[0]?.message ?? 'Pick a period.'));
      const all = cardsOf(db, who.accountId);
      const movements = movementsFor(db, who.accountId, all);
      return { rows: giftCardPeriod(all.map((card) => ({ card, movements: movements.get(card.id) ?? [] })), period.data.from, period.data.to) };
    });

    app.get('/settings', async (req) => readSettings(db, ctx.identity(req).accountId));

    app.put('/settings', async (req, reply) => {
      const who = ctx.identity(req);
      if (isStaff(who.role)) return reply.code(403).send(forbidden);
      const body = GiftCardSettingsSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send(bad(body.error.issues[0]?.message ?? 'Those settings are not valid.'));
      db.prepare('INSERT INTO gift_cards_settings (accountId, doc) VALUES (?, ?) ON CONFLICT(accountId) DO UPDATE SET doc = excluded.doc').run(who.accountId, JSON.stringify(body.data));
      return body.data;
    });
  },
};
