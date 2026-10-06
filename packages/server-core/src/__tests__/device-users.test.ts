import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../app';

/**
 * A shared till: one device signed in, several people unlocking it with
 * their PIN. What must hold: a PIN only works together with the device's
 * session and the grant from adding the person, it cannot be guessed, the
 * person gets their own role (not the device's), and every sale stays
 * credited to whoever rang it up.
 */

const PASSWORD = 'correct horse battery staple';
const TILL = 'till-device-1';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let ownerId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (t: string, url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers: auth(t), payload });
let n = 0;
const sale = (soldBy?: string) => ({
  opId: `op-devusers-${String(++n).padStart(10, '0')}`,
  deviceId: TILL,
  ts: n,
  type: 'tx.create',
  payload: { id: `t${n}`, eventId: 'e1', deviceId: TILL, timestamp: n, method: 'cash', payments: [], items: [], discounts: [], total: 0, currency: 'CHF', ...(soldBy ? { soldBy: { userId: soldBy, email: null } } : {}) },
});
const push = (t: string, ops: unknown[], deviceId = TILL) => post(t, '/api/sync/push', { deviceId, ops });
const sellerOf = async (txId: string): Promise<string | undefined> => {
  const ops = (await app.inject({ method: 'GET', url: '/api/sync/pull?since=0', headers: auth(owner) })).json().ops as { type: string; payload: { id: string; soldBy?: { userId: string } } }[];
  return ops.find((o) => o.type === 'tx.create' && o.payload.id === txId)?.payload.soldBy?.userId;
};

async function member(email: string): Promise<{ token: string; id: string }> {
  const invite = await post(owner, '/api/invites', { role: 'member' });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: PASSWORD, inviteCode: invite.json().code } });
  return { token: reg.json().accessToken, id: reg.json().user.id };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-devusers-'));
  process.env.OWNER_EMAIL = 'owner@till.test';
  process.env.OWNER_PASSWORD = PASSWORD;
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
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@till.test', password: PASSWORD, deviceId: TILL } });
  owner = login.json().accessToken;
  ownerId = login.json().user.id;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('a shared till', () => {
  let sam: { token: string; id: string };
  let grant = '';

  it('adds a colleague with their password, choosing a PIN', async () => {
    sam = await member('sam@till.test');
    expect((await post(owner, '/api/device-users', { deviceId: TILL, email: 'sam@till.test', password: 'nope' })).statusCode).toBe(403);
    expect((await post(owner, '/api/device-users', { deviceId: TILL, email: 'sam@till.test', password: PASSWORD })).json()).toMatchObject({ needsPin: true });
    expect((await post(owner, '/api/device-users', { deviceId: TILL, email: 'sam@till.test', password: PASSWORD, pin: '12' })).statusCode).toBe(400);
    const res = await post(owner, '/api/device-users', { deviceId: TILL, email: 'sam@till.test', password: PASSWORD, pin: '4711' });
    expect(res.statusCode).toBe(201);
    grant = res.json().grant;
    expect(res.json().person).toMatchObject({ userId: sam.id, role: 'member', hasPin: true });
    const list = (await app.inject({ method: 'GET', url: `/api/device-users?deviceId=${TILL}`, headers: auth(owner) })).json().people;
    expect(list.map((p: { email: string }) => p.email)).toEqual(['sam@till.test']);
  });

  it('unlocks as the colleague, with their own role', async () => {
    expect((await post(owner, '/api/auth/unlock', { deviceId: TILL, userId: sam.id, pin: '0000', grant })).statusCode).toBe(403);
    expect((await post(owner, '/api/auth/unlock', { deviceId: TILL, userId: sam.id, pin: '4711', grant: 'f'.repeat(64) })).statusCode).toBe(404);
    const res = await post(owner, '/api/auth/unlock', { deviceId: TILL, userId: sam.id, pin: '4711', grant });
    expect(res.json().user).toMatchObject({ id: sam.id, role: 'member' });
    const samOnTill = res.json().accessToken as string;
    // Sam is staff on this device too: no team management.
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: auth(samOnTill) })).statusCode).toBe(403);
    // And their sales are theirs.
    const s = sale();
    await push(samOnTill, [s]);
    expect(await sellerOf(s.payload.id)).toBe(sam.id);
  });

  it('keeps a sale credited to whoever rang it up, even if someone else syncs it', async () => {
    // Kim signs the till in as staff; Sam rang up a sale before locking, and it syncs under Kim.
    const kim = await member('kim@till.test');
    // Signed in somewhere else only: the till's id in the push is not enough.
    const unproven = sale(sam.id);
    await push(kim.token, [unproven]);
    expect(await sellerOf(unproven.payload.id)).toBe(kim.id);
    kim.token = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'kim@till.test', password: PASSWORD, deviceId: TILL } })).json().accessToken;
    const fromSam = sale(sam.id);
    await push(kim.token, [fromSam]);
    expect(await sellerOf(fromSam.payload.id)).toBe(sam.id);
    // Not added to this device: Kim cannot pass a sale off as someone else's.
    const fake = sale(ownerId);
    await push(kim.token, [fake]);
    expect(await sellerOf(fake.payload.id)).toBe(kim.id);
    // Nor by claiming another device.
    const elsewhere = sale(sam.id);
    await push(kim.token, [elsewhere], 'other-device');
    expect(await sellerOf(elsewhere.payload.id)).toBe(kim.id);
  });

  it('renews while unlocked, and for a short grace after locking', async () => {
    expect((await post(owner, '/api/auth/unlock/renew', { deviceId: TILL, userId: sam.id, grant })).json().user.id).toBe(sam.id);
    await post(owner, '/api/auth/lock', { deviceId: TILL, userId: sam.id });
    expect((await post(owner, '/api/auth/unlock/renew', { deviceId: TILL, userId: sam.id, grant })).statusCode).toBe(200);
    app.zollify.db.prepare('UPDATE device_users SET unlockedUntil = 1').run();
    expect((await post(owner, '/api/auth/unlock/renew', { deviceId: TILL, userId: sam.id, grant })).statusCode).toBe(403);
  });

  it('only works with the session of a device in the same account', async () => {
    const other = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { newAccount: true } });
    const stranger = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'x@else.test', password: PASSWORD, inviteCode: other.json().code } })).json().accessToken;
    expect((await post(stranger, '/api/auth/unlock', { deviceId: TILL, userId: sam.id, pin: '4711', grant })).statusCode).toBe(404);
    expect((await post(stranger, '/api/device-users', { deviceId: TILL, email: 'sam@till.test', password: PASSWORD })).statusCode).toBe(403);
  });

  it('locks a person out after wrong PINs, then removes them from the device', async () => {
    for (let i = 0; i < 4; i++) expect((await post(owner, '/api/auth/unlock', { deviceId: TILL, userId: sam.id, pin: '9999', grant })).statusCode).toBe(403);
    expect((await post(owner, '/api/auth/unlock', { deviceId: TILL, userId: sam.id, pin: '9999', grant })).statusCode).toBe(423);
    // Locked out: even the right PIN waits.
    expect((await post(owner, '/api/auth/unlock', { deviceId: TILL, userId: sam.id, pin: '4711', grant })).statusCode).toBe(423);
    app.zollify.db.prepare('UPDATE device_users SET lockedUntil = 0').run();
    for (let i = 0; i < 4; i++) await post(owner, '/api/auth/unlock', { deviceId: TILL, userId: sam.id, pin: '9999', grant });
    const last = await post(owner, '/api/auth/unlock', { deviceId: TILL, userId: sam.id, pin: '9999', grant });
    expect(last.json()).toMatchObject({ removed: true });
    expect((await post(owner, '/api/auth/unlock', { deviceId: TILL, userId: sam.id, pin: '4711', grant })).statusCode).toBe(404);
  });

  it("checks the device's own user's PIN without a grant", async () => {
    expect((await post(owner, '/api/auth/unlock', { deviceId: TILL, userId: ownerId, pin: '2468' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/users/me/pin', headers: auth(owner), payload: { password: 'wrong', pin: '2468' } })).statusCode).toBe(403);
    await app.inject({ method: 'PUT', url: '/api/users/me/pin', headers: auth(owner), payload: { password: PASSWORD, pin: '2468' } });
    expect((await post(owner, '/api/auth/unlock', { deviceId: TILL, userId: ownerId, pin: '2468' })).json()).toEqual({ ok: true, userId: ownerId });
  });
});

describe('staff badges', () => {
  let kai: { token: string; id: string };
  let grant = '';
  let code = '';

  it('an admin issues a colleague a badge, which can be reprinted and replaced', async () => {
    kai = await member('kai@till.test');
    grant = (await post(owner, '/api/device-users', { deviceId: TILL, email: 'kai@till.test', password: PASSWORD, pin: '3141' })).json().grant;
    const res = await post(owner, `/api/users/${kai.id}/badge`, {});
    expect(res.statusCode).toBe(201);
    code = res.json().code;
    expect(code).toMatch(/^ZS\d{24}$/);
    expect((await app.inject({ method: 'GET', url: `/api/users/${kai.id}/badge`, headers: auth(owner) })).json().code).toBe(code);
    // Staff cannot issue badges for others, only see their own.
    expect((await post(kai.token, `/api/users/${ownerId}/badge`, {})).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/users/${kai.id}/badge`, headers: auth(kai.token) })).json().code).toBe(code);
  });

  it('scanning it unlocks as its owner on a device they were added to', async () => {
    const res = await post(owner, '/api/auth/unlock-badge', { deviceId: TILL, code: `zs-${code.slice(2, 14)} ${code.slice(14)}`, grants: { [kai.id]: grant } });
    expect(res.json().user).toMatchObject({ id: kai.id, role: 'member' });
    // Not on another device, nor without the grant.
    expect((await post(owner, '/api/auth/unlock-badge', { deviceId: 'other-till', code, grants: { [kai.id]: grant } })).statusCode).toBe(404);
    expect((await post(owner, '/api/auth/unlock-badge', { deviceId: TILL, code, grants: {} })).statusCode).toBe(404);
    // An unknown code tells nothing.
    expect((await post(owner, '/api/auth/unlock-badge', { deviceId: TILL, code: `ZS${'0'.repeat(24)}`, grants: {} })).json().error).toMatch(/Unknown badge/);
  });

  it('asks for the PIN too when the device wants it', async () => {
    expect((await post(owner, '/api/auth/unlock-badge', { deviceId: TILL, code, grants: { [kai.id]: grant }, pin: '0000' })).statusCode).toBe(403);
    expect((await post(owner, '/api/auth/unlock-badge', { deviceId: TILL, code, grants: { [kai.id]: grant }, pin: '3141' })).json().user.id).toBe(kai.id);
  });

  it("a new badge retires the old one, and the device's own user scans in without a grant", async () => {
    const fresh = (await post(owner, `/api/users/${kai.id}/badge`, {})).json().code;
    expect((await post(owner, '/api/auth/unlock-badge', { deviceId: TILL, code, grants: { [kai.id]: grant } })).statusCode).toBe(404);
    expect((await post(owner, '/api/auth/unlock-badge', { deviceId: TILL, code: fresh, grants: { [kai.id]: grant } })).statusCode).toBe(200);
    const mine = (await post(owner, `/api/users/${ownerId}/badge`, {})).json().code;
    expect((await post(owner, '/api/auth/unlock-badge', { deviceId: TILL, code: mine })).json()).toEqual({ ok: true, userId: ownerId });
    await app.inject({ method: 'DELETE', url: `/api/users/${ownerId}/badge`, headers: auth(owner) });
    expect((await post(owner, '/api/auth/unlock-badge', { deviceId: TILL, code: mine })).statusCode).toBe(404);
  });
});
