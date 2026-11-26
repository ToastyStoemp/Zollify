import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled } from '@zollify/server-core';
import { printDeskServerModule, REQUEST_TTL_MS } from '../modules/print-desk';

/**
 * Print Desk's server half: settings shared between devices, desks reporting their status, and
 * requests a desk takes once.
 */

const PASSWORD = 'correct horse battery staple';
const SECRET = 'test-secret-value-long-enough-for-signing';
const M = '/api/m/print-desk';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let staff: string;
let accountId: string;

const as = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown, token = owner) =>
  app.inject({ method, url: `${M}${url}`, headers: as(token), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
const status = (extra = {}) => ({ name: 'Print Desk', allowRemote: true, printer: 'Canon PRO-1000 series', counts: { 'kyoto:a3': 3 }, ...extra });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-print-desk-'));
  process.env.OWNER_EMAIL = 'owner@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: SECRET,
    serverModules: [printDeskServerModule],
    defaultModules: ['print-desk'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  const login = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.test', password: PASSWORD, deviceName: 'Test' } })).json();
  owner = login.accessToken;
  accountId = login.user.accountId;
  setEnabled(app.zollify.db, accountId, 'print-desk', true);
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: as(owner), payload: { role: 'member' } });
  staff = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'helper@example.test', password: PASSWORD, inviteCode: invite.json().code } })).json().accessToken;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('shared settings', () => {
  it('starts empty, and merges what a device changes into what the others set', async () => {
    expect((await call('GET', '/config')).json()).toEqual({ config: {}, updatedAt: 0 });
    await call('PUT', '/config', { target: 5, itemTargets: { 'kyoto:a3': 8 } });
    const after = (await call('PUT', '/config', { hidden: ['wave:l'], order: ['sunset:', 'kyoto:a3'] })).json();
    expect(after.config).toEqual({ target: 5, itemTargets: { 'kyoto:a3': 8 }, hidden: ['wave:l'], order: ['sunset:', 'kyoto:a3'] });
    expect(after.updatedAt).toBeGreaterThan(0);
    expect((await call('GET', '/config')).json().config.target).toBe(5);
  });
  it('takes only the settings it knows, in their shape', async () => {
    expect((await call('PUT', '/config', { target: -1 })).statusCode).toBe(400);
    expect((await call('PUT', '/config', { links: {} })).statusCode).toBe(400);
  });
  it('lets anyone read them, but only owners and admins change them', async () => {
    expect((await call('GET', '/config', undefined, staff)).json().config.target).toBe(5);
    expect((await call('PUT', '/config', { target: 9 }, staff)).statusCode).toBe(403);
  });
});

describe('desks reporting', () => {
  it('lists each desk with what it reported, online while it keeps reporting', async () => {
    expect((await call('PUT', '/status/desk-1', status())).statusCode).toBe(200);
    const { desks } = (await call('GET', '/status')).json();
    expect(desks).toHaveLength(1);
    expect(desks[0]).toMatchObject({ deviceId: 'desk-1', online: true, name: 'Print Desk', allowRemote: true, counts: { 'kyoto:a3': 3 } });
    app.zollify.db.prepare('UPDATE print_desk_status SET updatedAt = ? WHERE deviceId = ?').run(Date.now() - 60_000, 'desk-1');
    expect((await call('GET', '/status')).json().desks[0].online).toBe(false);
  });
  it('turns away a report it does not understand', async () => {
    expect((await call('PUT', '/status/desk-1', { name: 'x' })).statusCode).toBe(400);
  });
});

describe('requests', () => {
  it('queues a request that one desk takes, once, and says how it went', async () => {
    const made = await call('POST', '/requests', { kind: 'counts', counts: { 'kyoto:a3': 4 } });
    expect(made.statusCode).toBe(201);
    const id = made.json().request.id;
    expect((await call('GET', '/requests?deviceId=desk-1')).json().requests.map((r: { id: string }) => r.id)).toEqual([id]);
    expect((await call('POST', `/requests/${id}/claim`, { deviceId: 'desk-1' })).statusCode).toBe(200);
    expect((await call('POST', `/requests/${id}/claim`, { deviceId: 'desk-2' })).statusCode).toBe(409);
    expect((await call('GET', '/requests?deviceId=desk-2')).json().requests).toEqual([]);
    expect((await call('POST', `/requests/${id}/outcome`, { status: 'done', result: 'Counts set: 4 copies of 1 item.' })).statusCode).toBe(200);
    expect((await call('GET', '/requests')).json().requests[0]).toMatchObject({ id, kind: 'counts', status: 'done', takenBy: 'desk-1', payload: { counts: { 'kyoto:a3': 4 } } });
  });
  it('keeps a request for one desk away from the others', async () => {
    const id = (await call('POST', '/requests', { kind: 'print', deviceId: 'desk-1', onlySize: 'a3' })).json().request.id;
    expect((await call('GET', '/requests?deviceId=desk-2')).json().requests).toEqual([]);
    expect((await call('POST', `/requests/${id}/claim`, { deviceId: 'desk-2' })).statusCode).toBe(409);
    expect((await call('POST', `/requests/${id}/claim`, { deviceId: 'desk-1' })).statusCode).toBe(200);
    expect((await call('POST', `/requests/${id}/outcome`, { status: 'refused', result: 'Remote printing is off on this desk.' })).statusCode).toBe(200);
  });
  it('lets a request nobody took expire, rather than print late', async () => {
    const id = (await call('POST', '/requests', { kind: 'print' })).json().request.id;
    app.zollify.db.prepare('UPDATE print_desk_requests SET createdAt = ? WHERE id = ?').run(Date.now() - REQUEST_TTL_MS - 1000, id);
    expect((await call('GET', '/requests?deviceId=desk-1')).json().requests).toEqual([]);
    expect((await call('POST', `/requests/${id}/claim`, { deviceId: 'desk-1' })).statusCode).toBe(409);
    expect((await call('GET', '/requests')).json().requests.find((r: { id: string }) => r.id === id).status).toBe('expired');
  });
  it('takes requests from owners and admins only, and only ones it understands', async () => {
    expect((await call('POST', '/requests', { kind: 'print' }, staff)).statusCode).toBe(403);
    expect((await call('POST', '/requests', { kind: 'reboot' })).statusCode).toBe(400);
    expect((await call('POST', '/requests', { kind: 'counts', counts: { 'kyoto:a3': -2 } })).statusCode).toBe(400);
  });
});
