import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../app';

/**
 * Server settings from Server admin: only the server owner, applied at once,
 * secrets never sent back, the real environment always wins, and a saved
 * value is still there after a restart.
 */

const PASSWORD = 'correct horse battery staple';
const SECRET = 'test-secret-value-long-enough-for-signing';
const HOOK = 'https://discord.com/api/webhooks/123/abc-DEF';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let staff: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const build = () =>
  buildGateway({ dataDir, moduleStoreDir: join(dataDir, 'modules'), jwtSecret: SECRET, serverModules: [], defaultModules: [], allowedOrigins: [], requireHttps: false, trustProxy: false, logLevel: 'silent' });
const put = (t: string, body: unknown) => app.inject({ method: 'PUT', url: '/api/admin/settings', headers: auth(t), payload: body as Record<string, unknown> });
const list = async () => (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: auth(owner) })).json().settings as { key: string; source: string; value: string | null; editable: boolean }[];
const one = async (key: string) => (await list()).find((s) => s.key === key)!;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-settings-'));
  for (const k of ['DISCORD_INVITE_URL', 'FEEDBACK_DISCORD_WEBHOOK', 'GOOGLE_CLIENT_ID']) delete process.env[k];
  // Set by the deployment: the panel must leave it alone.
  Object.assign(process.env, { OWNER_EMAIL: 'owner@settings.test', OWNER_PASSWORD: PASSWORD, REQUIRE_CAPTCHA: '0', POYNT_REGION: 'us' });
  app = await build();
  await app.ready();
  owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@settings.test', password: PASSWORD } })).json().accessToken;
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'member' } });
  staff = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'sam@settings.test', password: PASSWORD, inviteCode: invite.json().code } })).json().accessToken;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  for (const k of ['REQUIRE_CAPTCHA', 'POYNT_REGION', 'DISCORD_INVITE_URL', 'FEEDBACK_DISCORD_WEBHOOK']) delete process.env[k];
});

describe('server settings', () => {
  it('belong to the server owner only', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/settings', headers: auth(staff) })).statusCode).toBe(403);
    expect((await put(staff, { set: { DISCORD_INVITE_URL: 'https://discord.gg/x' } })).statusCode).toBe(403);
  });

  it('take effect at once', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/support' })).json().discordUrl).toBeNull();
    expect((await put(owner, { set: { DISCORD_INVITE_URL: 'https://discord.gg/zollify' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/support' })).json().discordUrl).toBe('https://discord.gg/zollify');
    expect(await one('DISCORD_INVITE_URL')).toMatchObject({ source: 'panel', value: 'https://discord.gg/zollify' });
  });

  it('never send a secret back, and keep it when its field comes back empty', async () => {
    await put(owner, { set: { FEEDBACK_DISCORD_WEBHOOK: HOOK } });
    const listed = JSON.stringify(await list());
    expect(listed).not.toContain('abc-DEF');
    expect(await one('FEEDBACK_DISCORD_WEBHOOK')).toMatchObject({ source: 'panel', value: null });
    await put(owner, { set: { FEEDBACK_DISCORD_WEBHOOK: '' } });
    expect(process.env.FEEDBACK_DISCORD_WEBHOOK).toBe(HOOK);
  });

  it('refuse a bad value, a deployment-only setting, and one the environment sets', async () => {
    const bad = await put(owner, { set: { DISCORD_INVITE_URL: 'https://evil.example/discord.gg/x' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().problems.DISCORD_INVITE_URL).toMatch(/discord/);
    expect((await put(owner, { set: { ZOLLIFY_DATA_DIR: '/tmp/elsewhere' } })).statusCode).toBe(400);
    const locked = await put(owner, { set: { POYNT_REGION: 'eu' } });
    expect(locked.json().problems.POYNT_REGION).toMatch(/environment/);
    expect(process.env.POYNT_REGION).toBe('us');
    expect(await one('POYNT_REGION')).toMatchObject({ source: 'environment', editable: false });
  });

  it('are still there after a restart, and can be cleared', async () => {
    await app.close();
    delete process.env.DISCORD_INVITE_URL;
    delete process.env.FEEDBACK_DISCORD_WEBHOOK;
    app = await build();
    await app.ready();
    expect(process.env.DISCORD_INVITE_URL).toBe('https://discord.gg/zollify');
    expect(process.env.FEEDBACK_DISCORD_WEBHOOK).toBe(HOOK);
    await put(owner, { clear: ['DISCORD_INVITE_URL'] });
    expect(process.env.DISCORD_INVITE_URL).toBeUndefined();
    expect((await one('DISCORD_INVITE_URL')).source).toBe('default');
  });
});
