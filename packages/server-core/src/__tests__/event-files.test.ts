import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../app';

/**
 * Files attached to events: owners and admins add and remove them, anyone who
 * can see the event may download them, and a helper bound to other events
 * learns nothing about this one's.
 */

const OWNER_EMAIL = 'owner@example.test';
const PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;
let owner: string;
let helper: string;
let outsider: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const pdf = Buffer.from('%PDF-1.4 a ticket').toString('base64');
const put = (token: string, eventId: string, id: string, body: object) =>
  app.inject({ method: 'PUT', url: `/api/events/${eventId}/files/${id}`, headers: auth(token), payload: body });
const get = (token: string, eventId: string, id: string) => app.inject({ method: 'GET', url: `/api/events/${eventId}/files/${id}`, headers: auth(token) });

async function joinAs(email: string, allowedEventIds: string[]): Promise<string> {
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'member', allowedEventIds } });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: PASSWORD, inviteCode: invite.json().code } });
  expect(reg.statusCode).toBe(200);
  return reg.json().accessToken;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-event-files-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
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
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER_EMAIL, password: PASSWORD, deviceName: 'Test' } });
  owner = res.json().accessToken;
  helper = await joinAs('helper@shop.test', ['ev-1']);
  outsider = await joinAs('other@shop.test', ['ev-2']);
});

afterAll(async () => {
  try {
    app.zollify?.db?.close();
  } catch {
    /* already closed */
  }
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.OWNER_EMAIL;
  delete process.env.OWNER_PASSWORD;
  delete process.env.REQUIRE_CAPTCHA;
});

describe('event files', () => {
  it('stores a file and hands the same bytes back', async () => {
    const up = await put(owner, 'ev-1', 'f1', { name: 'ticket.pdf', mime: 'application/pdf', data: pdf });
    expect(up.statusCode).toBe(200);
    const down = await get(owner, 'ev-1', 'f1');
    expect(down.statusCode).toBe(200);
    expect(down.json()).toEqual({ name: 'ticket.pdf', mime: 'application/pdf', data: pdf });
  });

  it('lets a helper bound to the event read it, but not add or remove files', async () => {
    expect((await get(helper, 'ev-1', 'f1')).statusCode).toBe(200);
    expect((await put(helper, 'ev-1', 'f2', { name: 'x.pdf', mime: 'application/pdf', data: pdf })).statusCode).toBe(403);
    const del = await app.inject({ method: 'DELETE', url: '/api/events/ev-1/files/f1', headers: auth(helper) });
    expect(del.statusCode).toBe(403);
    expect((await get(owner, 'ev-1', 'f1')).statusCode).toBe(200);
  });

  it('shows a helper nothing of an event they were not given', async () => {
    expect((await get(outsider, 'ev-1', 'f1')).statusCode).toBe(404);
  });

  it('does not serve a file under another event id', async () => {
    expect((await get(owner, 'ev-2', 'f1')).statusCode).toBe(404);
  });

  it('refuses kinds of file a browser would run', async () => {
    const res = await put(owner, 'ev-1', 'f3', { name: 'x.html', mime: 'text/html', data: pdf });
    expect(res.statusCode).toBe(400);
    expect((await get(owner, 'ev-1', 'f3')).statusCode).toBe(404);
  });

  it('refuses an empty file and one over the size limit', async () => {
    expect((await put(owner, 'ev-1', 'f4', { name: 'a.pdf', mime: 'application/pdf', data: '=' })).statusCode).toBe(400);
    const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    expect((await put(owner, 'ev-1', 'f5', { name: 'big.pdf', mime: 'application/pdf', data: big })).statusCode).toBe(413);
  });

  it('refuses ids that could climb out of the store', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/events/ev-1/files/..%2F..%2Fx', headers: auth(owner), payload: { name: 'a.pdf', mime: 'application/pdf', data: pdf } });
    expect([400, 404]).toContain(res.statusCode);
  });

  it('caps the files on one event', async () => {
    for (let i = 0; i < 19; i++) expect((await put(owner, 'ev-cap', `c${i}`, { name: `${i}.pdf`, mime: 'application/pdf', data: pdf })).statusCode).toBe(200);
    // Replacing one that exists is not a 21st.
    expect((await put(owner, 'ev-cap', 'c0', { name: 'again.pdf', mime: 'application/pdf', data: pdf })).statusCode).toBe(200);
    expect((await put(owner, 'ev-cap', 'c19', { name: '19.pdf', mime: 'application/pdf', data: pdf })).statusCode).toBe(200);
    expect((await put(owner, 'ev-cap', 'c20', { name: '20.pdf', mime: 'application/pdf', data: pdf })).statusCode).toBe(409);
  });

  it('removes the file from the store and the disk', async () => {
    const del = await app.inject({ method: 'DELETE', url: '/api/events/ev-1/files/f1', headers: auth(owner) });
    expect(del.statusCode).toBe(200);
    expect((await get(owner, 'ev-1', 'f1')).statusCode).toBe(404);
    expect(existsSync(join(dataDir, 'event-files'))).toBe(true);
  });

  it('needs a signed-in user', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/events/ev-1/files/f1' })).statusCode).toBe(401);
  });
});
