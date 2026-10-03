import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
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
const { receiptsServerModule, resetReceiptAbuseState } = await import('../modules/receipts');

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'correct horse battery staple';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const VOID_TOKEN = 'VoidVoidVoidVoidVoid00';
const FX_TOKEN = 'FxFxFxFxFxFxFxFxFxFx01';
const DISC_TOKEN = 'DiscDiscDiscDiscDisc02';

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
    serverModules: [receiptsServerModule],
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
