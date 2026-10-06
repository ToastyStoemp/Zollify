import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Webhook } from '@zollify/shared';
import { buildGateway } from '../app';
import { webhookTargetProblem } from '../webhooks';

/**
 * Webhooks post to someone else's server, so what matters: the right events
 * reach the right webhook in the right shape, nothing is announced twice,
 * a dead endpoint switches itself off, and the server never posts into its
 * own network unless the operator says so.
 */

const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let receiver: Server;
let base = '';
let received: { path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }[] = [];
let failWith = 0;

const auth = () => ({ authorization: `Bearer ${owner}` });
const settle = () => new Promise((r) => setTimeout(r, 150));
let n = 0;
const sale = (total: number, at = Date.now()) => ({
  opId: `op-hooks-${String(++n).padStart(10, '0')}`,
  deviceId: 'd',
  ts: n,
  type: 'tx.create',
  payload: { id: `t${n}`, eventId: 'e1', deviceId: 'd', timestamp: at, method: 'cash', payments: [{ kind: 'cash', amount: total }], items: [{ pid: 'p', vid: null, title: 'Fox print', qty: 1, unitPrice: total, lineTotal: total }], discounts: [], total, currency: 'CHF' },
});
const push = (ops: unknown[]) => app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(), payload: { deviceId: 'd', ops } });
async function hook(body: Record<string, unknown>): Promise<Webhook> {
  const res = await app.inject({ method: 'POST', url: '/api/webhooks', headers: auth(), payload: { timeZone: 'Europe/Zurich', ...body } });
  expect(res.statusCode).toBe(201);
  return res.json().webhook;
}

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') });
      res.statusCode = failWith || 204;
      res.end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  dataDir = mkdtempSync(join(tmpdir(), 'zollify-hooks-'));
  process.env.OWNER_EMAIL = 'owner@hooks.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.WEBHOOK_ALLOW_PRIVATE = '1';
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [],
    defaultModules: [],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@hooks.test', password: PASSWORD } })).json().accessToken;
  await push([{ opId: 'op-hooks-event-0000001', deviceId: 'd', ts: 0, type: 'event.upsert', payload: { id: 'e1', name: 'Zurich shop', venue: {}, currency: 'CHF', status: 'active', updatedAt: 1 } }]);
});

beforeEach(() => {
  received = [];
  failWith = 0;
});

afterAll(async () => {
  await app.close();
  receiver.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
  delete process.env.REQUIRE_CAPTCHA;
});

describe('webhooks', () => {
  it('posts each sale to a Discord webhook, once', async () => {
    const h = await hook({ name: 'Sales channel', url: `${base}/discord`, format: 'discord', events: ['sale'] });
    const s = sale(85);
    await push([s]);
    await push([s]); // a retried push: already known, not news
    await settle();
    expect(received).toHaveLength(1);
    const embed = (received[0]!.body.embeds as { title: string; description: string; fields: { name: string; value: string }[] }[])[0]!;
    expect(embed.title).toBe('Sale: CHF 85.00');
    expect(embed.description).toContain('1 × Fox print');
    expect(embed.fields).toContainEqual(expect.objectContaining({ name: 'At', value: 'Zurich shop' }));
    expect(received[0]!.body.allowed_mentions).toEqual({ parse: [] });
    // Old sales synced late are an import, not news.
    await push([sale(10, Date.now() - 3 * 86_400_000)]);
    await settle();
    expect(received).toHaveLength(1);
    await app.inject({ method: 'DELETE', url: `/api/webhooks/${h.id}`, headers: auth() });
  });

  it('signs JSON deliveries and hears notifications by category only', async () => {
    const h = await hook({ name: 'Ops', url: `${base}/json`, format: 'json', events: ['planner'] });
    app.zollify.webhooks.notification((await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth() })).json().user.accountId, { title: 'Setup confirmed', kind: 'planner' });
    app.zollify.webhooks.notification((await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth() })).json().user.accountId, { title: 'A fee', kind: 'fees' });
    await settle();
    expect(received.map((r) => r.body.title)).toEqual(['Setup confirmed']);
    const raw = JSON.stringify(received[0]!.body);
    expect(received[0]!.headers['x-zollify-signature']).toBe(`sha256=${createHmac('sha256', h.secret).update(raw).digest('hex')}`);
    expect(received[0]!.headers['x-zollify-event']).toBe('planner');
    await app.inject({ method: 'DELETE', url: `/api/webhooks/${h.id}`, headers: auth() });
  });

  it('sends the daily summary once its day has passed, starting the day after it was made', async () => {
    const h = await hook({ name: 'Daily', url: `${base}/slack`, format: 'slack', events: ['report.daily'] });
    await app.zollify.webhooks.sendDueReports(); // first look: remembers yesterday, sends nothing
    expect(received).toHaveLength(0);
    await push([sale(40), sale(60)]);
    await settle();
    received = [];
    await app.zollify.webhooks.sendDueReports(Date.now() + 86_400_000);
    expect(received).toHaveLength(1);
    expect(received[0]!.body.text).toMatch(/Yesterday: \d+ sales/);
    expect(received[0]!.body.text).toContain('Fox print');
    await app.zollify.webhooks.sendDueReports(Date.now() + 86_400_000);
    expect(received).toHaveLength(1);
    await app.inject({ method: 'DELETE', url: `/api/webhooks/${h.id}`, headers: auth() });
  });

  it('tests a webhook, and switches one off that keeps failing', async () => {
    const h = await hook({ name: 'Broken', url: `${base}/broken`, format: 'json', events: ['sale'] });
    failWith = 500;
    const res = await app.inject({ method: 'POST', url: `/api/webhooks/${h.id}/test`, headers: auth() });
    expect(res.json()).toMatchObject({ ok: false, status: 500 });
    for (let i = 0; i < 20; i++) await push([sale(1)]);
    await new Promise((r) => setTimeout(r, 1500));
    const after = (await app.inject({ method: 'GET', url: '/api/webhooks', headers: auth() })).json().webhooks.find((w: Webhook) => w.id === h.id);
    expect(after.enabled).toBe(false);
    const bell = (await app.inject({ method: 'GET', url: '/api/notifications', headers: auth() })).json().notifications;
    expect(bell[0].title).toBe('Webhook "Broken" switched off');
  });

  it('is for owners and admins, and checks what it is given', async () => {
    const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(), payload: { role: 'member' } });
    const staffRes = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'staff@hooks.test', password: PASSWORD, inviteCode: invite.json().code } });
    const staff = staffRes.json().accessToken as string;
    expect((await app.inject({ method: 'GET', url: '/api/webhooks', headers: { authorization: `Bearer ${staff}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/webhooks', headers: auth(), payload: { name: 'x', url: `${base}/x`, format: 'json', events: [] } })).statusCode).toBe(400);
  });
});

describe('where webhooks may point', () => {
  it('refuses private networks and plain http unless allowed', async () => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    expect(await webhookTargetProblem('http://example.com/hook')).toMatch(/https/);
    expect(await webhookTargetProblem('https://127.0.0.1/hook')).toMatch(/private/);
    expect(await webhookTargetProblem('https://10.1.2.3/hook')).toMatch(/private/);
    expect(await webhookTargetProblem('https://[::1]/hook')).toMatch(/private/);
    expect(await webhookTargetProblem('https://user:pw@8.8.8.8/hook')).toMatch(/password/);
    expect(await webhookTargetProblem('https://8.8.8.8/hook')).toBeNull();
    process.env.WEBHOOK_ALLOW_PRIVATE = '1';
  });
});
