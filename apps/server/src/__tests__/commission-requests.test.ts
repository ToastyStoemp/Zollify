import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, type MailMessage } from '@zollify/server-core';
import { commissionsServerModule } from '../modules/commissions';
import { setPushSender, type PushTarget } from '../modules/commissions-customer';

/**
 * What the customer brings: a request from the public page, the brief and
 * pictures on their tracking page, and browser notifications. Strangers
 * reach all of it, so the tests pin the gates (the page's own token, the
 * commission's token, the proof-of-work, the push services only), that the
 * owner sees what came in, and that erasure takes the customer's words,
 * pictures and devices with it.
 */

process.env.SIGNUP_CAPTCHA_BITS = '10';
const PASSWORD = 'correct horse battery staple';
const sent: MailMessage[] = [];
const pushed: { target: PushTarget; payload: Record<string, string> }[] = [];
let pushStatus = 201;
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let staff: string;
let requestPath = '';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (t: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/commissions${url}`, headers: auth(t), ...(payload ? { payload } : {}) });
// Each from its own address: the routes are rate limited per address, and these tests are not about that.
let ip = 0;
const pub = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, remoteAddress: `10.9.${Math.floor(++ip / 250)}.${ip % 250}`, ...(payload ? { payload } : {}) });

function solve(nonce: string, difficulty: number): string {
  for (let i = 0; ; i++) {
    const h = createHash('sha256').update(`${nonce}:${i}`).digest();
    let bits = 0;
    for (const b of h) {
      if (b === 0) { bits += 8; continue; }
      bits += Math.clz32(b) - 24;
      break;
    }
    if (bits >= difficulty) return String(i);
  }
}
async function request(body: Record<string, unknown>) {
  const ch = (await pub('GET', '/p/commissions/challenge')).json();
  return pub('POST', requestPath, { ...body, captchaToken: ch.token, captchaSolution: solve(ch.nonce, ch.difficulty) });
}

describe('rate limits', () => {
  it('a burst of requests from one address is stopped', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await app.inject({ method: 'POST', url: '/p/commissions/request/AAAAAAAAAAAAAAAAAAAAAAAA', remoteAddress: '10.99.0.1', payload: {} })).statusCode);
    expect(codes).toContain(429);
  });
});
// A real 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } };
const ASK = { name: 'Mira Keller', email: 'mira@example.test', title: 'Fox portrait', text: 'A3, charcoal, from my photo', budget: '150', wantedBy: '2099-02-01' };

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-commission-requests-'));
  process.env.OWNER_EMAIL = 'shop@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  setPushSender(async (target, payload) => {
    pushed.push({ target, payload: JSON.parse(payload) });
    if (pushStatus >= 400) throw Object.assign(new Error('gone'), { statusCode: pushStatus });
    return { statusCode: pushStatus };
  });
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [commissionsServerModule],
    defaultModules: ['commissions'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
    mailer: { enabled: true, send: async (m) => (sent.push(m), true) },
  });
  await app.ready();
  owner = (await pub('POST', '/api/auth/login', { email: 'shop@example.test', password: PASSWORD })).json().accessToken;
  await app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(owner), payload: { name: 'Ink & Charcoal' } });
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'member' } });
  staff = (await pub('POST', '/api/auth/register', { email: 'staff@example.test', password: PASSWORD, inviteCode: invite.json().code })).json().accessToken;
});

afterAll(async () => {
  setPushSender(null);
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
  delete process.env.SIGNUP_CAPTCHA_BITS;
});

describe('the request page', () => {
  it('has an address only an admin sees and can replace, and takes nothing until switched on', async () => {
    expect((await call(staff, 'GET', '/request-page')).statusCode).toBe(403);
    const page = (await call(owner, 'GET', '/request-page')).json();
    expect(page).toMatchObject({ open: false });
    expect(page.path).toMatch(/^\/p\/commissions\/request\/[A-Za-z0-9_-]{24}$/);
    requestPath = page.path;
    expect((await call(owner, 'GET', '/request-page')).json().path).toBe(requestPath);
    expect((await pub('GET', requestPath)).statusCode).toBe(200);
    expect((await pub('GET', `${requestPath}/data`)).json()).toMatchObject({ shop: 'Ink & Charcoal', open: false, maxPictures: 6 });
    expect((await request(ASK)).statusCode).toBe(409);
    // A new address retires the old one.
    const fresh = (await call(owner, 'POST', '/request-page/link')).json().path;
    expect(fresh).not.toBe(requestPath);
    expect((await pub('GET', requestPath)).statusCode).toBe(404);
    requestPath = fresh;
    const settings = (await call(owner, 'GET', '/settings')).json();
    await call(owner, 'PUT', '/settings', { ...settings, requestsOpen: true, requestIntro: 'Portraits from 80 €' });
    expect((await pub('GET', `${requestPath}/data`)).json()).toMatchObject({ open: true, intro: 'Portraits from 80 €' });
    expect((await pub('GET', '/p/commissions/request/nope')).statusCode).toBe(404);
  });

  it('needs the proof-of-work, refuses nonsense, and answers a bot with a quiet yes', async () => {
    expect((await pub('POST', requestPath, ASK)).statusCode).toBe(403);
    expect((await request({ ...ASK, email: 'not an email' })).statusCode).toBe(400);
    expect((await request({ ...ASK, text: '' })).statusCode).toBe(400);
    const before = (await call(owner, 'GET', '/commissions')).json().commissions.length;
    expect((await request({ ...ASK, website: 'http://spam' })).statusCode).toBe(200);
    expect((await call(owner, 'GET', '/commissions')).json().commissions.length).toBe(before);
  });

  it('lands as a Requested commission with the brief, for a new customer, and mails the link', async () => {
    sent.length = 0;
    const res = await request(ASK);
    expect(res.statusCode).toBe(201);
    const { trackingPath, emailed } = res.json();
    expect(trackingPath).toMatch(/^\/p\/commissions\/[A-Za-z0-9_-]{32}$/);
    expect(emailed).toBe(true);
    expect(sent[0]).toMatchObject({ to: 'mira@example.test', subject: 'Your request: Fox portrait', replyTo: 'shop@example.test' });
    expect(sent[0]!.text).toContain(trackingPath);
    const c = (await call(staff, 'GET', '/commissions')).json().commissions.find((x: { publicPath: string }) => x.publicPath === trackingPath);
    expect(c).toMatchObject({ status: 'requested', source: 'request', title: 'Fox portrait', customerName: 'Mira Keller', email: 'mira@example.test', price: 0, description: '' });
    expect(c.brief).toMatchObject({ text: 'A3, charcoal, from my photo', budget: '150', wantedBy: '2099-02-01' });
    expect(c.pictures).toEqual([]);
    // A second request from the same address is a second customer record, never someone else's.
    const again = (await request({ ...ASK, title: 'Cat' })).json();
    const both = (await call(staff, 'GET', '/commissions')).json().commissions.filter((x: { email: string }) => x.email === 'mira@example.test');
    expect(new Set(both.map((x: { customerId: string }) => x.customerId)).size).toBe(2);
    expect(again.trackingPath).not.toBe(trackingPath);
  });
});

describe('the brief and pictures on the tracking page', () => {
  let path = '';
  let id = '';

  beforeAll(async () => {
    const made = (await call(staff, 'POST', '/commissions', { customer: { name: 'Jo', email: 'jo@example.test' }, forceNewCustomer: true, title: 'Owl', price: 100 })).json();
    path = made.publicPath;
    id = made.id;
  });

  it('takes the customer\'s text and pictures, which the owner sees', async () => {
    expect((await pub('POST', `${path}/brief`, { text: 'Snowy owl, <i>at night</i>' })).json()).toEqual({ ok: true });
    const up = await pub('POST', `${path}/pictures`, { name: 'owl.png', data: PNG });
    expect(up.statusCode).toBe(201);
    const pid = up.json().picture.id;
    const view = (await call(staff, 'GET', `/commissions/${id}`)).json();
    expect(view.brief.text).toBe('Snowy owl, <i>at night</i>');
    expect(view.pictures).toMatchObject([{ id: pid, name: 'owl.png', mime: 'image/png' }]);
    const file = (await call(staff, 'GET', `/commissions/${id}/pictures/${pid}`)).json();
    expect(file.base64).toBe(PNG);
    // On the customer's own page: escaped, shown, served as an image that cannot run anything.
    const html = (await pub('GET', path)).body;
    expect(html).toContain('Snowy owl, &lt;i&gt;at night&lt;/i&gt;');
    const img = await pub('GET', `${path}/pictures/${pid}`);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.headers['content-security-policy']).toContain('sandbox');
  });

  it('refuses what is not a photo, past the limit, or without the right token', async () => {
    expect((await pub('POST', `${path}/pictures`, { name: 'x.html', data: Buffer.from('<script>alert(1)</script>').toString('base64') })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await pub('POST', `${path}/pictures`, { name: 'x.png', data: Buffer.from('not a png at all').toString('base64') })).statusCode).toBeGreaterThanOrEqual(400);
    for (let i = 0; i < 5; i++) expect((await pub('POST', `${path}/pictures`, { name: `r${i}.png`, data: PNG })).statusCode).toBe(201);
    expect((await pub('POST', `${path}/pictures`, { name: 'seventh.png', data: PNG })).statusCode).toBe(409);
    expect((await pub('POST', `/p/commissions/${'Z'.repeat(32)}/brief`, { text: 'x' })).statusCode).toBe(404);
    expect((await pub('POST', `/p/commissions/${'Z'.repeat(32)}/pictures`, { name: 'a.png', data: PNG })).statusCode).toBe(404);
    // The customer removes one; the owner can too.
    const pics = (await call(staff, 'GET', `/commissions/${id}`)).json().pictures as { id: string }[];
    expect((await pub('POST', `${path}/pictures/${pics[0]!.id}/remove`)).json()).toEqual({ ok: true });
    expect((await call(staff, 'DELETE', `/commissions/${id}/pictures/${pics[1]!.id}`)).json()).toEqual({ ok: true });
    expect((await call(staff, 'GET', `/commissions/${id}`)).json().pictures).toHaveLength(4);
  });

  it('is closed for changes once the commission is', async () => {
    await call(staff, 'POST', `/commissions/${id}/updates`, { status: 'cancelled' });
    expect((await pub('POST', `${path}/brief`, { text: 'more' })).statusCode).toBe(409);
    expect((await pub('POST', `${path}/pictures`, { name: 'a.png', data: PNG })).statusCode).toBe(409);
    const html = (await pub('GET', path)).body;
    expect(html).toContain('What you asked for');
    expect(html).not.toContain('id="brief"');
  });
});

describe('browser notifications', () => {
  let path = '';
  let id = '';

  beforeAll(async () => {
    const made = (await call(staff, 'POST', '/commissions', { customer: { name: 'Ana', email: 'ana@example.test' }, forceNewCustomer: true, title: 'Bear', price: 80 })).json();
    path = made.publicPath;
    id = made.id;
  });

  it('only takes the browsers\' own push services, a few devices at most', async () => {
    expect((await pub('GET', '/p/commissions/push-key')).json().publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://fcm.googleapis.com.evil.test/x', 'https://user@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x']) {
      expect((await pub('POST', `${path}/push`, { ...SUB, endpoint })).statusCode, endpoint).toBe(400);
    }
    expect((await pub('POST', `${path}/push`, SUB)).json()).toEqual({ ok: true });
    // The same device again is not a second one.
    expect((await pub('POST', `${path}/push`, SUB)).json()).toEqual({ ok: true });
    for (let i = 0; i < 4; i++) expect((await pub('POST', `${path}/push`, { ...SUB, endpoint: `https://updates.push.services.mozilla.com/wpush/v2/d${i}` })).statusCode).toBe(200);
    expect((await pub('POST', `${path}/push`, { ...SUB, endpoint: 'https://web.push.apple.com/one-too-many' })).statusCode).toBe(409);
    expect((await call(staff, 'GET', `/commissions/${id}`)).json().pushDevices).toBe(5);
    expect((await pub('POST', `${path}/push/remove`, { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/d3' })).json()).toEqual({ ok: true });
    expect((await call(staff, 'GET', `/commissions/${id}`)).json().pushDevices).toBe(4);
  });

  it('every step and message goes to the devices; a device the service forgot is dropped', async () => {
    pushed.length = 0;
    await call(staff, 'POST', `/commissions/${id}/updates`, { status: 'ready', message: 'Come by any time.' });
    await new Promise((r) => setTimeout(r, 50));
    expect(pushed).toHaveLength(4);
    expect(pushed[0]!.payload).toMatchObject({ title: 'Bear: Ready for pickup', body: 'Ink & Charcoal: Come by any time.', url: expect.stringContaining(path) });
    pushed.length = 0;
    pushStatus = 410;
    await call(staff, 'POST', `/commissions/${id}/updates`, { message: 'Still here.' });
    await new Promise((r) => setTimeout(r, 50));
    expect(pushed).toHaveLength(4);
    expect((await call(staff, 'GET', `/commissions/${id}`)).json().pushDevices).toBe(0);
    pushStatus = 201;
  });

  it('a closed commission forgets its devices after the last word', async () => {
    await pub('POST', `${path}/push`, SUB);
    pushed.length = 0;
    await call(staff, 'POST', `/commissions/${id}/updates`, { status: 'collected', message: 'Thanks!' });
    await new Promise((r) => setTimeout(r, 50));
    expect(pushed).toHaveLength(1);
    expect((await call(staff, 'GET', `/commissions/${id}`)).json().pushDevices).toBe(0);
    expect((await pub('POST', `${path}/push`, SUB)).statusCode).toBe(409);
  });
});

describe('made at the till with no email', () => {
  it('files a walk-in, and the customer leaves their own email on their page, once', async () => {
    const made = (await call(staff, 'POST', '/commissions', { customer: { name: 'Walk-in, 22 Oct', email: '' }, forceNewCustomer: true, title: 'Badge', price: 30, depositAsked: 10 })).json();
    let html = (await pub('GET', made.publicPath)).body;
    expect(html).toContain('id="email-form"');
    expect((await pub('POST', `${made.publicPath}/email`, { email: 'nope' })).statusCode).toBe(400);
    sent.length = 0;
    expect((await pub('POST', `${made.publicPath}/email`, { email: 'Sam@Example.test' })).json()).toEqual({ ok: true, emailed: true });
    expect(sent[0]).toMatchObject({ to: 'sam@example.test', subject: 'Updates on Badge', replyTo: 'shop@example.test' });
    expect((await call(staff, 'GET', `/commissions/${made.id}`)).json().email).toBe('sam@example.test');
    // The page never shows the address, and no longer offers the box.
    html = (await pub('GET', made.publicPath)).body;
    expect(html).not.toContain('id="email-form"');
    expect(html).not.toContain('sam@example.test');
    // Whoever holds the link cannot change it afterwards.
    expect((await pub('POST', `${made.publicPath}/email`, { email: 'other@example.test' })).statusCode).toBe(409);
    expect((await call(staff, 'GET', `/commissions/${made.id}`)).json().email).toBe('sam@example.test');
  });

  it('is not offered when the shop has an email, nor once closed', async () => {
    const withMail = (await call(staff, 'POST', '/commissions', { customer: { name: 'Kim', email: 'kim@example.test' }, forceNewCustomer: true, title: 'Mug' })).json();
    expect((await pub('GET', withMail.publicPath)).body).not.toContain('id="email-form"');
    const closed = (await call(staff, 'POST', '/commissions', { customer: { name: 'Walk-in', email: '' }, forceNewCustomer: true, title: 'Pin' })).json();
    await call(staff, 'POST', `/commissions/${closed.id}/updates`, { status: 'cancelled' });
    expect((await pub('GET', closed.publicPath)).body).not.toContain('id="email-form"');
    expect((await pub('POST', `${closed.publicPath}/email`, { email: 'x@example.test' })).statusCode).toBe(409);
  });
});

describe('erasure', () => {
  it('takes the customer\'s brief, pictures and devices with their details', async () => {
    const made = (await call(staff, 'POST', '/commissions', { customer: { name: 'Lee', email: 'lee@example.test' }, forceNewCustomer: true, title: 'Cat' })).json();
    await pub('POST', `${made.publicPath}/brief`, { text: 'Tabby, green eyes' });
    await pub('POST', `${made.publicPath}/pictures`, { name: 'cat.png', data: PNG });
    await pub('POST', `${made.publicPath}/push`, SUB);
    await call(staff, 'POST', `/commissions/${made.id}/updates`, { status: 'cancelled' });
    expect((await call(owner, 'POST', `/customers/${made.customerId}/erase`)).json()).toMatchObject({ ok: true, commissions: 1 });
    const after = (await call(staff, 'GET', `/commissions/${made.id}`)).json();
    expect(after.brief).toBeNull();
    expect(after.pictures).toEqual([]);
    expect(after.pushDevices).toBe(0);
    const html = (await pub('GET', made.publicPath)).body;
    expect(html).not.toContain('Tabby');
  });
});

describe('a server that cannot send email', () => {
  it('does not ask the customer for an address', async () => {
    const { renderCommission } = await import('../modules/commissions-page');
    const page = { shop: 'Ink', title: 'Fox', status: 'requested' as const, statusLabel: 'Requested', dueDate: '', timeZone: 'UTC', currency: 'EUR', price: 0, paid: 0, balance: 0, updates: [], pickup: null, brief: null, pictures: [], canAddBrief: true, hasEmail: false, push: true };
    expect(renderCommission({ ...page, mailEnabled: true }, 'C'.repeat(32))).toContain('id="email-form"');
    expect(renderCommission({ ...page, mailEnabled: false }, 'C'.repeat(32))).not.toContain('id="email-form"');
  });
});
