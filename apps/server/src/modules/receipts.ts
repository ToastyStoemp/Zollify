import type Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';
import { fmtRate, isReceiptToken, receiptBreakdown, vatBreakdown, type SalesEvent, type Transaction } from '@zollify/shared';
import {
  issueChallenge,
  parseProfile,
  type ModuleContext,
  reduceTransactions,
  verifyChallenge,
  type PublicModuleContext,
  type ServerModule,
} from '@zollify/server-core';

/**
 * Online receipts - the server half of the POS module's receipt QR code.
 *
 * A customer scans `/p/pos/r#<token>`. The token never reaches this server in
 * a URL: it lives in the fragment, and the page's script sends it in a POST
 * body, so it stays out of access logs, proxies and Referer headers. The
 * shell page and its script are static and hold no data at all.
 *
 * Layers against scraping, cheapest first for an honest visitor:
 *   - the token is 128 random bits, unrelated to the sale id - nothing to
 *     enumerate;
 *   - every lookup costs a fresh proof-of-work, purpose-bound so it cannot be
 *     spent anywhere else (see captcha.ts) - a fraction of a second on a phone,
 *     real money across millions of guesses;
 *   - per-IP rate limits on both the challenge and the lookup, and an IP that
 *     keeps asking for receipts that do not exist is shut out for an hour;
 *   - not-yet-synced, unknown, expired and switched-off all answer the same
 *     404, so the endpoint is no oracle;
 *   - responses are no-store, noindex and same-origin only.
 *
 * What leaves is built field by field in `publicReceipt` - never a spread of
 * the stored sale. Device ids, card auth codes, processor references, cost and
 * base-currency bookkeeping all stay here.
 */

const MODULE_ID = 'pos';
const DIFFICULTY = Math.min(22, Math.max(10, Number(process.env.RECEIPT_CAPTCHA_BITS || 15)));
const LOOKUPS_PER_MIN = Math.max(1, Number(process.env.RECEIPT_LOOKUPS_PER_MIN || 20));
const TTL_DAYS = Math.max(1, Number(process.env.RECEIPT_TTL_DAYS || 400));
const MISS_WINDOW_MS = 15 * 60_000;
const MISS_LIMIT = 10;
const BLOCK_MS = 60 * 60_000;

function migrate(db: Database.Database): void {
  // Partial expression index: the lookup below must repeat this exact
  // expression and WHERE clause for SQLite to use it.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ops_receipt_token
      ON ops (json_extract(payload, '$.receiptToken'))
      WHERE type = 'tx.create';
    CREATE TABLE IF NOT EXISTS pos_branding (
      accountId TEXT PRIMARY KEY,
      logo      TEXT,
      footer    TEXT,
      updatedAt INTEGER NOT NULL
    );
  `);
}

// ── Branding ────────────────────────────────────────────────────────────────
// The logo and footer line a booth sets under POS → Receipts live on each
// device; a copy is kept here so the online receipt and every customer
// display can carry them too.

const LOGO_MAX_BYTES = 256 * 1024;
const FOOTER_MAX = 500;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface Branding {
  /** Base64 PNG, no data: prefix. */
  logo: string | null;
  footer: string | null;
}

function readBranding(db: Database.Database, accountId: string): Branding {
  const row = db.prepare('SELECT logo, footer FROM pos_branding WHERE accountId = ?').get(accountId) as Branding | undefined;
  return { logo: row?.logo ?? null, footer: row?.footer ?? null };
}

/** Only a real, modest PNG is kept - it is later handed to strangers' browsers. */
function cleanLogo(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('The logo must be a base64 PNG.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > LOGO_MAX_BYTES) throw new Error('The logo is too large.');
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('The logo must be a PNG.');
  return bytes.toString('base64');
}

function cleanFooter(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('The footer must be text.');
  const text = value.replace(/\r\n?/g, '\n').trim().slice(0, FOOTER_MAX);
  return text || null;
}

// ── Lookup ──────────────────────────────────────────────────────────────────

interface Found {
  accountId: string;
  tx: Transaction;
}

function findSale(db: Database.Database, token: string): Found | null {
  const row = db
    .prepare(
      `SELECT accountId, opId, payload FROM ops
       WHERE type = 'tx.create' AND json_extract(payload, '$.receiptToken') = ?
       LIMIT 1`,
    )
    .get(token) as { accountId: string; opId: string; payload: string } | undefined;
  if (!row) return null;
  const created = JSON.parse(row.payload) as Transaction;
  // ZollTool wrote reverts as `txId`, Zollify writes `id` - check both.
  const reverts = db
    .prepare(
      `SELECT opId, type, payload FROM ops
       WHERE accountId = ? AND type = 'tx.revert'
         AND (json_extract(payload, '$.id') = ? OR json_extract(payload, '$.txId') = ?)`,
    )
    .all(row.accountId, created.id, created.id) as { opId: string; type: string; payload: string }[];
  const [tx] = reduceTransactions([
    { opId: row.opId, type: 'tx.create', payload: created },
    ...reverts.map((r) => ({ opId: r.opId, type: r.type, payload: JSON.parse(r.payload) })),
  ]);
  return tx ? { accountId: row.accountId, tx } : null;
}

function eventName(db: Database.Database, accountId: string, eventId: string): string {
  if (!eventId) return '';
  const row = db
    .prepare(
      `SELECT payload FROM ops WHERE accountId = ? AND type = 'event.upsert' AND json_extract(payload, '$.id') = ?
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(accountId, eventId) as { payload: string } | undefined;
  if (!row) return '';
  const ev = JSON.parse(row.payload) as SalesEvent;
  return ev.deletedAt ? '' : String(ev.name ?? '');
}

function seller(db: Database.Database, accountId: string): PublicReceipt['seller'] {
  const row = db.prepare('SELECT name, profile FROM accounts WHERE id = ?').get(accountId) as
    | { name: string; profile: string | null }
    | undefined;
  const artist = parseProfile(row?.profile).artist;
  return {
    // Phone, email and EORI stay off: a receipt needs who sold it and their
    // tax registration, not a way to reach them at home.
    name: artist.companyName.trim() || artist.fullName.trim() || row?.name || '',
    address: [artist.street, artist.postCodeCity, artist.countryOfOrigin].map((s) => s.trim()).filter(Boolean),
    vatId: artist.vatId.trim() || undefined,
  };
}

// ── What the customer sees ──────────────────────────────────────────────────

export interface PublicReceipt {
  seller: { name: string; address: string[]; vatId?: string };
  event: string;
  at: number;
  number: string;
  currency: string;
  lines: { title: string; variant?: string; qty: number; amount: number; /** VAT rate letter, when a sale has more than one. */ vat?: string }[];
  discounts: { name: string; amount: number }[];
  total: number;
  payments: { label: string; amount: number }[];
  status: 'paid' | 'voided';
  brand: { logo?: string; footer: string[] };
  /** VAT included per rate, or the exemption the sale was made under. */
  vat: { rows: { letter?: string; rate: string; net: number; vat: number }[]; exemptNote?: string; exNumber?: string };
  /** KassenSichV: what a receipt in Germany must show of the TSE signature, or that the TSE was out. */
  tse?: PublicTse;
  revertTse?: PublicTse;
}

type PublicTse =
  | { failed: true }
  | { transactionNumber: number; signatureCounter: number; start: string; finish: string; clientId: string; serial: string; signature: string; test?: true };

/** Only the fields a German receipt carries - never the failure reason, which can name the device. */
function publicTse(tse: Transaction['tse']): PublicTse | undefined {
  if (!tse) return undefined;
  if ('failed' in tse) return { failed: true };
  const s = tse.signed;
  return {
    transactionNumber: Number(s.transactionNumber) || 0,
    signatureCounter: Number(s.signatureCounter) || 0,
    start: String(s.start).slice(0, 30),
    finish: String(s.finish).slice(0, 30),
    clientId: String(s.clientId).slice(0, 60),
    serial: String(s.serial).slice(0, 128),
    signature: String(s.signature).slice(0, 400),
    ...(s.test ? { test: true as const } : {}),
  };
}

/** Lines at the till's price, in the currency the customer paid - see receiptBreakdown. */
function chargedLines(tx: Transaction): PublicReceipt['lines'] {
  const amounts = receiptBreakdown(tx).lines;
  const rows = vatBreakdown(tx);
  const letterOf = rows.length > 1 ? new Map(rows.map((r) => [r.rate, r.letter])) : null;
  return tx.items.map((i, n) => ({
    title: String(i.title ?? ''),
    variant: i.variantLabel ? String(i.variantLabel) : undefined,
    qty: Number(i.qty) || 0,
    amount: amounts[n]!,
    ...(letterOf && tx.tax?.rates[n] != null ? { vat: letterOf.get(tx.tax.rates[n]!) } : {}),
  }));
}

const CARD_METHODS = new Set(['card', 'split', 'cash']);

function paymentLabel(tx: Transaction, kind: 'cash' | 'card', cardBrand?: string): string {
  if (kind === 'cash') return 'Cash';
  // A booth's own method name (TWINT, PayPal QR…) is what the customer used.
  if (!CARD_METHODS.has(tx.method)) return String(tx.method).slice(0, 40);
  return cardBrand ? `Card · ${String(cardBrand).slice(0, 30)}` : 'Card';
}

/** The whitelist. Anything not copied here does not leave the server. */
export function publicReceipt(
  tx: Transaction,
  extra: { seller: PublicReceipt['seller']; event: string; branding?: Branding },
): PublicReceipt {
  const rows = vatBreakdown(tx);
  const exempt = tx.tax?.exempt === true;
  return {
    // An exempt sale shows its exemption, not a VAT number - as on paper.
    seller: exempt ? { name: extra.seller.name, address: extra.seller.address } : extra.seller,
    event: extra.event,
    at: tx.timestamp,
    number: tx.id.slice(-8).toUpperCase(),
    currency: tx.currency,
    lines: chargedLines(tx),
    discounts: receiptBreakdown(tx).discounts.map((d) => ({ name: String(d.name ?? '').slice(0, 80), amount: Number(d.amount) || 0 })),
    total: tx.total,
    payments: (tx.payments ?? []).map((p) => ({ label: paymentLabel(tx, p.kind, p.cardBrand), amount: Number(p.amount) || 0 })),
    status: tx.revertedAt ? 'voided' : 'paid',
    brand: {
      // Inline, so the logo needs no URL of its own that could name the account.
      logo: extra.branding?.logo ? `data:image/png;base64,${extra.branding.logo}` : undefined,
      footer: (extra.branding?.footer ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12),
    },
    ...(publicTse(tx.tse) ? { tse: publicTse(tx.tse) } : {}),
    ...(publicTse(tx.revertTse) ? { revertTse: publicTse(tx.revertTse) } : {}),
    vat: {
      rows: rows.map((r) => ({ ...(rows.length > 1 ? { letter: r.letter } : {}), rate: fmtRate(r.rate), net: r.net, vat: r.vat })),
      ...(exempt && tx.tax?.note ? { exemptNote: String(tx.tax.note).slice(0, 200) } : {}),
      ...(exempt && tx.tax?.exNumber ? { exNumber: String(tx.tax.exNumber).slice(0, 40) } : {}),
    },
  };
}

// ── Abuse control ───────────────────────────────────────────────────────────

const misses = new Map<string, { count: number; since: number; blockedUntil: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, m] of misses) if (m.blockedUntil < now && now - m.since > MISS_WINDOW_MS) misses.delete(ip);
}, 10 * 60_000).unref?.();

function blocked(ip: string): boolean {
  return (misses.get(ip)?.blockedUntil ?? 0) > Date.now();
}

function recordMiss(ip: string): void {
  const now = Date.now();
  const m = misses.get(ip);
  if (!m || now - m.since > MISS_WINDOW_MS) {
    misses.set(ip, { count: 1, since: now, blockedUntil: 0 });
    return;
  }
  m.count++;
  if (m.count >= MISS_LIMIT) m.blockedUntil = now + BLOCK_MS;
}

/** Test hook: forget every IP's history. */
export function resetReceiptAbuseState(): void {
  misses.clear();
}

// ── Page ────────────────────────────────────────────────────────────────────

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>Your receipt</title>
<style>
:root { --bg: #f1f4f6; --card: #fff; --ink: #1a2230; --muted: #5a6472; --line: #d6dde4; --accent: #0e7c66; --bad: #c6512f; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #11161d; --card: #1a2129; --ink: #e8edf2; --muted: #9aa5b1; --line: #2c3540; --accent: #3fbf9f; --bad: #e57a5a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 26rem; margin: 0 auto; padding: 1.25rem 1rem 3rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 1.25rem; }
h1 { font-size: 1.25rem; margin: 0 0 .15rem; text-align: center; }
.c { text-align: center; }
.muted { color: var(--muted); font-size: .85rem; margin: 0; }
hr { border: 0; border-top: 1px dashed var(--line); margin: 1rem 0; }
.row { display: flex; justify-content: space-between; gap: 1rem; margin: .3rem 0; }
.row span:last-child { font-variant-numeric: tabular-nums; white-space: nowrap; }
.total { font-size: 1.3rem; font-weight: 700; }
.logo { display: block; margin: 0 auto .75rem; max-width: 70%; max-height: 7rem; object-fit: contain; }
@media (prefers-color-scheme: dark) { .logo { background: #fff; padding: .5rem; border-radius: 10px; } }
.good { color: var(--accent); }
.row.muted { color: var(--muted); font-size: .85rem; margin: .1rem 0; }
.row.net { padding-left: 1rem; }
.mono { font-family: ui-monospace, monospace; font-size: .7rem; word-break: break-all; }
.foot { white-space: pre-wrap; margin: .15rem 0; }
.void { color: var(--bad); font-weight: 700; text-align: center; border: 2px solid var(--bad); border-radius: 8px; padding: .4rem; margin-bottom: 1rem; }
.status { text-align: center; padding: 2rem 1rem; }
button { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 8px; padding: .55rem 1rem; cursor: pointer; }
.actions { display: flex; justify-content: center; margin-top: 1rem; }
@media print { body { background: #fff; } .card { border: 0; } .actions { display: none; } }
</style>
</head>
<body>
<main>
  <div id="status" class="card status" role="status"><p>Loading your receipt…</p></div>
  <article id="receipt" class="card" hidden></article>
  <div class="actions"><button id="print" type="button" hidden>Print or save as PDF</button></div>
</main>
<noscript><p class="c">Please enable JavaScript to view your receipt.</p></noscript>
<script src="/p/pos/r/receipt.js"></script>
</body>
</html>
`;

/**
 * The page's script, plain ES5-ish so any phone browser runs it. SHA-256 is
 * synchronous on purpose: WebCrypto's digest is async per call and far too
 * slow for a proof-of-work loop. Mirrors apps/web/src/lib/captcha.ts.
 */
const SCRIPT = String.raw`(function () {
  'use strict';
  var K = new Int32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256(msg) {
    var H = new Int32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    var l = msg.length, bl = (((l + 8) >> 6) + 1) << 6, bytes = new Uint8Array(bl), w = new Int32Array(64), i, o;
    bytes.set(msg); bytes[l] = 0x80;
    var bitLen = l * 8;
    bytes[bl - 4] = (bitLen >>> 24) & 255; bytes[bl - 3] = (bitLen >>> 16) & 255; bytes[bl - 2] = (bitLen >>> 8) & 255; bytes[bl - 1] = bitLen & 255;
    for (o = 0; o < bl; o += 64) {
      for (i = 0; i < 16; i++) w[i] = (bytes[o + i * 4] << 24) | (bytes[o + i * 4 + 1] << 16) | (bytes[o + i * 4 + 2] << 8) | bytes[o + i * 4 + 3];
      for (i = 16; i < 64; i++) {
        var s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var t1 = (h + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        var t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H;
  }
  function zeroBits(H) {
    var bits = 0;
    for (var i = 0; i < 8; i++) {
      if (H[i] === 0) { bits += 32; continue; }
      return bits + Math.clz32(H[i]);
    }
    return bits;
  }
  function solve(nonce, difficulty) {
    var enc = new TextEncoder();
    for (var i = 0; ; i++) if (zeroBits(sha256(enc.encode(nonce + ':' + i))) >= difficulty) return String(i);
  }

  var statusEl = document.getElementById('status');
  var receiptEl = document.getElementById('receipt');
  var printBtn = document.getElementById('print');
  function say(text) { statusEl.textContent = ''; var p = document.createElement('p'); p.textContent = text; statusEl.appendChild(p); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function row(left, right, cls) { var r = el('div', 'row' + (cls ? ' ' + cls : '')); r.appendChild(el('span', '', left)); r.appendChild(el('span', '', right)); return r; }

  var token = (location.hash || '').slice(1);
  // Drop the token from the address bar and history once read.
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) { say('This receipt link is incomplete. Please scan the code again.'); return; }

  function money(n, cur) {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n); }
    catch (e) { return cur + ' ' + n.toFixed(2); }
  }

  function render(r) {
    receiptEl.textContent = '';
    if (r.status === 'voided') receiptEl.appendChild(el('div', 'void', 'This sale was cancelled'));
    if (r.brand && r.brand.logo && /^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(r.brand.logo)) {
      var img = el('img', 'logo');
      img.alt = '';
      img.src = r.brand.logo;
      receiptEl.appendChild(img);
    }
    if (r.seller.name) receiptEl.appendChild(el('h1', '', r.seller.name));
    r.seller.address.forEach(function (line) { receiptEl.appendChild(el('p', 'muted c', line)); });
    if (r.seller.vatId) receiptEl.appendChild(el('p', 'muted c', 'VAT ' + r.seller.vatId));
    receiptEl.appendChild(el('hr'));
    if (r.event) receiptEl.appendChild(el('p', 'muted', r.event));
    receiptEl.appendChild(el('p', 'muted', new Date(r.at).toLocaleString()));
    receiptEl.appendChild(el('hr'));
    r.lines.forEach(function (l) {
      receiptEl.appendChild(row(l.qty + ' × ' + l.title + (l.variant ? ' · ' + l.variant : ''), money(l.amount, r.currency) + (l.vat ? ' ' + l.vat : '')));
    });
    if (r.discounts.length) {
      var sub = r.lines.reduce(function (s, l) { return s + Math.round(l.amount * 100); }, 0) / 100;
      receiptEl.appendChild(el('hr'));
      receiptEl.appendChild(row('Subtotal', money(sub, r.currency)));
    }
    r.discounts.forEach(function (d) { receiptEl.appendChild(row(d.name, '−' + money(d.amount, r.currency), 'good')); });
    receiptEl.appendChild(el('hr'));
    receiptEl.appendChild(row('Total', money(r.total, r.currency), 'total'));
    var vat = r.vat || { rows: [] };
    vat.rows.forEach(function (v) {
      receiptEl.appendChild(row((v.letter ? v.letter + ' ' : '') + 'incl. VAT ' + v.rate, money(v.vat, r.currency), 'muted'));
      receiptEl.appendChild(row('net', money(v.net, r.currency), 'muted net'));
    });
    if (vat.exemptNote) receiptEl.appendChild(el('p', 'muted c', vat.exemptNote));
    if (vat.exNumber) receiptEl.appendChild(el('p', 'muted c', 'EX: ' + vat.exNumber));
    [['TSE', r.tse], ['TSE - Storno', r.revertTse]].forEach(function (pair) {
      var t = pair[1];
      if (!t) return;
      receiptEl.appendChild(el('hr'));
      receiptEl.appendChild(el('p', 'muted', pair[0]));
      if (t.failed) { receiptEl.appendChild(el('p', 'muted', 'TSE ausgefallen - Beleg ohne TSE-Signatur')); return; }
      if (t.test) receiptEl.appendChild(el('p', 'muted', 'Test-TSE - nicht zertifiziert'));
      receiptEl.appendChild(row('Transaktion', String(t.transactionNumber), 'muted'));
      receiptEl.appendChild(row('Signaturzähler', String(t.signatureCounter), 'muted'));
      receiptEl.appendChild(row('Start', new Date(t.start).toLocaleString(), 'muted'));
      receiptEl.appendChild(row('Ende', new Date(t.finish).toLocaleString(), 'muted'));
      receiptEl.appendChild(row('Kasse', t.clientId, 'muted'));
      receiptEl.appendChild(el('p', 'muted mono', 'TSE ' + t.serial));
      receiptEl.appendChild(el('p', 'muted mono', 'Signatur ' + t.signature));
    });
    r.payments.forEach(function (p) { receiptEl.appendChild(row(p.label, money(p.amount, r.currency))); });
    receiptEl.appendChild(el('hr'));
    ((r.brand && r.brand.footer) || []).forEach(function (line) { receiptEl.appendChild(el('p', 'c foot', line)); });
    receiptEl.appendChild(el('p', 'muted c', 'Receipt ' + r.number));
    statusEl.hidden = true;
    receiptEl.hidden = false;
    printBtn.hidden = false;
  }
  printBtn.onclick = function () { window.print(); };

  function fail(res) {
    if (res.status === 429) say('Too many attempts from this network. Please try again later.');
    else if (res.status === 404) say("We couldn't find this receipt. If you just paid, the booth may still be offline - try again in a little while.");
    else say('Something went wrong. Please try again in a moment.');
  }

  fetch('/p/pos/r/challenge', { cache: 'no-store', credentials: 'omit' })
    .then(function (res) { if (!res.ok) { fail(res); throw null; } return res.json(); })
    .then(function (ch) {
      // Let the "Loading…" paint before the CPU-bound solve.
      return new Promise(function (ok) { setTimeout(function () { ok({ ch: ch, solution: solve(ch.nonce, ch.difficulty) }); }, 30); });
    })
    .then(function (s) {
      return fetch('/p/pos/r/lookup', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token, captchaToken: s.ch.token, captchaSolution: s.solution }),
      });
    })
    .then(function (res) { if (!res.ok) { fail(res); throw null; } return res.json(); })
    .then(render)
    .catch(function (err) { if (err !== null) say('Could not reach the server. Check your connection and try again.'); });
})();
`;

// ── The module ──────────────────────────────────────────────────────────────

function ipOf(req: FastifyRequest): string {
  return req.ip;
}

export const receiptsServerModule: ServerModule = {
  id: MODULE_ID,
  migrate,

  /** Signed in: the booth's receipt branding, read by every device, set by owners and admins. */
  routes: (ctx: ModuleContext) => async (app) => {
    app.get('/branding', async (req) => readBranding(ctx.db, ctx.identity(req).accountId));

    app.put<{ Body: { logo?: unknown; footer?: unknown } }>('/branding', { bodyLimit: 512 * 1024 }, async (req, reply) => {
      const who = ctx.identity(req);
      if (who.role !== 'owner' && who.role !== 'admin') {
        return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can change receipt branding.' });
      }
      let logo: string | null | undefined;
      let footer: string | null | undefined;
      try {
        logo = cleanLogo(req.body?.logo);
        footer = cleanFooter(req.body?.footer);
      } catch (err) {
        return reply.code(400).send({ error: 'invalid', message: (err as Error).message });
      }
      const current = readBranding(ctx.db, who.accountId);
      const next: Branding = { logo: logo === undefined ? current.logo : logo, footer: footer === undefined ? current.footer : footer };
      ctx.db
        .prepare(
          `INSERT INTO pos_branding (accountId, logo, footer, updatedAt) VALUES (?, ?, ?, ?)
           ON CONFLICT(accountId) DO UPDATE SET logo = excluded.logo, footer = excluded.footer, updatedAt = excluded.updatedAt`,
        )
        .run(who.accountId, next.logo, next.footer, Date.now());
      return next;
    });
  },

  publicRoutes: (ctx: PublicModuleContext) => async (app) => {
    // Undo the /p/ prefix's cross-origin allowances: a receipt is never meant
    // to be embedded or fetched from anywhere but its own page.
    app.addHook('onSend', async (_req, reply) => {
      reply.removeHeader('access-control-allow-origin');
      reply.header('cross-origin-resource-policy', 'same-origin');
      reply.header('cache-control', 'no-store');
      reply.header('x-robots-tag', 'noindex, nofollow, noarchive');
      reply.header('referrer-policy', 'no-referrer');
    });

    app.get('/r', async (_req, reply) => reply.type('text/html; charset=utf-8').send(PAGE));
    app.get('/r/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(PAGE));
    app.get('/r/receipt.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').send(SCRIPT));

    app.get('/r/challenge', { config: { rateLimit: { max: LOOKUPS_PER_MIN + 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      if (blocked(ipOf(req))) return reply.code(429).send({ error: 'rate_limited' });
      return issueChallenge('receipt', DIFFICULTY);
    });

    app.post<{ Body: { token?: unknown; captchaToken?: unknown; captchaSolution?: unknown } }>(
      '/r/lookup',
      { config: { rateLimit: { max: LOOKUPS_PER_MIN, timeWindow: '1 minute' } }, bodyLimit: 2048 },
      async (req, reply) => {
        const ip = ipOf(req);
        if (blocked(ip)) return reply.code(429).send({ error: 'rate_limited' });
        const body = req.body ?? {};
        const pow = verifyChallenge(String(body.captchaToken ?? ''), String(body.captchaSolution ?? ''), 'receipt');
        if (!pow.ok) return reply.code(403).send({ error: 'challenge_failed' });

        const notFound = () => {
          recordMiss(ip);
          return reply.code(404).send({ error: 'not_found' });
        };
        if (!isReceiptToken(body.token)) return notFound();
        const found = findSale(ctx.db, body.token);
        if (!found || !ctx.isEnabled(found.accountId)) return notFound();
        if (Date.now() - found.tx.timestamp > TTL_DAYS * 86_400_000) return notFound();

        return publicReceipt(found.tx, {
          seller: seller(ctx.db, found.accountId),
          event: eventName(ctx.db, found.accountId, found.tx.eventId),
          branding: readBranding(ctx.db, found.accountId),
        });
      },
    );
  },
};
