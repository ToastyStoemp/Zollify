import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled } from '@zollify/server-core';
import { publicEventsServerModule } from '../modules/public-events';

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
const VAT_TOKEN = 'VatVatVatVatVatVatVat3';
const EXEMPT_TOKEN = 'ExemptExemptExemptExe4';

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
    serverModules: [receiptsServerModule('test-secret-value-long-enough-for-signing'), publicEventsServerModule],
    defaultModules: ['pos', 'public-events'],
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
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64');
    for (const [logo, status] of [[svg, 415], [jpeg, 415], ['not base64!', 400]] as const) {
      const res = await app.inject({ method: 'PUT', url: '/api/m/pos/branding', headers: auth(), payload: { logo } });
      expect(res.statusCode).toBe(status);
      expect(res.json().message).toMatch(/\S/);
    }
    // Over the cap: the body limit refuses it before the route reads it.
    const big = await app.inject({ method: 'PUT', url: '/api/m/pos/branding', headers: auth(), payload: { logo: Buffer.alloc(300 * 1024).toString('base64') } });
    expect(big.statusCode).toBe(413);
    expect((await app.inject({ method: 'PUT', url: '/api/m/pos/branding', payload: { footer: 'x' } })).statusCode).toBe(401);
  });

  describe('footer links', () => {
    // The links are the business profile's; only the switches are saved through the module.
    const putLinks = (links: unknown) => app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(), payload: { links } as object });
    const putToggles = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/m/pos/receipt-links', headers: auth(), payload: payload as object });
    const day = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    it('adds nothing to the receipt until links are set', async () => {
      const r = (await lookup(TOKEN)).json();
      expect(r.links).toBeUndefined();
      expect(r.nextEvents).toBeUndefined();
    });

    it('serves clean links, bare handles made canonical, and leaves the sale untouched', async () => {
      const before = (await lookup(TOKEN)).json();
      const put = await putLinks({ webstore: ' https://shop.example.com/ ', instagram: '@harbourprints', tiktok: 'harbour.prints', otherUrl: 'https://news.example.com/signup', otherLabel: '<b>News</b>' });
      expect(put.statusCode, put.body).toBe(200);
      const after = (await lookup(TOKEN)).json();
      expect(after.links).toEqual([
        { label: 'Webstore', url: 'https://shop.example.com/' },
        { label: 'Instagram', url: 'https://www.instagram.com/harbourprints' },
        { label: 'TikTok', url: 'https://www.tiktok.com/@harbour.prints' },
        // Stored as typed: the page writes it with textContent, never as markup.
        { label: '<b>News</b>', url: 'https://news.example.com/signup' },
      ]);
      const { links: _links, ...rest } = after;
      expect(rest).toEqual(before);
    });

    it('refuses anything but a plain https link', async () => {
      for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'http://shop.example.com', 'ftp://x.example.com', 'https://user:pw@shop.example.com', 'https://localhost', 'https://a.example.com/ x', 'shop.example.com', `https://shop.example.com/${'a'.repeat(200)}`]) {
        const res = await putLinks({ webstore: bad });
        expect(res.statusCode, bad).toBe(400);
      }
      expect((await putLinks({ instagram: 'javascript:alert(1)' })).statusCode).toBe(400);
      expect((await putLinks({ otherUrl: 'https://x.example.com', otherLabel: 'x'.repeat(31) })).statusCode).toBe(400);
      // A refusal keeps what was saved.
      expect((await lookup(TOKEN)).json().links).toHaveLength(4);
    });

    it('needs a sign-in to change them, and prints nothing by default', async () => {
      expect((await app.inject({ method: 'PUT', url: '/api/m/pos/receipt-links', payload: { showOnPrint: true } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/m/pos/receipt-links', headers: auth() })).json().showOnPrint).toBe(false);
    });

    it('keeps the switches in Receipts and the links in the profile, whichever is saved last', async () => {
      const before = (await app.inject({ method: 'GET', url: '/api/m/pos/receipt-links', headers: auth() })).json();
      // Link fields sent to the receipt endpoint are ignored: the profile is the one place to edit them.
      const res = await putToggles({ showOnPrint: true, showEvents: false, webstore: 'https://elsewhere.example.com' });
      expect(res.json()).toMatchObject({ webstore: before.webstore, showOnPrint: true, showEvents: false });
      const profile = (await app.inject({ method: 'GET', url: '/api/account/profile', headers: auth() })).json();
      expect(profile.links.webstore).toBe('https://shop.example.com/');
      // Saving the profile again leaves the switches alone.
      await putLinks({ facebook: 'https://facebook.com/harbourprints' });
      expect((await app.inject({ method: 'GET', url: '/api/m/pos/receipt-links', headers: auth() })).json()).toMatchObject({ showOnPrint: true, facebook: 'https://facebook.com/harbourprints' });
      await putToggles({ showOnPrint: false, showEvents: false });
      await putLinks({ facebook: '' });
    });

    it('renders links as text and anchors that open safely', async () => {
      const js = (await app.inject({ method: 'GET', url: '/p/pos/r/receipt.js' })).body;
      expect(js).toContain("a.rel = 'noopener noreferrer'");
      expect(js).toContain("a.target = '_blank'");
      expect(js).toContain('find us online');
      expect(js).not.toMatch(/innerHTML/);
    });

    it('lists the next three public events only when switched on, published and enabled', async () => {
      const events = [
        { id: 'ev-n1', name: 'Next A', dateStart: day(10), dateEnd: day(11), venue: { city: 'Bern' } },
        { id: 'ev-n2', name: 'Next B', dateStart: day(20), dateEnd: day(20), venue: { city: 'Lyon' } },
        { id: 'ev-n3', name: 'Next C', dateStart: day(30), dateEnd: day(31), venue: { city: 'Graz' } },
        { id: 'ev-n4', name: 'Next D', dateStart: day(40), dateEnd: day(41), venue: { city: 'Wien' } },
        { id: 'ev-hid', name: 'Hidden one', dateStart: day(5), dateEnd: day(6), venue: { city: 'Secret' } },
        { id: 'ev-old', name: 'Past one', dateStart: day(-30), dateEnd: day(-29), venue: { city: 'Old' } },
      ].map((e, i) => ({ opId: `op-ev-${String(i).padStart(12, '0')}`, deviceId: 'dev-1', ts: 100 + i, type: 'event.upsert', payload: { ...e, currency: 'CHF', status: 'active', updatedAt: 1 } }));
      expect((await app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(), payload: { deviceId: 'dev-1', ops: events } })).statusCode).toBe(200);

      // Toggle off: nothing, even once the page is published.
      await app.inject({ method: 'PUT', url: '/api/m/public-events/config', headers: auth(), payload: { slug: 'harbour-prints' } });
      expect((await lookup(TOKEN)).json().nextEvents).toBeUndefined();

      expect((await putToggles({ showEvents: true })).statusCode).toBe(200);
      expect((await app.inject({ method: 'PUT', url: '/api/m/public-events/overlay/ev-hid', headers: auth(), payload: { hidden: true } })).statusCode).toBe(200);
      const on = (await lookup(TOKEN)).json();
      expect(on.nextEvents.map((e: { name: string }) => e.name)).toEqual(['Next A', 'Next B', 'Next C']);
      expect(Object.keys(on.nextEvents[0]).sort()).toEqual(['city', 'end', 'name', 'start']);
      expect(on.nextEvents[0]).toMatchObject({ city: 'Bern', start: day(10), end: day(11) });

      // Module off: gone.
      setEnabled(app.zollify.db, accountId, 'public-events', false);
      expect((await lookup(TOKEN)).json().nextEvents).toBeUndefined();
      setEnabled(app.zollify.db, accountId, 'public-events', true);

      // Page unpublished: gone, because the page itself would not show them.
      await app.inject({ method: 'PUT', url: '/api/m/public-events/config', headers: auth(), payload: { slug: null } });
      expect((await lookup(TOKEN)).json().nextEvents).toBeUndefined();
    });
  });

  describe('links kept by the first version', () => {
    const db = () => app.zollify.db;
    const profileOf = () => JSON.parse((db().prepare('SELECT profile FROM accounts WHERE id = ?').get(accountId) as { profile: string }).profile) as { links?: Record<string, string>; artist: { companyName: string } };
    const setLegacy = (socials: unknown) =>
      db().prepare('INSERT INTO pos_receipt_socials (accountId, socials, updatedAt) VALUES (?, ?, 1) ON CONFLICT(accountId) DO UPDATE SET socials = excluded.socials').run(accountId, JSON.stringify(socials));
    /** A profile that never had links, as one from before they moved. */
    const forgetLinks = () => {
      const { links: _links, ...rest } = profileOf();
      db().prepare('UPDATE accounts SET profile = ? WHERE id = ?').run(JSON.stringify(rest), accountId);
    };
    const legacy = { webstore: 'https://old.example.com/', instagram: 'https://www.instagram.com/oldbooth', showOnPrint: true, showEvents: false };

    it('is shown as a fallback while the profile has never had links', async () => {
      forgetLinks();
      setLegacy(legacy);
      const r = (await lookup(TOKEN)).json();
      expect(r.links).toEqual([
        { label: 'Webstore', url: 'https://old.example.com/' },
        { label: 'Instagram', url: 'https://www.instagram.com/oldbooth' },
      ]);
      expect((await app.inject({ method: 'GET', url: '/api/m/pos/receipt-links', headers: auth() })).json()).toMatchObject({ webstore: 'https://old.example.com/', showOnPrint: true });
      // Reading changes nothing.
      expect(profileOf().links).toBeUndefined();
    });

    it('is copied into a profile that has none, and the table stays readable', async () => {
      const { migrateReceiptSocials } = await import('../modules/receipts');
      expect(migrateReceiptSocials(db())).toBe(1);
      expect(profileOf().links).toMatchObject({ webstore: 'https://old.example.com/', instagram: 'https://www.instagram.com/oldbooth' });
      // Nothing else in the profile moved.
      expect(profileOf().artist.companyName).toBe('Harbour Prints');
      expect((db().prepare('SELECT socials FROM pos_receipt_socials WHERE accountId = ?').get(accountId) as { socials: string }).socials).toContain('old.example.com');
      // Running it again is a no-op.
      expect(migrateReceiptSocials(db())).toBe(0);
    });

    it('never overwrites what the profile has, and clearing links on purpose is not undone by the old copy', async () => {
      const { migrateReceiptSocials } = await import('../modules/receipts');
      await app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(), payload: { links: { webstore: 'https://new.example.com' } } });
      setLegacy({ ...legacy, webstore: 'https://stale.example.com/' });
      expect(migrateReceiptSocials(db())).toBe(0);
      expect(profileOf().links?.webstore).toBe('https://new.example.com/');

      await app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(), payload: { links: { webstore: '', instagram: '' } } });
      expect(migrateReceiptSocials(db())).toBe(0);
      expect((await lookup(TOKEN)).json().links).toBeUndefined();
    });

    it('skips a stored row that no longer passes the checks', async () => {
      const { migrateReceiptSocials } = await import('../modules/receipts');
      forgetLinks();
      setLegacy({ webstore: 'javascript:alert(1)' });
      expect(migrateReceiptSocials(db())).toBe(0);
      expect((await lookup(TOKEN)).json().links).toBeUndefined();
      setLegacy('not an object');
      expect(migrateReceiptSocials(db())).toBe(0);
      setLegacy({ showOnPrint: false, showEvents: false });
    });
  });

  it('finds the sale through the token index, not a table scan', () => {
    const plan = app.zollify.db
      .prepare(`EXPLAIN QUERY PLAN SELECT accountId FROM ops WHERE type = 'tx.create' AND json_extract(payload, '$.receiptToken') = ? LIMIT 1`)
      .all(TOKEN) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('idx_ops_receipt_token');
  });
});
