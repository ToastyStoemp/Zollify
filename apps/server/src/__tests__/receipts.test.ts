import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled } from '@zollify/server-core';

/**
 * The receipt page is open to anyone with a phone, so what is worth proving
 * is what it refuses: data beyond the receipt itself, lookups that skip the
 * proof-of-work, challenges spent twice or minted for something else, and an
 * address that keeps guessing.
 */

process.env.RECEIPT_CAPTCHA_BITS = '10';
// Every test here comes from one address; the per-minute cap is the rate-limit plugin's job.
process.env.RECEIPT_LOOKUPS_PER_MIN = '1000';
const { posServerModule, resetReceiptAbuseState } = await import('../modules/receipts');

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'correct horse battery staple';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const VOID_TOKEN = 'VoidVoidVoidVoidVoid00';
const FX_TOKEN = 'FxFxFxFxFxFxFxFxFxFx01';
const DISC_TOKEN = 'DiscDiscDiscDiscDisc02';
const VAT_TOKEN = 'VatVatVatVatVatVatVat3';
const EXEMPT_TOKEN = 'ExemptExemptExemptExe4';
const TSE_TOKEN = 'TseTseTseTseTseTseTse5';
const TSE_FAIL_TOKEN = 'TseFailTseFailTseFail6';

const TSE_SIGNED = { clientId: 'ZOLLIFY-1', serial: 'ab'.repeat(32), transactionNumber: 13, signatureCounter: 44131, start: '2026-10-03T12:00:01.000Z', finish: '2026-10-03T12:00:09.000Z', algorithm: 'ecdsa-plain-SHA384', timeFormat: 'unixTime', signature: 'SIGNATURE', publicKey: 'PUBLICKEY', processType: 'Kassenbeleg-V1', processData: 'Beleg^45.00_0.00_0.00_0.00_0.00^45.00:Bar' };

let app: FastifyInstance;
let dataDir: string;
let token: string;
let accountId: string;

const auth = () => ({ authorization: `Bearer ${token}` });

function solve(nonce: string, difficulty: number): string {
  for (let i = 0; ; i++) {
    const d = createHash('sha256').update(`${nonce}:${i}`).digest();
    let bits = 0;
    for (const b of d) {
      if (b === 0) { bits += 8; continue; }
      bits += Math.clz32(b) - 24;
      break;
    }
    if (bits >= difficulty) return String(i);
  }
}

async function solved(url = '/p/pos/r/challenge'): Promise<{ captchaToken: string; captchaSolution: string }> {
  const res = await app.inject({ method: 'GET', url });
  if (res.statusCode !== 200) throw new Error(`challenge refused: ${res.statusCode}`);
  const ch = res.json() as { token: string; nonce: string; difficulty: number };
  return { captchaToken: ch.token, captchaSolution: solve(ch.nonce, ch.difficulty) };
}

async function lookup(receiptToken: string, pow?: { captchaToken: string; captchaSolution: string }) {
  return app.inject({ method: 'POST', url: '/p/pos/r/lookup', payload: { token: receiptToken, ...(pow ?? (await solved())) } });
}

const sale = (id: string, receiptToken: string, extra: Record<string, unknown> = {}) => ({
  id,
  eventId: 'ev-1',
  deviceId: 'secret-device-id',
  timestamp: Date.now(),
  method: 'card',
  payments: [{ kind: 'card', amount: 45, provider: 'mypos', txRef: 'PROC-REF-123', cardBrand: 'VISA', authCode: 'AUTH999' }],
  items: [
    { pid: 'p-1', vid: null, title: 'Harbour print', qty: 2, unitPrice: 20, lineTotal: 40 },
    { pid: 'p-2', vid: null, title: 'Sticker', qty: 1, unitPrice: 5, lineTotal: 5 },
  ],
  discounts: [],
  total: 45,
  currency: 'CHF',
  receiptToken,
  ...extra,
});

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-receipts-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = OWNER_PASSWORD;

  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [posServerModule('test-secret-value-long-enough-for-signing')],
    defaultModules: ['pos'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'Test' },
  });
  token = login.json().accessToken;
  accountId = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth() })).json().user.accountId;

  await app.inject({
    method: 'PUT',
    url: '/api/account/profile',
    headers: auth(),
    payload: { artist: { companyName: 'Harbour Prints', street: 'Hafenweg 1', postCodeCity: '8000 Zürich', vatId: 'CHE-123.456.789', phone: '+41 79 000 00 00', email: 'home@example.test', eori: 'EORI-SECRET' } },
  });

  const op = (n: number, type: string, payload: unknown) => ({ opId: `op-${String(n).padStart(16, '0')}`, deviceId: 'dev-1', ts: n, type, payload });
  const push = await app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: auth(),
    payload: {
      deviceId: 'dev-1',
      ops: [
        op(1, 'event.upsert', { id: 'ev-1', name: 'Fantasy Basel', venue: { city: 'Basel' }, currency: 'CHF', status: 'active', updatedAt: 1 }),
        op(2, 'tx.create', sale('tx-00000000-aaaa-1234abcd', TOKEN)),
        op(3, 'tx.create', sale('tx-void', VOID_TOKEN)),
        op(4, 'tx.revert', { id: 'tx-void', revertedAt: Date.now() }),
        // Lines in CHF, charged in EUR at a rounded local total.
        op(5, 'tx.create', sale('tx-fx', FX_TOKEN, { total: 47, currency: 'EUR', baseCurrency: 'CHF', baseTotal: 45, exchangeRate: 1.04, payments: [{ kind: 'cash', amount: 47 }], method: 'cash' })),
        op(6, 'tx.create', sale('tx-disc', DISC_TOKEN, {
          items: [{ pid: 'p-1', vid: null, title: 'Harbour print', qty: 2, unitPrice: 20, lineTotal: 36 }],
          total: 36,
          payments: [{ kind: 'cash', amount: 36 }],
          method: 'cash',
          asCharged: { listTotals: [40], discounts: [{ name: 'Bundle deal', amount: 4 }] },
        })),
        op(7, 'tx.create', sale('tx-vat', VAT_TOKEN, { currency: 'EUR', tax: { country: 'DE', exempt: false, rates: [19, 7] } })),
        op(9, 'tx.create', sale('tx-tse', TSE_TOKEN, { currency: 'EUR', receipt: { till: 'ZOLLIFY-1', number: 42 }, tse: { signed: TSE_SIGNED } })),
        // Cancelled on another till, which numbered and signed the cancellation.
        // Till 1 closed the day of receipt 42.
        op(12, 'closing.create', { id: 'cl-1', till: 'ZOLLIFY-1', number: 1, createdAt: Date.parse('2026-10-03T20:00:00Z'), businessDay: '2026-10-03', firstReceipt: 42, lastReceipt: 42, eventId: 'ev-1', currency: 'EUR', deviceId: 'dev-1', device: { brand: 'myPOS', model: 'Carbon', software: 'Zollify', version: 'test' }, receipts: 1, total: 45, cash: 0 }),
        op(11, 'tx.revert', { id: 'tx-tse', revertedAt: Date.now(), revertReceipt: { till: 'ZOLLIFY-2', number: 7 }, revertTse: { signed: { ...TSE_SIGNED, clientId: 'ZOLLIFY-2', transactionNumber: 3 } } }),
        op(10, 'tx.create', sale('tx-tse-fail', TSE_FAIL_TOKEN, { currency: 'EUR', tse: { failed: { reason: 'Swissbit on secret-device-id unplugged', at: 1 } } })),
        op(8, 'tx.create', sale('tx-exempt', EXEMPT_TOKEN, { currency: 'EUR', tax: { country: 'NL', exempt: true, rates: [null, null], note: 'VAT exempt under the EU SME scheme', exNumber: 'DE123456789EX' } })),
      ],
    },
  });
  expect(push.statusCode).toBe(200);
});

afterAll(async () => {
  try {
    app.zollify?.db?.close();
  } catch {
    /* already closed */
  }
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => resetReceiptAbuseState());

describe('online receipts', () => {
  it('serves a data-free page that keeps itself out of search engines', async () => {
    const res = await app.inject({ method: 'GET', url: '/p/pos/r' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Harbour');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('returns the receipt, and nothing but the receipt', async () => {
    const res = await lookup(TOKEN);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      seller: { name: 'Harbour Prints', address: ['Hafenweg 1', '8000 Zürich'], vatId: 'CHE-123.456.789' },
      event: 'Fantasy Basel',
      number: '1234ABCD',
      currency: 'CHF',
      total: 45,
      status: 'paid',
      payments: [{ label: 'Card · VISA', amount: 45 }],
      lines: [
        { title: 'Harbour print', qty: 2, amount: 40 },
        { title: 'Sticker', qty: 1, amount: 5 },
      ],
    });
    for (const secret of ['secret-device-id', 'PROC-REF-123', 'AUTH999', 'mypos', 'p-1', 'ev-1', 'tx-0000', TOKEN, '+41', 'home@example', 'EORI', accountId]) {
      expect(res.body).not.toContain(secret);
    }
  });

  it('marks a reverted sale as cancelled', async () => {
    expect((await lookup(VOID_TOKEN)).json().status).toBe('voided');
  });

  it('shows a converted sale in the currency the customer paid, adding up exactly', async () => {
    const body = (await lookup(FX_TOKEN)).json();
    expect(body.currency).toBe('EUR');
    expect(body.lines.reduce((s: number, l: { amount: number }) => s + l.amount * 100, 0)).toBe(4700);
    expect(body.payments).toEqual([{ label: 'Cash', amount: 47 }]);
  });

  it('lists a discounted sale at list price with the discount named, adding up to the total', async () => {
    const body = (await lookup(DISC_TOKEN)).json();
    expect(body.lines).toEqual([{ title: 'Harbour print', qty: 2, amount: 40 }]);
    expect(body.discounts).toEqual([{ name: 'Bundle deal', amount: 4 }]);
    expect(body.total).toBe(36);
  });

  it('shows the VAT in each rate, with the lines lettered by rate', async () => {
    const body = (await lookup(VAT_TOKEN)).json();
    expect(body.lines.map((l: { vat?: string }) => l.vat)).toEqual(['A', 'B']);
    expect(body.vat.rows).toEqual([
      { letter: 'A', rate: '19%', net: 33.61, vat: 6.39 },
      { letter: 'B', rate: '7%', net: 4.67, vat: 0.33 },
    ]);
    expect(body.seller.vatId).toBe('CHE-123.456.789');
  });

  it('shows an exempt sale’s note and EX number, and no VAT number', async () => {
    const body = (await lookup(EXEMPT_TOKEN)).json();
    expect(body.vat).toEqual({ rows: [], exemptNote: 'VAT exempt under the EU SME scheme', exNumber: 'DE123456789EX' });
    expect(body.seller.vatId).toBeUndefined();
  });

  it('shows the TSE signature a German receipt carries', async () => {
    const body = (await lookup(TSE_TOKEN)).json();
    expect(body.tse).toEqual({ transactionNumber: 13, signatureCounter: 44131, start: '2026-10-03T12:00:01.000Z', finish: '2026-10-03T12:00:09.000Z', clientId: 'ZOLLIFY-1', serial: 'ab'.repeat(32), signature: 'SIGNATURE' });
  });

  it('gives the till’s receipt number, and the cancellation’s own number and signature', async () => {
    const body = (await lookup(TSE_TOKEN)).json();
    expect(body.number).toBe('42');
    expect(body.till).toBe('ZOLLIFY-1');
    expect(body.status).toBe('voided');
    expect(body.cancelledBy).toEqual({ number: '7', till: 'ZOLLIFY-2' });
    expect(body.revertTse).toMatchObject({ transactionNumber: 3, clientId: 'ZOLLIFY-2' });
  });

  it('keeps the short reference for a sale from before receipt numbers', async () => {
    const body = (await lookup(VOID_TOKEN)).json();
    expect(body.number).toBe('TX-VOID');
    expect(body.till).toBeUndefined();
    expect(body.cancelledBy).toBeUndefined();
  });

  it('exports the till records as DSFinV-K for owners, summary first, then the ZIP', async () => {
    const url = '/api/m/pos/dsfinvk?from=2026-10-01&to=2026-10-31&all=1';
    const summary = (await app.inject({ method: 'GET', url, headers: auth() })).json();
    expect(summary).toMatchObject({ closings: 1, receipts: 1 });
    // The cancellation was numbered on another till, which has not closed yet.
    expect(summary.warnings.some((w: string) => w.startsWith('Till ZOLLIFY-2: 1 receipt(s) not closed yet'))).toBe(true);
    const zip = await app.inject({ method: 'GET', url: `${url}&download=1`, headers: auth() });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    const files = unzipSync(new Uint8Array(zip.rawPayload));
    expect(Object.keys(files)).toHaveLength(22);
    const heads = strFromU8(files['transactions.csv']!).split('\r\n');
    expect(heads[1]).toMatch(/^ZOLLIFY-1;2026-10-03T20:00:00Z;1;42;42;Beleg;;;0;/);
    // Germany only by default: this event has no country.
    expect((await app.inject({ method: 'GET', url: url.replace('&all=1', ''), headers: auth() })).json()).toMatchObject({ closings: 0 });
    expect((await app.inject({ method: 'GET', url: '/api/m/pos/dsfinvk?from=2026-10-31&to=2026-10-01', headers: auth() })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('says a sale was not signed, without the reason (which can name the device)', async () => {
    const res = await lookup(TSE_FAIL_TOKEN);
    expect(res.json().tse).toEqual({ failed: true });
    expect(res.body).not.toContain('secret-device-id');
  });

  it('refuses a lookup without a solved challenge', async () => {
    const res = await app.inject({ method: 'POST', url: '/p/pos/r/lookup', payload: { token: TOKEN } });
    expect(res.statusCode).toBe(403);
    const wrong = await solved();
    expect((await lookup(TOKEN, { ...wrong, captchaSolution: 'nope' })).statusCode).toBe(403);
  });

  it('spends each challenge once', async () => {
    const pow = await solved();
    expect((await lookup(TOKEN, pow)).statusCode).toBe(200);
    expect((await lookup(TOKEN, pow)).statusCode).toBe(403);
  });

  it('will not take a registration challenge, nor give one', async () => {
    const register = await solved('/api/captcha/challenge');
    expect((await lookup(TOKEN, register)).statusCode).toBe(403);

    // The cheap receipt challenge must not open account creation either.
    const receipt = await solved();
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'bot@example.test', password: 'a long enough password', accountName: 'Bot', ...receipt },
    });
    expect(signup.statusCode).not.toBe(200);
    expect(signup.body).toMatch(/CAPTCHA/i);
  });

  it('answers unknown and malformed tokens alike, then shuts out an address that keeps guessing', async () => {
    expect((await lookup('ZZZZZZZZZZZZZZZZZZZZZZ')).statusCode).toBe(404);
    expect((await lookup('../../etc/passwd')).statusCode).toBe(404);
    for (let i = 0; i < 8; i++) await lookup(`Guess${String(i).padStart(17, 'x')}`);
    // Ten misses in: even a real receipt is refused from here for a while.
    // (No challenge to solve: the block is checked before the proof-of-work.)
    expect((await lookup(TOKEN, { captchaToken: 'x', captchaSolution: '0' })).statusCode).toBe(429);
    expect((await app.inject({ method: 'GET', url: '/p/pos/r/challenge' })).statusCode).toBe(429);
  });

  it('goes dark when the POS module is switched off', async () => {
    setEnabled(app.zollify.db, accountId, 'pos', false);
    expect((await lookup(TOKEN)).statusCode).toBe(404);
    setEnabled(app.zollify.db, accountId, 'pos', true);
  });

  it('carries the booth branding, once an admin has set it', async () => {
    const before = await lookup(TOKEN);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().brand).toEqual({ footer: [] });

    // 1x1 transparent PNG.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const put = await app.inject({ method: 'PUT', url: '/api/m/pos/branding', headers: auth(), payload: { logo: png, footer: 'Thanks for supporting indie art!\n@harbourprints' } });
    expect(put.statusCode).toBe(200);

    const brand = (await lookup(TOKEN)).json().brand;
    expect(brand.logo).toBe(`data:image/png;base64,${png}`);
    expect(brand.footer).toEqual(['Thanks for supporting indie art!', '@harbourprints']);

    const read = await app.inject({ method: 'GET', url: '/api/m/pos/branding', headers: auth() });
    expect(read.json()).toEqual({ logo: png, footer: 'Thanks for supporting indie art!\n@harbourprints' });
  });

  it('keeps anything but a modest PNG out of the branding', async () => {
    const svg = Buffer.from('<svg onload="alert(1)"/>').toString('base64');
    for (const logo of [svg, 'not base64!', Buffer.alloc(300 * 1024).toString('base64')]) {
      const res = await app.inject({ method: 'PUT', url: '/api/m/pos/branding', headers: auth(), payload: { logo } });
      expect(res.statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'PUT', url: '/api/m/pos/branding', payload: { footer: 'x' } })).statusCode).toBe(401);
  });

  it('finds the sale through the token index, not a table scan', () => {
    const plan = app.zollify.db
      .prepare(`EXPLAIN QUERY PLAN SELECT accountId FROM ops WHERE type = 'tx.create' AND json_extract(payload, '$.receiptToken') = ? LIMIT 1`)
      .all(TOKEN) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('idx_ops_receipt_token');
  });
});
