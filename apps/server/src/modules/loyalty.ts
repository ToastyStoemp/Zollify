import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  DEFAULT_LOYALTY_SETTINGS,
  LOYALTY_MODULE_ID,
  LOYALTY_PUBLIC_PATH,
  LoyaltySettingsSchema,
  loyaltyUnit,
  memberCodeIn,
  rewardLabel,
  saleLoyalty,
  standingOf,
  type LoyaltySettings,
  type LoyaltyStanding,
  type Transaction,
} from '@zollify/shared';
import {
  isPlainEmail,
  isSandbox,
  issueChallenge,
  makeSecretBox,
  reasonOf,
  reduceTransactions,
  reportProblem,
  resolveProblem,
  verifyChallenge,
  type ModuleContext,
  type ModuleServices,
  type PublicModuleContext,
  type ServerModule,
} from '@zollify/server-core';
import { code128Svg } from './barcode';
import { ensureClass, parseServiceAccount, saveLink, upsertObject, WalletError, type FetchFn, type WalletCard, type WalletConfig, type WalletProgramme } from './google-wallet';
import { POW_SOLVER_JS } from './pow-client';

/**
 * Loyalty - the server half. A customer joins from the QR on the table
 * (email, confirmed by mail) and gets a card: a code in a QR, on a web page
 * and, when the account has a Google Wallet issuer, as a pass on the phone.
 * The till marks a sale as a member's; this reads those sales as they sync
 * and keeps each member's stamps or points in a ledger, the way commissions
 * read what was paid - so a reverted sale takes its stamps back by itself.
 * After each change the pass is brought up to date.
 *
 * Kept about a member: email, the name they gave, the card code, and the
 * ledger. A member with nothing earned for the set number of months is
 * erased; so is a sign-up never confirmed.
 */

const MODULE_ID = LOYALTY_MODULE_ID;
const SECRET_SALT = 'zollify-loyalty-google-v1';
const CONFIRM_DAYS = 7;
const SWEEP_MS = 6 * 60 * 60 * 1000;
const DIFFICULTY = Math.min(22, Math.max(10, Number(process.env.SIGNUP_CAPTCHA_BITS || 15)));

let fetchImpl: FetchFn = (url, init) => fetch(url, init);
/** For tests: a pretend Google. */
export function setWalletFetch(fn: FetchFn | null): void {
  fetchImpl = fn ?? ((url, init) => fetch(url, init));
}

// ── Tables ──────────────────────────────────────────────────────────────────

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loyalty_settings (
      accountId TEXT PRIMARY KEY,
      doc       TEXT NOT NULL,
      joinToken TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS loyalty_google (
      accountId      TEXT PRIMARY KEY,
      issuerId       TEXT NOT NULL,
      serviceAccount TEXT NOT NULL,
      clientEmail    TEXT NOT NULL,
      logoUrl        TEXT NOT NULL DEFAULT '',
      updatedAt      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loyalty_members (
      accountId    TEXT NOT NULL,
      id           TEXT NOT NULL,
      code         TEXT NOT NULL,
      email        TEXT NOT NULL,
      name         TEXT NOT NULL DEFAULT '',
      confirmHash  TEXT,
      createdAt    INTEGER NOT NULL,
      confirmedAt  INTEGER,
      lastEarnedAt INTEGER,
      PRIMARY KEY (accountId, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS loyalty_members_code ON loyalty_members (code);
    CREATE INDEX IF NOT EXISTS loyalty_members_email ON loyalty_members (accountId, email);
    CREATE TABLE IF NOT EXISTS loyalty_ledger (
      accountId TEXT NOT NULL,
      id        TEXT NOT NULL,
      memberId  TEXT NOT NULL,
      saleId    TEXT,
      amount    INTEGER NOT NULL,
      at        INTEGER NOT NULL,
      note      TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS loyalty_ledger_member ON loyalty_ledger (accountId, memberId);
  `);
  // Who made a hand entry (a stamp given, a balance set), added later; sale rows have none.
  const cols = (db.prepare('PRAGMA table_info(loyalty_ledger)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('byUser')) db.exec('ALTER TABLE loyalty_ledger ADD COLUMN byUser TEXT');
}

// ── Rows ────────────────────────────────────────────────────────────────────

interface MemberRow {
  id: string;
  code: string;
  email: string;
  name: string;
  createdAt: number;
  confirmedAt: number | null;
  lastEarnedAt: number | null;
}
const MEMBER_COLS = 'id, code, email, name, createdAt, confirmedAt, lastEarnedAt';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** `LY-` and 16 base32 characters: 80 random bits, the whole secret of a card. */
function newMemberCode(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `LY-${out}`;
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const token = (): string => randomBytes(24).toString('base64url');

function originOf(req: FastifyRequest): string {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  return `${req.protocol}://${req.host}`;
}
const accountName = (db: Database.Database, accountId: string): string => (db.prepare('SELECT name FROM accounts WHERE id = ?').get(accountId) as { name: string } | undefined)?.name ?? '';
const accountCurrency = (db: Database.Database, accountId: string): string => {
  const row = db.prepare('SELECT profile FROM accounts WHERE id = ?').get(accountId) as { profile: string | null } | undefined;
  try {
    return (JSON.parse(row?.profile ?? '{}') as { defaultCurrency?: string }).defaultCurrency ?? 'EUR';
  } catch {
    return 'EUR';
  }
};
const money = (currency: string) => (n: number): string => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
};

function settingsRow(db: Database.Database, accountId: string): { settings: LoyaltySettings; joinToken: string } {
  const row = db.prepare('SELECT doc, joinToken FROM loyalty_settings WHERE accountId = ?').get(accountId) as { doc: string; joinToken: string } | undefined;
  if (!row) {
    const joinToken = token();
    db.prepare('INSERT INTO loyalty_settings (accountId, doc, joinToken) VALUES (?, ?, ?)').run(accountId, JSON.stringify(DEFAULT_LOYALTY_SETTINGS), joinToken);
    return { settings: DEFAULT_LOYALTY_SETTINGS, joinToken };
  }
  const parsed = LoyaltySettingsSchema.safeParse(JSON.parse(row.doc));
  return { settings: parsed.success ? parsed.data : DEFAULT_LOYALTY_SETTINGS, joinToken: row.joinToken };
}
const settingsOf = (db: Database.Database, accountId: string): LoyaltySettings => settingsRow(db, accountId).settings;

function memberById(db: Database.Database, accountId: string, id: string): MemberRow | undefined {
  return db.prepare(`SELECT ${MEMBER_COLS} FROM loyalty_members WHERE accountId = ? AND id = ?`).get(accountId, id) as MemberRow | undefined;
}
/** A confirmed member by card code, with the account it belongs to. */
function memberByCode(db: Database.Database, code: string): (MemberRow & { accountId: string }) | undefined {
  return db.prepare(`SELECT accountId, ${MEMBER_COLS} FROM loyalty_members WHERE code = ? AND confirmedAt IS NOT NULL`).get(code) as (MemberRow & { accountId: string }) | undefined;
}

const emailOf = (db: Database.Database, userId: string | null): string | null => (userId ? ((db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined)?.email ?? null) : null);

/** A hand entry: stamps given or taken, or a balance set - with who did it. */
function handEntry(db: Database.Database, accountId: string, memberId: string, amount: number, note: string, byUser: string): void {
  db.prepare('INSERT INTO loyalty_ledger (accountId, id, memberId, saleId, amount, at, note, byUser) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)').run(accountId, `adj:${randomUUID()}`, memberId, amount, Date.now(), note, byUser);
  if (amount > 0) db.prepare('UPDATE loyalty_members SET lastEarnedAt = ? WHERE accountId = ? AND id = ?').run(Date.now(), accountId, memberId);
}

/** The ledger as the owner sees it: sale rows and hand rows, the latter with who made them. */
function ledgerOf(db: Database.Database, accountId: string, memberId: string) {
  const rows = db.prepare('SELECT id, saleId, amount, at, note, byUser FROM loyalty_ledger WHERE accountId = ? AND memberId = ? ORDER BY at DESC LIMIT 200').all(accountId, memberId) as { id: string; saleId: string | null; amount: number; at: number; note: string; byUser: string | null }[];
  return rows.map((r) => ({ id: r.id, saleId: r.saleId, amount: r.amount, at: r.at, note: r.note, by: r.byUser ? { userId: r.byUser, email: emailOf(db, r.byUser) } : null }));
}

function standing(db: Database.Database, accountId: string, memberId: string, s: LoyaltySettings): LoyaltyStanding {
  const row = db
    .prepare('SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS earned, COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS spent FROM loyalty_ledger WHERE accountId = ? AND memberId = ?')
    .get(accountId, memberId) as { earned: number; spent: number };
  return standingOf(s, row.earned, row.spent);
}

// ── The ledger, from the sales ──────────────────────────────────────────────

/** Writes what one sale did for its member; the same sale again changes nothing. Returns the member touched. */
function applySale(db: Database.Database, accountId: string, s: LoyaltySettings, tx: Transaction): string | null {
  const read = saleLoyalty(s, tx);
  if (!read) return null;
  const member = memberById(db, accountId, read.memberId);
  if (!member || !member.confirmedAt) return null;
  const insert = db.prepare('INSERT OR IGNORE INTO loyalty_ledger (accountId, id, memberId, saleId, amount, at, note) VALUES (?, ?, ?, ?, ?, ?, ?)');
  if (read.earned > 0) insert.run(accountId, `${tx.id}:earn`, member.id, tx.id, read.earned, tx.timestamp, '');
  if (read.spent > 0) insert.run(accountId, `${tx.id}:spend`, member.id, tx.id, -read.spent, tx.timestamp, 'reward');
  if (read.earned > 0) db.prepare('UPDATE loyalty_members SET lastEarnedAt = MAX(COALESCE(lastEarnedAt, 0), ?) WHERE accountId = ? AND id = ?').run(tx.timestamp, accountId, member.id);
  return member.id;
}

/** A reverted sale: its stamps and its reward go. Returns the member touched. */
function revertSale(db: Database.Database, accountId: string, saleId: string): string | null {
  const row = db.prepare('SELECT memberId FROM loyalty_ledger WHERE accountId = ? AND saleId = ? LIMIT 1').get(accountId, saleId) as { memberId: string } | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM loyalty_ledger WHERE accountId = ? AND saleId = ?').run(accountId, saleId);
  return row.memberId;
}

/**
 * The ledger's sale rows rebuilt from every real sale on record - after a
 * restore, or when the earning rule changed and the owner wants the past
 * counted the new way. Adjustments by hand are kept.
 */
function rebuildLedger(db: Database.Database, accountId: string): number {
  const s = settingsOf(db, accountId);
  const ops = db
    .prepare(`SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN ('tx.create', 'tx.revert') AND (type = 'tx.revert' OR payload LIKE ?) ORDER BY seq`)
    .all(accountId, `%${MODULE_ID}%`) as { opId: string; type: string; payload: string }[];
  const txs = reduceTransactions(ops.map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) as unknown })));
  const touched = new Set<string>();
  db.transaction(() => {
    db.prepare('DELETE FROM loyalty_ledger WHERE accountId = ? AND saleId IS NOT NULL').run(accountId);
    for (const tx of txs) {
      if (tx.revertedAt || tx.revertedBy) continue;
      const m = applySale(db, accountId, s, tx);
      if (m) touched.add(m);
    }
  })();
  return touched.size;
}

// ── Google Wallet ───────────────────────────────────────────────────────────

interface GoogleRow {
  issuerId: string;
  serviceAccount: string;
  clientEmail: string;
  logoUrl: string;
}

function makeWallet(jwtSecret: string) {
  const box = makeSecretBox(jwtSecret, SECRET_SALT);
  const configOf = (db: Database.Database, accountId: string): WalletConfig | null => {
    const row = db.prepare('SELECT issuerId, serviceAccount, clientEmail, logoUrl FROM loyalty_google WHERE accountId = ?').get(accountId) as GoogleRow | undefined;
    if (!row) return null;
    return { issuerId: row.issuerId, clientEmail: row.clientEmail, privateKey: box.decrypt<string>(row.serviceAccount), logoUrl: row.logoUrl };
  };
  const programmeOf = (db: Database.Database, accountId: string, s: LoyaltySettings): WalletProgramme => ({
    accountId,
    issuerName: accountName(db, accountId) || 'Zollify',
    programme: s.programme || `${accountName(db, accountId) || 'Loyalty'} card`,
    rewardText: rewardLabel(s, money(accountCurrency(db, accountId))),
  });
  const cardOf = (s: LoyaltySettings, m: MemberRow, st: LoyaltyStanding, origin: string): WalletCard => {
    const cardUrl = `${origin}${LOYALTY_PUBLIC_PATH}c/${m.code}`;
    return {
      memberId: m.id,
      barcodeType: s.passBarcode === 'code128' ? 'CODE_128' : 'QR_CODE',
      barcodeValue: s.passBarcode === 'code128' ? m.code : cardUrl,
      code: m.code,
      holder: m.name || 'Member',
      balance: st.balance,
      unit: loyaltyUnit(s, st.balance),
      rewards: st.rewards,
      nextText: st.rewards > 0 ? `${st.rewards} reward${st.rewards === 1 ? '' : 's'} to use - show this at the till` : `${st.toNext} more ${loyaltyUnit(s, st.toNext)} to the next reward`,
      cardUrl,
    };
  };
  /** Pass updates need a public origin to put in the card's link; without one they wait for the next page view. */
  const originFor = (): string | null => process.env.PUBLIC_ORIGIN?.replace(/\/+$/, '') ?? null;

  return {
    box,
    configOf,
    programmeOf,
    cardOf,
    /** The member's pass on Google's side, made or brought up to date; failures show under Problems. */
    async push(svc: Pick<ModuleServices, 'db' | 'problems'>, accountId: string, memberId: string, origin?: string): Promise<void> {
      const cfg = configOf(svc.db, accountId);
      const base = origin ?? originFor();
      if (!cfg || !base) return;
      const m = memberById(svc.db, accountId, memberId);
      if (!m || !m.confirmedAt) return;
      const s = settingsOf(svc.db, accountId);
      try {
        const p = programmeOf(svc.db, accountId, s);
        await ensureClass(cfg, p, fetchImpl);
        await upsertObject(cfg, p, cardOf(s, m, standing(svc.db, accountId, m.id, s), base), fetchImpl);
        resolveProblem(svc, accountId, 'loyalty.google');
      } catch (err) {
        reportProblem(svc, accountId, {
          kind: 'loyalty.google',
          severity: 'warning',
          message: 'Google Wallet is not taking card updates',
          detail: err instanceof WalletError ? err.message : reasonOf(undefined, err),
          link: '/settings?panel=loyalty.setup',
        });
      }
    },
  };
}
type Wallet = ReturnType<typeof makeWallet>;

// ── Schemas ─────────────────────────────────────────────────────────────────

const GoogleBody = z.object({
  issuerId: z.string().trim().regex(/^\d{10,24}$/, 'The issuer id is the number from the Google Pay & Wallet console.'),
  serviceAccountJson: z.string().min(20).max(20_000),
  logoUrl: z.string().trim().max(500).default(''),
});
const JoinBody = z.object({
  email: z.string().trim().max(254),
  name: z.string().trim().max(80).default(''),
  /** The honeypot: a real person's browser leaves it empty. */
  website: z.string().max(200).optional(),
  captchaToken: z.string().max(2000).default(''),
  captchaSolution: z.string().max(40).default(''),
});
const AdjustBody = z.object({ delta: z.number().int().min(-100_000).max(100_000), note: z.string().trim().max(200).default('') });
const SetBody = z.object({ balance: z.number().int().min(0).max(100_000), note: z.string().trim().max(200).default('') });
const LedgerEditBody = z.object({ amount: z.number().int().min(-100_000).max(100_000), note: z.string().trim().max(200).default('') });

// ── Pages ───────────────────────────────────────────────────────────────────

const h = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
:root{--bg:#f1f4f6;--surface:#fff;--text:#141a22;--muted:#5a6472;--border:#d6dde4;--accent:#0e7c66;--accent-ink:#0a5a4a;--accent-soft:#deeee9}
@media(prefers-color-scheme:dark){:root{--bg:#020617;--surface:#0f172a;--text:#f1f5f9;--muted:#a3aebd;--border:#273449;--accent:#34d399;--accent-ink:#6ee7b7;--accent-soft:rgba(52,211,153,.16)}}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;padding:0 16px 48px}
main{max-width:460px;margin:0 auto}
header{padding:32px 0 16px}
.testmark{border:2px solid #c6512f;color:#c6512f;font-weight:700;text-align:center;padding:4px;margin-top:12px}
.shop{font-size:.78rem;letter-spacing:.16em;text-transform:uppercase;color:var(--accent-ink);font-weight:700;overflow-wrap:anywhere}
h1{font-size:1.6rem;font-weight:800;letter-spacing:-.02em;margin-top:6px;overflow-wrap:anywhere;text-wrap:balance}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px;margin-bottom:14px}
.intro,.hint{color:var(--muted);font-size:.92rem}
.hint{font-size:.85rem;margin-top:8px}
label{display:block;margin-top:12px;font-size:.9rem;font-weight:600}
input{display:block;width:100%;margin-top:4px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;font-size:1rem;background:var(--bg);color:var(--text)}
button,.btn{display:inline-block;margin-top:14px;padding:12px 18px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-weight:700;font-size:1rem;cursor:pointer;text-decoration:none;text-align:center}
.btn.google{background:#1a1a1a;width:100%}
.msg{font-weight:600}.err{color:#c6512f}
.hp{position:absolute;left:-9999px;top:-9999px}
.stamps{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:14px 0}
.stamp{aspect-ratio:1;border-radius:50%;border:2px solid var(--accent);display:flex;align-items:center;justify-content:center;color:var(--accent);font-weight:800}
.stamp.on{background:var(--accent);color:#fff}
.big{font-size:2.4rem;font-weight:800;color:var(--accent-ink);line-height:1.1}
.qr{display:flex;justify-content:center;margin:14px 0}
.qr svg{width:200px;height:200px;background:#fff;padding:8px;border-radius:10px}
.bars{display:flex;justify-content:center;margin:10px 0 4px}
.bars svg{width:100%;max-width:300px;height:64px;background:#fff;padding:6px 8px;border-radius:8px;box-sizing:content-box}
.code{font-family:ui-monospace,Menlo,monospace;text-align:center;color:var(--muted);letter-spacing:.06em}
`;

function page(title: string, body: string, opts: { script?: string; sandbox?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${h(title)}</title><style>${STYLE}</style></head>
<body><main>${opts.sandbox ? '<p class="testmark">Test account - nothing here is real</p>' : ''}${body}</main>
${opts.script ? `<script src="${h(opts.script)}"></script>\n` : ''}</body></html>`;
}

/** The sign-up form's script: solves the proof-of-work and posts the form, no inline script (the CSP forbids one). */
const JOIN_SCRIPT = String.raw`(function () {
  'use strict';
${POW_SOLVER_JS}
  var form = document.getElementById('join');
  if (!form) return;
  var out = document.getElementById('out');
  var btn = form.querySelector('button');
  function say(text, bad) { out.textContent = text; out.className = bad ? 'msg err' : 'msg'; }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    btn.disabled = true;
    say('One moment…');
    fetch('/p/loyalty/challenge', { cache: 'no-store', credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (ch) {
        var body = { email: form.email.value, name: form.name.value, website: form.website.value, captchaToken: ch.token, captchaSolution: solve(ch.nonce, ch.difficulty) };
        return fetch(form.action, { method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { if (!r.ok) throw new Error(r.status === 429 ? 'Too many attempts - please try again later.' : (b && b.message) || 'Something went wrong.'); return b; }); })
      .then(function () { form.querySelector('.fields').hidden = true; say('Check your email: the link there opens your card.'); })
      .catch(function (e) { say(e.message, true); btn.disabled = false; });
  });
})();`;

// ── Module ──────────────────────────────────────────────────────────────────

export function loyaltyServerModule(jwtSecret: string): ServerModule {
  const wallet = makeWallet(jwtSecret);
  const sweep = (db: Database.Database): void => {
    const now = Date.now();
    db.prepare('DELETE FROM loyalty_members WHERE confirmedAt IS NULL AND createdAt < ?').run(now - CONFIRM_DAYS * 24 * 3600 * 1000);
    const accounts = db.prepare('SELECT accountId, doc FROM loyalty_settings').all() as { accountId: string; doc: string }[];
    for (const a of accounts) {
      const s = LoyaltySettingsSchema.safeParse(JSON.parse(a.doc));
      const months = s.success ? s.data.eraseAfterMonths : DEFAULT_LOYALTY_SETTINGS.eraseAfterMonths;
      if (!months) continue;
      const cutoff = now - months * 30.4375 * 24 * 3600 * 1000;
      const stale = db.prepare('SELECT id FROM loyalty_members WHERE accountId = ? AND confirmedAt IS NOT NULL AND COALESCE(lastEarnedAt, confirmedAt) < ?').all(a.accountId, cutoff) as { id: string }[];
      for (const m of stale) eraseMember(db, a.accountId, m.id);
    }
  };

  return {
    id: MODULE_ID,
    // Staff read a card at the till; the programme, the members and Google's key are the admins'.
    minRole: 'member',
    migrate,
    onAccountDeleted(db, accountId) {
      for (const t of ['loyalty_settings', 'loyalty_google', 'loyalty_members', 'loyalty_ledger']) db.prepare(`DELETE FROM ${t} WHERE accountId = ?`).run(accountId);
    },

    // Sales as they sync: a member's sale earns, a reverted one gives back. Test sales (test mode) earn nothing - no real card is stamped by a rehearsal.
    onOps: (svc, accountId, ops) => {
      const s = settingsOf(svc.db, accountId);
      const touched = new Set<string>();
      for (const op of ops) {
        if (op.type === 'tx.create') {
          const tx = op.payload as Transaction;
          if (!tx || typeof tx !== 'object' || !Array.isArray(tx.items)) continue;
          const m = applySale(svc.db, accountId, s, tx);
          if (m) touched.add(m);
        } else if (op.type === 'tx.revert') {
          const id = (op.payload as { id?: string } | null)?.id;
          const m = id ? revertSale(svc.db, accountId, id) : null;
          if (m) touched.add(m);
        }
      }
      for (const m of touched) void wallet.push(svc, accountId, m);
    },

    routes: (ctx: ModuleContext) => async (app) => {
      const { db } = ctx;
      const who = (req: FastifyRequest) => ctx.identity(req);
      const forbidden = { error: 'forbidden', message: 'Only an admin can do that.' };
      const bad = (message: string) => ({ error: 'invalid_request', message });

      app.addHook('onReady', async () => sweep(db));
      const timer = setInterval(() => sweep(db), SWEEP_MS);
      timer.unref();
      app.addHook('onClose', async () => clearInterval(timer));

      const view = (accountId: string, s: LoyaltySettings, m: MemberRow) => ({
        id: m.id,
        code: m.code,
        email: m.email,
        name: m.name,
        joinedAt: m.confirmedAt ?? m.createdAt,
        lastEarnedAt: m.lastEarnedAt,
        standing: standing(db, accountId, m.id, s),
      });

      // ── Settings ──────────────────────────────────────────────────────
      app.get('/settings', async (req, reply) => {
        const me = who(req);
        if (me.role === 'member') return reply.code(403).send(forbidden);
        const { settings, joinToken } = settingsRow(db, me.accountId);
        const g = db.prepare('SELECT issuerId, clientEmail, logoUrl, updatedAt FROM loyalty_google WHERE accountId = ?').get(me.accountId) as Omit<GoogleRow, 'serviceAccount'> & { updatedAt: number } | undefined;
        return {
          settings,
          joinUrl: `${originOf(req)}${LOYALTY_PUBLIC_PATH}j/${joinToken}`,
          currency: accountCurrency(db, me.accountId),
          emailEnabled: ctx.mail.enabled,
          google: g ? { issuerId: g.issuerId, clientEmail: g.clientEmail, logoUrl: g.logoUrl, updatedAt: g.updatedAt } : null,
          members: (db.prepare('SELECT COUNT(*) AS n FROM loyalty_members WHERE accountId = ? AND confirmedAt IS NOT NULL').get(me.accountId) as { n: number }).n,
        };
      });

      app.put('/settings', async (req, reply) => {
        const me = who(req);
        if (me.role === 'member') return reply.code(403).send(forbidden);
        const parsed = LoyaltySettingsSchema.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send(bad('Check the programme settings.'));
        settingsRow(db, me.accountId);
        db.prepare('UPDATE loyalty_settings SET doc = ? WHERE accountId = ?').run(JSON.stringify(parsed.data), me.accountId);
        return { settings: parsed.data };
      });

      /** A new join link: the printed QR stops working, for when it leaked or the table changed hands. */
      app.post('/settings/join-token', async (req, reply) => {
        const me = who(req);
        if (me.role === 'member') return reply.code(403).send(forbidden);
        settingsRow(db, me.accountId);
        const joinToken = token();
        db.prepare('UPDATE loyalty_settings SET joinToken = ? WHERE accountId = ?').run(joinToken, me.accountId);
        return { joinUrl: `${originOf(req)}${LOYALTY_PUBLIC_PATH}j/${joinToken}` };
      });

      // ── Google Wallet ─────────────────────────────────────────────────
      app.put('/google', async (req, reply) => {
        const me = who(req);
        if (me.role === 'member') return reply.code(403).send(forbidden);
        const parsed = GoogleBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send(bad(parsed.error.issues[0]?.message ?? 'Check the Google Wallet details.'));
        let sa;
        try {
          sa = parseServiceAccount(parsed.data.serviceAccountJson);
        } catch (err) {
          return reply.code(400).send(bad(err instanceof Error ? err.message : 'Check the service account file.'));
        }
        const cfg: WalletConfig = { ...sa, issuerId: parsed.data.issuerId, logoUrl: parsed.data.logoUrl };
        // Proved before it is kept: the programme is made on Google's side now.
        try {
          await ensureClass(cfg, wallet.programmeOf(db, me.accountId, settingsOf(db, me.accountId)), fetchImpl);
        } catch (err) {
          return reply.code(409).send({ error: 'google_refused', message: err instanceof Error ? err.message : 'Google did not accept the details.' });
        }
        db.prepare('INSERT INTO loyalty_google (accountId, issuerId, serviceAccount, clientEmail, logoUrl, updatedAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (accountId) DO UPDATE SET issuerId = excluded.issuerId, serviceAccount = excluded.serviceAccount, clientEmail = excluded.clientEmail, logoUrl = excluded.logoUrl, updatedAt = excluded.updatedAt').run(
          me.accountId,
          cfg.issuerId,
          wallet.box.encrypt(sa.privateKey),
          sa.clientEmail,
          cfg.logoUrl,
          Date.now(),
        );
        resolveProblem(ctx, me.accountId, 'loyalty.google');
        return { ok: true, clientEmail: sa.clientEmail };
      });

      app.delete('/google', async (req, reply) => {
        const me = who(req);
        if (me.role === 'member') return reply.code(403).send(forbidden);
        db.prepare('DELETE FROM loyalty_google WHERE accountId = ?').run(me.accountId);
        resolveProblem(ctx, me.accountId, 'loyalty.google');
        return { ok: true };
      });

      // ── Members ───────────────────────────────────────────────────────
      app.get('/members', async (req, reply) => {
        const me = who(req);
        if (me.role === 'member') return reply.code(403).send(forbidden);
        const s = settingsOf(db, me.accountId);
        const rows = db.prepare(`SELECT ${MEMBER_COLS} FROM loyalty_members WHERE accountId = ? AND confirmedAt IS NOT NULL ORDER BY COALESCE(lastEarnedAt, confirmedAt) DESC`).all(me.accountId) as MemberRow[];
        return { members: rows.map((m) => view(me.accountId, s, m)) };
      });

      app.get<{ Params: { id: string } }>('/members/:id', async (req, reply) => {
        const me = who(req);
        if (me.role === 'member') return reply.code(403).send(forbidden);
        const m = memberById(db, me.accountId, req.params.id);
        if (!m || !m.confirmedAt) return reply.code(404).send(bad('No such member.'));
        return { member: view(me.accountId, settingsOf(db, me.accountId), m), ledger: ledgerOf(db, me.accountId, m.id) };
      });

      /** Stamps given or taken by hand - a goodwill stamp, a correction. */
      app.post<{ Params: { id: string } }>('/members/:id/adjust', async (req, reply) => {
        const me = who(req);
        if (me.role === 'member') return reply.code(403).send(forbidden);
        const m = memberById(db, me.accountId, req.params.id);
        if (!m || !m.confirmedAt) return reply.code(404).send(bad('No such member.'));
        const parsed = AdjustBody.safeParse(req.body);
        if (!parsed.success || !parsed.data.delta) return reply.code(400).send(bad('How many, and why?'));
        handEntry(db, me.accountId, m.id, parsed.data.delta, parsed.data.note || 'by hand', me.userId);
        void wallet.push(ctx, me.accountId, m.id, originOf(req));
        return { member: view(me.accountId, settingsOf(db, me.accountId), m) };
      });

      /**
       * A card set to a balance - moving a customer over from an old paper card. Staff may,
       * when the settings allow it; the entry says who did it, and admins can change it.
       */
      app.post<{ Params: { id: string } }>('/members/:id/set', async (req, reply) => {
        const me = who(req);
        const s = settingsOf(db, me.accountId);
        if (me.role === 'member' && !s.staffMaySet) return reply.code(403).send({ error: 'forbidden', message: 'Only an admin can set a balance; an admin can allow staff to under Settings → Loyalty card.' });
        const m = memberById(db, me.accountId, req.params.id);
        if (!m || !m.confirmedAt) return reply.code(404).send(bad('No such member.'));
        const parsed = SetBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send(bad('What should the balance be?'));
        const delta = parsed.data.balance - standing(db, me.accountId, m.id, s).balance;
        if (delta) handEntry(db, me.accountId, m.id, delta, parsed.data.note || `set to ${parsed.data.balance}`, me.userId);
        void wallet.push(ctx, me.accountId, m.id, originOf(req));
        return { member: { id: m.id, code: m.code, name: m.name, standing: standing(db, me.accountId, m.id, s) } };
      });

      /** A hand entry changed or removed by an admin; sale rows are the sales' and stay. */
      app.put<{ Params: { id: string } }>('/ledger/:id', async (req, reply) => {
        const me = who(req);
        if (me.role === 'member') return reply.code(403).send(forbidden);
        const parsed = LedgerEditBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send(bad('Check the entry.'));
        const row = db.prepare('SELECT memberId FROM loyalty_ledger WHERE accountId = ? AND id = ? AND saleId IS NULL').get(me.accountId, req.params.id) as { memberId: string } | undefined;
        if (!row) return reply.code(404).send(bad('No such hand entry.'));
        db.prepare('UPDATE loyalty_ledger SET amount = ?, note = ? WHERE accountId = ? AND id = ?').run(parsed.data.amount, parsed.data.note, me.accountId, req.params.id);
        void wallet.push(ctx, me.accountId, row.memberId, originOf(req));
        return { ledger: ledgerOf(db, me.accountId, row.memberId), standing: standing(db, me.accountId, row.memberId, settingsOf(db, me.accountId)) };
      });

      app.delete<{ Params: { id: string } }>('/ledger/:id', async (req, reply) => {
        const me = who(req);
        if (me.role === 'member') return reply.code(403).send(forbidden);
        const row = db.prepare('SELECT memberId FROM loyalty_ledger WHERE accountId = ? AND id = ? AND saleId IS NULL').get(me.accountId, req.params.id) as { memberId: string } | undefined;
        if (!row) return reply.code(404).send(bad('No such hand entry.'));
        db.prepare('DELETE FROM loyalty_ledger WHERE accountId = ? AND id = ?').run(me.accountId, req.params.id);
        void wallet.push(ctx, me.accountId, row.memberId, originOf(req));
        return { ledger: ledgerOf(db, me.accountId, row.memberId), standing: standing(db, me.accountId, row.memberId, settingsOf(db, me.accountId)) };
      });

      app.delete<{ Params: { id: string } }>('/members/:id', async (req, reply) => {
        const me = who(req);
        if (me.role === 'member') return reply.code(403).send(forbidden);
        if (!memberById(db, me.accountId, req.params.id)) return reply.code(404).send(bad('No such member.'));
        eraseMember(db, me.accountId, req.params.id);
        return { ok: true };
      });

      app.post('/recount', async (req, reply) => {
        const me = who(req);
        if (me.role === 'member') return reply.code(403).send(forbidden);
        return { members: rebuildLedger(db, me.accountId) };
      });

      // ── The till ──────────────────────────────────────────────────────
      /** A scanned or typed card: who it is and where they stand. Staff too - this is what the till needs. */
      app.get('/lookup', async (req, reply) => {
        const me = who(req);
        const code = memberCodeIn(String((req.query as { code?: string }).code ?? ''));
        const m = code ? memberByCode(db, code) : undefined;
        if (!m || m.accountId !== me.accountId) return reply.code(404).send(bad('No card with that code.'));
        const s = settingsOf(db, me.accountId);
        return {
          member: { id: m.id, code: m.code, name: m.name, standing: standing(db, me.accountId, m.id, s) },
          settings: { programme: s.programme, scheme: s.scheme, rewardCost: s.rewardCost, reward: s.reward, stampEvery: s.stampEvery, pointsPerUnit: s.pointsPerUnit, minSpend: s.minSpend },
          /** Whether this person may set the card's balance (admins always; staff when allowed). */
          maySet: me.role !== 'member' || s.staffMaySet,
        };
      });
    },

    publicRoutes: (ctx: PublicModuleContext) => async (app: FastifyInstance) => {
      const { db } = ctx;
      const bad = (message: string) => ({ error: 'invalid_request', message });

      app.get('/challenge', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => issueChallenge('signup', DIFFICULTY));
      app.get('/join.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(JOIN_SCRIPT));

      const accountForJoin = (joinToken: string): { accountId: string; settings: LoyaltySettings } | null => {
        const row = db.prepare('SELECT accountId, doc FROM loyalty_settings WHERE joinToken = ?').get(joinToken) as { accountId: string; doc: string } | undefined;
        if (!row || !ctx.isEnabled(row.accountId)) return null;
        const parsed = LoyaltySettingsSchema.safeParse(JSON.parse(row.doc));
        return { accountId: row.accountId, settings: parsed.success ? parsed.data : DEFAULT_LOYALTY_SETTINGS };
      };

      // ── Joining ───────────────────────────────────────────────────────
      app.get<{ Params: { token: string } }>('/j/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
        const site = accountForJoin(req.params.token);
        if (!site) return reply.code(404).type('text/html; charset=utf-8').send(page('Not found', '<div class="card"><p class="msg">This sign-up link is not in use.</p></div>'));
        const shop = accountName(db, site.accountId);
        const s = site.settings;
        const programme = s.programme || `${shop || 'Loyalty'} card`;
        const reward = rewardLabel(s, money(accountCurrency(db, site.accountId)));
        const body = `<header>${shop ? `<div class="shop">${h(shop)}</div>` : ''}<h1>${h(programme)}</h1>${s.joinIntro ? `<p class="intro">${h(s.joinIntro)}</p>` : ''}</header>
<div class="card"><p class="msg">${h(reward)}</p><p class="hint">${s.scheme === 'stamps' ? `A stamp for every ${h(money(accountCurrency(db, site.accountId))(s.stampEvery))} you spend.` : `${h(String(s.pointsPerUnit))} point${s.pointsPerUnit === 1 ? '' : 's'} for every ${h(accountCurrency(db, site.accountId))} 1 you spend.`} Show your card at the till.</p></div>
<form class="card" id="join" method="post" action="${LOYALTY_PUBLIC_PATH}j/${h(req.params.token)}"><div class="fields">
${ctx.mail.enabled ? '' : '<p class="msg err">Sign-up is not possible right now - the shop cannot send email.</p>'}
<label>Email<input name="email" type="email" autocomplete="email" required maxlength="254"></label>
<label>Name <small>(optional)</small><input name="name" type="text" autocomplete="name" maxlength="80"></label>
<div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
<button type="submit"${ctx.mail.enabled ? '' : ' disabled'}>Get my card</button>
<p class="hint">We email you a link to your card. Your email is used for that and nothing else; a card unused for ${s.eraseAfterMonths || 'many'} months is deleted.</p>
</div><p id="out" class="msg" aria-live="polite"></p></form>`;
        return reply.type('text/html; charset=utf-8').send(page(programme, body, { script: `${LOYALTY_PUBLIC_PATH}join.js`, sandbox: isSandbox(db, site.accountId) }));
      });

      app.post<{ Params: { token: string } }>('/j/:token', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } }, bodyLimit: 8 * 1024 }, async (req, reply) => {
        const site = accountForJoin(req.params.token);
        if (!site) return reply.code(404).send(bad('This sign-up link is not in use.'));
        const parsed = JoinBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send(bad('Check the form.'));
        const b = parsed.data;
        // A filled honeypot is a bot: say yes, do nothing.
        if (b.website) return { emailed: true };
        if (!verifyChallenge(b.captchaToken, b.captchaSolution, 'signup').ok) return reply.code(403).send({ error: 'challenge_failed', message: 'Please try again.' });
        const email = b.email.toLowerCase();
        if (!isPlainEmail(email)) return reply.code(400).send(bad('That email address does not look right.'));
        if (!ctx.mail.enabled) return reply.code(409).send(bad('The shop cannot send email right now.'));
        const shop = accountName(db, site.accountId) || 'The shop';
        const programme = site.settings.programme || `${shop} card`;
        const origin = originOf(req);

        // Already a member: the card link again, never a second card.
        const existing = db.prepare(`SELECT ${MEMBER_COLS} FROM loyalty_members WHERE accountId = ? AND email = ? AND confirmedAt IS NOT NULL`).get(site.accountId, email) as MemberRow | undefined;
        if (existing) {
          await ctx.mail.send({
            to: email,
            accountId: site.accountId,
            subject: `Your ${programme}`,
            text: [`Hi ${existing.name || 'there'},`, '', `You already have a card with ${shop}. Here it is:`, `${origin}${LOYALTY_PUBLIC_PATH}c/${existing.code}`, '', `- ${shop}`].join('\n'),
          });
          return { emailed: true };
        }
        const confirm = token();
        const id = `m_${randomUUID().replace(/-/g, '')}`;
        db.prepare('DELETE FROM loyalty_members WHERE accountId = ? AND email = ? AND confirmedAt IS NULL').run(site.accountId, email);
        db.prepare('INSERT INTO loyalty_members (accountId, id, code, email, name, confirmHash, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(site.accountId, id, newMemberCode(), email, b.name, sha(confirm), Date.now());
        const emailed = await ctx.mail.send({
          to: email,
          accountId: site.accountId,
          subject: `Your ${programme}`,
          text: [`Hi ${b.name || 'there'},`, '', `Open this link to get your ${programme} from ${shop}:`, `${origin}${LOYALTY_PUBLIC_PATH}confirm/${confirm}`, '', `If you did not ask for a card, ignore this email and nothing is kept.`, '', `- ${shop}`].join('\n'),
        });
        return { emailed };
      });

      app.get<{ Params: { token: string } }>('/confirm/:token', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
        const row = db.prepare(`SELECT accountId, ${MEMBER_COLS} FROM loyalty_members WHERE confirmHash = ?`).get(sha(req.params.token)) as (MemberRow & { accountId: string }) | undefined;
        if (!row || !ctx.isEnabled(row.accountId)) return reply.code(404).type('text/html; charset=utf-8').send(page('Not found', '<div class="card"><p class="msg">This link has been used or has expired. Sign up again from the code at the shop.</p></div>'));
        if (!row.confirmedAt) db.prepare('UPDATE loyalty_members SET confirmedAt = ?, confirmHash = NULL WHERE accountId = ? AND id = ?').run(Date.now(), row.accountId, row.id);
        void wallet.push(ctx, row.accountId, row.id, originOf(req));
        return reply.redirect(`${LOYALTY_PUBLIC_PATH}c/${row.code}`, 303);
      });

      // ── The card ──────────────────────────────────────────────────────
      app.get<{ Params: { code: string } }>('/c/:code', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
        const code = memberCodeIn(req.params.code);
        const m = code ? memberByCode(db, code) : undefined;
        if (!m || !ctx.isEnabled(m.accountId)) return reply.code(404).type('text/html; charset=utf-8').send(page('Not found', '<div class="card"><p class="msg">No card with that code.</p></div>'));
        const s = settingsOf(db, m.accountId);
        const shop = accountName(db, m.accountId);
        const programme = s.programme || `${shop || 'Loyalty'} card`;
        const st = standing(db, m.accountId, m.id, s);
        const origin = originOf(req);
        const cardUrl = `${origin}${LOYALTY_PUBLIC_PATH}c/${m.code}`;
        const qr = await QRCode.toString(cardUrl, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
        const cfg = wallet.configOf(db, m.accountId);
        const save = cfg ? saveLink(cfg, wallet.programmeOf(db, m.accountId, s), wallet.cardOf(s, m, st, origin), origin) : null;
        const unit = loyaltyUnit(s, st.balance);
        const stampsDrawn =
          s.scheme === 'stamps' && s.rewardCost <= 20
            ? `<div class="stamps">${Array.from({ length: s.rewardCost }, (_, i) => `<div class="stamp${i < st.balance % s.rewardCost || (st.rewards > 0 && st.balance % s.rewardCost === 0) ? ' on' : ''}">${i + 1}</div>`).join('')}</div>`
            : `<p class="big">${st.balance} <small>${h(unit)}</small></p>`;
        const body = `<header>${shop ? `<div class="shop">${h(shop)}</div>` : ''}<h1>${h(programme)}</h1>${m.name ? `<p class="intro">${h(m.name)}</p>` : ''}</header>
<div class="card">${stampsDrawn}<p class="msg">${st.rewards > 0 ? `${st.rewards} reward${st.rewards === 1 ? '' : 's'} to use - show this at the till.` : `${st.toNext} more ${h(loyaltyUnit(s, st.toNext))} to the next reward.`}</p><p class="hint">${h(rewardLabel(s, money(accountCurrency(db, m.accountId))))}</p></div>
<div class="card"><div class="qr">${qr}</div><div class="bars">${code128Svg(m.code, { height: 60, label: `Barcode ${m.code}` })}</div><p class="code">${h(m.code)}</p><p class="hint">Show this at the till - the square code for a phone or camera, the bars for a barcode scanner - or save it to your phone.</p>${save ? `<a class="btn google" href="${h(save)}">Add to Google Wallet</a>` : ''}</div>
<p class="hint">Bookmark this page: it is your card. Your balance updates after each sale.</p>`;
        return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(page(programme, body, { sandbox: isSandbox(db, m.accountId) }));
      });
    },
  };
}

function eraseMember(db: Database.Database, accountId: string, id: string): void {
  db.prepare('DELETE FROM loyalty_ledger WHERE accountId = ? AND memberId = ?').run(accountId, id);
  db.prepare('DELETE FROM loyalty_members WHERE accountId = ? AND id = ?').run(accountId, id);
}
