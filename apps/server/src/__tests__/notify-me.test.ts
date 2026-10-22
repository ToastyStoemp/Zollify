import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, type MailMessage } from '@zollify/server-core';
import { notifyMeServerModule, sweep } from '../modules/notify-me';

/**
 * Notify me writes to people who are not customers of record, so the tests
 * pin the consent path: nothing is sent before the address is confirmed,
 * every mail carries a leave link that works, a restock reaches only those
 * who asked and only once per cooldown, an event reaches those for its
 * country, and the sweep erases what is no longer wanted.
 */

process.env.SIGNUP_CAPTCHA_BITS = '10';
const PASSWORD = 'correct horse battery staple';
const sent: MailMessage[] = [];
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let seq = 0;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/notify-me${url}`, headers: auth(owner), ...(payload ? { payload } : {}) });
const push = (type: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(owner), payload: { deviceId: 'till', ops: [{ opId: `op-notify-${String(++seq).padStart(8, '0')}`, deviceId: 'till', ts: seq, type, payload }] } });

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
async function subscribe(body: Record<string, unknown>, slug = 'ink') {
  const ch = (await app.inject({ method: 'GET', url: '/p/notify-me/challenge' })).json();
  return app.inject({ method: 'POST', url: `/p/notify-me/${slug}/subscribe`, payload: { ...body, captchaToken: ch.token, captchaSolution: solve(ch.nonce, ch.difficulty) } });
}
const tokenIn = (text: string, action: 'confirm' | 'leave'): string => new RegExp(`/p/notify-me/${action}#([A-Za-z0-9_-]{32})`).exec(text)?.[1] ?? '';
const lastTo = (email: string): MailMessage => [...sent].reverse().find((m) => m.to === email)!;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-notify-'));
  process.env.OWNER_EMAIL = 'shop@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [notifyMeServerModule],
    defaultModules: ['notify-me'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
    mailer: { enabled: true, send: async (m) => (sent.push(m), true) },
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shop@example.test', password: PASSWORD } });
  owner = login.json().accessToken;
  await app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(owner), payload: { name: 'Ink & Charcoal' } });
  await push('product.upsert', { id: 'pin', title: 'Fox pin', price: 10, variants: [], updatedAt: 1 });
  await push('inventory.set', { productId: 'pin', variantId: '', onHand: 0, updatedAt: 1 });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
  delete process.env.SIGNUP_CAPTCHA_BITS;
});

describe('the page', () => {
  it('is off until an admin gives it an address, then serves itself and its data', async () => {
    expect((await app.inject({ method: 'GET', url: '/p/notify-me/ink' })).statusCode).toBe(404);
    const saved = await call('PUT', '/settings', { slug: 'ink', intro: 'Pins and prints', storeUrl: 'https://shop.example.test' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().publicUrl).toMatch(/\/p\/notify-me\/ink$/);
    expect((await call('PUT', '/settings', { slug: 'Ink' })).statusCode).toBe(400);
    const page = await app.inject({ method: 'GET', url: '/p/notify-me/ink' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: '/p/notify-me/ink/i/pin' })).statusCode).toBe(200);
    const data = (await app.inject({ method: 'GET', url: '/p/notify-me/ink/data?product=pin' })).json();
    expect(data).toMatchObject({ name: 'Ink & Charcoal', intro: 'Pins and prints', product: { id: 'pin', title: 'Fox pin' }, mailEnabled: true });
    expect(data.kinds.map((k: { id: string }) => k.id)).toEqual(['restock', 'events', 'news']);
    expect((await app.inject({ method: 'GET', url: '/p/notify-me/notify.js' })).body).toContain('function solve(');
  });
});

describe('consent', () => {
  it('sends nothing but the confirm mail until the link is clicked, and a bot gets a quiet yes', async () => {
    expect((await app.inject({ method: 'POST', url: '/p/notify-me/ink/subscribe', payload: { email: 'mira@example.test', kinds: ['restock'] } })).statusCode).toBe(403);
    sent.length = 0;
    const bot = await subscribe({ email: 'bot@example.test', kinds: ['news'], website: 'http://spam' });
    expect(bot.json()).toEqual({ status: 'sent' });
    expect(sent).toEqual([]);
    expect((await subscribe({ email: 'not an email', kinds: ['news'] })).statusCode).toBe(400);

    const res = await subscribe({ email: 'Mira@Example.test', kinds: ['restock', 'events'], productId: 'pin', country: 'de' });
    expect(res.json()).toEqual({ status: 'sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'mira@example.test', subject: 'Confirm: hear from Ink & Charcoal', replyTo: 'shop@example.test' });
    const token = tokenIn(sent[0]!.text, 'confirm');
    expect(token).toHaveLength(32);
    // Not confirmed: a restock says nothing to her.
    await push('inventory.set', { productId: 'pin', variantId: '', onHand: 5, updatedAt: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
    const list = (await call('GET', '/subscribers')).json().subscribers;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ email: 'mira@example.test', confirmedAt: null, country: 'DE', products: ['Fox pin'] });

    expect((await app.inject({ method: 'POST', url: '/p/notify-me/confirm', payload: { token: 'A'.repeat(32) } })).statusCode).toBe(404);
    const ok = await app.inject({ method: 'POST', url: '/p/notify-me/confirm', payload: { token } });
    expect(ok.json()).toMatchObject({ status: 'confirmed', shop: 'Ink & Charcoal' });
    expect((await call('GET', '/settings')).json().counts).toMatchObject({ live: 1, unconfirmed: 0, byKind: { restock: 1, events: 1, news: 0 } });
  });

  it('a second sign-up with the same address widens it without a second confirmation', async () => {
    sent.length = 0;
    const res = await subscribe({ email: 'mira@example.test', kinds: ['news'] });
    expect(res.json()).toEqual({ status: 'updated' });
    expect(sent[0]?.subject).toBe('Updated: what you hear from Ink & Charcoal');
    expect(sent[0]?.text).toContain('/p/notify-me/leave#');
    expect((await call('GET', '/subscribers')).json().subscribers[0].kinds).toEqual(['restock', 'events', 'news']);
  });
});

describe('what goes out', () => {
  it('a restock reaches those who asked for the item, once per cooldown, with a leave link', async () => {
    sent.length = 0;
    // Sold out again, then counted back in.
    await push('inventory.set', { productId: 'pin', variantId: '', onHand: 0, updatedAt: 3 });
    await push('inventory.set', { productId: 'pin', variantId: '', onHand: 8, updatedAt: 4 });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'mira@example.test', subject: 'Fox pin is back in stock' });
    expect(sent[0]!.text).toContain('https://shop.example.test');
    expect(tokenIn(sent[0]!.text, 'leave')).toHaveLength(32);
    // Again within the cooldown: silence. Another item: not hers.
    await push('inventory.set', { productId: 'pin', variantId: '', onHand: 0, updatedAt: 5 });
    await push('inventory.set', { productId: 'pin', variantId: '', onHand: 3, updatedAt: 6 });
    await push('product.upsert', { id: 'print', title: 'Print', price: 20, variants: [], updatedAt: 1 });
    await push('inventory.set', { productId: 'print', variantId: '', onHand: 0, updatedAt: 1 });
    await push('inventory.set', { productId: 'print', variantId: '', onHand: 4, updatedAt: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
  });

  it('an event with dates ahead reaches those for its country or anywhere, once', async () => {
    sent.length = 0;
    const r = await subscribe({ email: 'dk@example.test', kinds: ['events'], country: 'DK' });
    expect(r.json().status).toBe('sent');
    await app.inject({ method: 'POST', url: '/p/notify-me/confirm', payload: { token: tokenIn(lastTo('dk@example.test').text, 'confirm') } });
    sent.length = 0;
    await push('event.upsert', { id: 'con', name: 'FurCon', venue: { city: 'Berlin', country: 'DE' }, currency: 'EUR', status: 'planned', dateStart: '2099-05-01', dateEnd: '2099-05-03', booth: { hall: 'A', number: '12' }, updatedAt: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.map((m) => m.to)).toEqual(['mira@example.test']);
    expect(sent[0]!.subject).toBe('Next event: FurCon');
    expect(sent[0]!.text).toContain('Berlin, DE');
    expect(sent[0]!.text).toContain('Find us: A, 12');
    // Edited again: not announced twice. A past or undated event: never.
    await push('event.upsert', { id: 'con', name: 'FurCon!', venue: { country: 'DE' }, currency: 'EUR', status: 'planned', dateStart: '2099-05-01', dateEnd: '2099-05-03', updatedAt: 2 });
    await push('event.upsert', { id: 'old', name: 'Old', venue: { country: 'DE' }, currency: 'EUR', status: 'closed', dateStart: '2000-01-01', updatedAt: 1 });
    await push('event.upsert', { id: 'draft', name: 'Draft', venue: {}, currency: 'EUR', status: 'planned', updatedAt: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
  });

  it('news goes to those who asked for it, and is kept', async () => {
    sent.length = 0;
    expect((await call('POST', '/news', { subject: '', text: 'x' })).statusCode).toBe(400);
    const res = await call('POST', '/news', { subject: 'New prints', text: 'Three new prints in the shop.' });
    expect(res.statusCode).toBe(201);
    expect(res.json().news).toMatchObject({ subject: 'New prints', recipients: 1, sent: 1 });
    expect(sent.map((m) => m.to)).toEqual(['mira@example.test']);
    expect(sent[0]!.text).toContain('Three new prints');
    expect((await call('GET', '/news')).json().news).toHaveLength(1);
  });

  it('the leave link in the newest mail works, and then nothing more comes', async () => {
    const token = tokenIn(lastTo('mira@example.test').text, 'leave');
    const left = await app.inject({ method: 'POST', url: '/p/notify-me/leave', payload: { token } });
    expect(left.json()).toMatchObject({ status: 'left' });
    sent.length = 0;
    await call('POST', '/news', { subject: 'More', text: 'More.' });
    expect(sent).toEqual([]);
    expect((await call('GET', '/settings')).json().counts.live).toBe(1);
  });
});

describe('erasure', () => {
  it('the sweep erases the unconfirmed after a week and the gone after a month; an admin can erase anyone now', async () => {
    await subscribe({ email: 'never@example.test', kinds: ['news'] });
    const before = (await call('GET', '/subscribers')).json().subscribers as { id: string; email: string }[];
    expect(before.map((s) => s.email).sort()).toEqual(['dk@example.test', 'mira@example.test', 'never@example.test']);
    const db = (app as unknown as { db: import('better-sqlite3').Database }).db;
    expect(sweep(db, Date.now() + 8 * 86_400_000)).toBe(1);
    expect(sweep(db, Date.now() + 31 * 86_400_000)).toBe(1);
    const after = (await call('GET', '/subscribers')).json().subscribers as { id: string; email: string }[];
    expect(after.map((s) => s.email)).toEqual(['dk@example.test']);
    expect((await call('DELETE', `/subscribers/${after[0]!.id}`)).json()).toEqual({ ok: true });
    expect((await call('GET', '/subscribers')).json().subscribers).toEqual([]);
  });
});
