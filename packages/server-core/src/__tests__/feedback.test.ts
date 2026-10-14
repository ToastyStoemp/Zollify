import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGateway } from '../app';

/**
 * Feedback: anyone signed in can send it, only the server owner reads it,
 * and what goes to Discord carries no name, email or account - and cannot
 * ping anyone.
 */

const PASSWORD = 'correct horse battery staple';
const HOOK = 'https://discord.com/api/webhooks/123/abc-DEF';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let staff: string;
const posted: { url: string; body: string }[] = [];
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-feedback-'));
  Object.assign(process.env, { OWNER_EMAIL: 'owner@feedback.test', OWNER_PASSWORD: PASSWORD, REQUIRE_CAPTCHA: '0', FEEDBACK_DISCORD_WEBHOOK: HOOK, DISCORD_INVITE_URL: 'https://discord.gg/zollify' });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) !== HOOK) return real(input, init);
    posted.push({ url: String(input), body: String(init?.body ?? '') });
    return new Response(null, { status: 204 });
  });
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
  owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@feedback.test', password: PASSWORD } })).json().accessToken;
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'member' } });
  staff = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'sam@feedback.test', password: PASSWORD, inviteCode: invite.json().code } })).json().accessToken;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  for (const k of ['REQUIRE_CAPTCHA', 'FEEDBACK_DISCORD_WEBHOOK', 'DISCORD_INVITE_URL']) delete process.env[k];
});

describe('feedback', () => {
  it('takes a bug report from anyone signed in, and refuses the signed out and the empty', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/feedback', payload: { kind: 'bug', message: 'Till froze' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/feedback', headers: auth(staff), payload: { kind: 'bug', message: ' ' } })).statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: '/api/feedback', headers: auth(staff), payload: { kind: 'bug', message: 'Till froze after a split payment @everyone', page: '/m/pos', appVersion: '1.4.0' } });
    expect(res.statusCode).toBe(201);
  });

  it('posts to Discord without the person or account, and with mentions off', async () => {
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    const msg = JSON.parse(posted[0]!.body);
    expect(msg.allowed_mentions).toEqual({ parse: [] });
    expect(msg.embeds[0]).toMatchObject({ title: 'Bug report', description: expect.stringContaining('split payment') });
    expect(posted[0]!.body).not.toContain('sam@feedback.test');
    expect(posted[0]!.body).not.toContain('owner@feedback.test');
  });

  it('lists feedback for the server owner only, with who sent it', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/feedback', headers: auth(staff) })).statusCode).toBe(403);
    const list = (await app.inject({ method: 'GET', url: '/api/admin/feedback', headers: auth(owner) })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'bug', email: 'sam@feedback.test', page: '/m/pos', appVersion: '1.4.0' });
  });

  it('hands out the Discord invite to anyone, and only a real Discord link', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/support' })).json()).toEqual({ discordUrl: 'https://discord.gg/zollify' });
    process.env.DISCORD_INVITE_URL = 'https://evil.example/discord.gg/x';
    expect((await app.inject({ method: 'GET', url: '/api/support' })).json()).toEqual({ discordUrl: null });
  });
});
