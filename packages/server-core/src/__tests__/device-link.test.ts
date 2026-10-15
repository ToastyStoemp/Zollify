import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGateway } from '../app';
import { REFRESH_COOKIE } from '../refresh-cookie';

const OWNER_EMAIL = 'link-owner@example.test';
const OWNER_PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;
let bearer: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-link-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = OWNER_PASSWORD;
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
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
  bearer = `Bearer ${(res.json() as { accessToken: string }).accessToken}`;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  try {
    app?.zollify?.db?.close();
  } catch {
    /* already closed */
  }
  await app?.close();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* the OS will reclaim it */
  }
  delete process.env.OWNER_EMAIL;
  delete process.env.OWNER_PASSWORD;
});

interface Started { id: string; pollSecret: string; code: string }

async function start(): Promise<Started> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/link/start', payload: { deviceName: 'Booth tablet' } });
  expect(res.statusCode).toBe(200);
  return res.json() as Started;
}
const poll = (s: Started, pollSecret = s.pollSecret) =>
  app.inject({ method: 'POST', url: '/api/auth/link/poll', payload: { id: s.id, pollSecret } });
const signedIn = (url: string, code: string, authorization = bearer) =>
  app.inject({ method: 'POST', url, headers: { authorization }, payload: { code } });

describe('sign in by QR', () => {
  it('hands the waiting device a session once a signed-in device approves', async () => {
    const s = await start();
    expect((await poll(s)).json()).toMatchObject({ status: 'pending' });

    const lookup = await signedIn('/api/link/lookup', s.code);
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({ deviceName: 'Booth tablet' });

    expect((await signedIn('/api/link/approve', s.code)).statusCode).toBe(200);

    const done = await poll(s);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'approved', user: { email: OWNER_EMAIL } });
    expect(done.json()).toHaveProperty('accessToken');
    // Same transport as a password login: the refresh token is a cookie only.
    expect(done.payload).not.toContain('refreshToken');
    expect(done.cookies.find((c) => c.name === REFRESH_COOKIE)).toBeDefined();
  });

  it('hands the session out only once', async () => {
    const s = await start();
    await signedIn('/api/link/approve', s.code);
    expect((await poll(s)).statusCode).toBe(200);
    expect((await poll(s)).statusCode).toBe(410);
  });

  it('needs the poll secret, not just the code shown in the QR', async () => {
    const s = await start();
    await signedIn('/api/link/approve', s.code);
    expect((await poll(s, s.code + s.code)).statusCode).toBe(410);
    expect((await poll(s)).statusCode).toBe(200);
  });

  it('only lets a signed-in device approve', async () => {
    const s = await start();
    expect((await signedIn('/api/link/approve', s.code, 'Bearer nope')).statusCode).toBe(401);
    expect((await poll(s)).json()).toMatchObject({ status: 'pending' });
  });

  it('cannot approve the same code twice', async () => {
    const s = await start();
    expect((await signedIn('/api/link/approve', s.code)).statusCode).toBe(200);
    expect((await signedIn('/api/link/approve', s.code)).statusCode).toBe(404);
  });

  it('tells the waiting device when the request is declined', async () => {
    const s = await start();
    await signedIn('/api/link/deny', s.code);
    const res = await poll(s);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ status: 'denied' });
  });

  it('rotates the code; the old one works only briefly after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = await start();

    vi.setSystemTime(Date.now() + 21_000);
    const rotated = (await poll(s)).json() as { code?: string };
    expect(rotated.code).toBeDefined();
    expect(rotated.code).not.toBe(s.code);

    // Just rotated: a scan of the previous code still lands.
    expect((await signedIn('/api/link/lookup', s.code)).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + 11_000);
    expect((await signedIn('/api/link/lookup', s.code)).statusCode).toBe(404);
    expect((await signedIn('/api/link/lookup', rotated.code!)).statusCode).toBe(200);
  });

  it('a code stops working once the waiting device stops polling', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = await start();
    vi.setSystemTime(Date.now() + 45_000);
    expect((await signedIn('/api/link/approve', s.code)).statusCode).toBe(404);
  });

  it('expires the whole request after five minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = await start();
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    expect((await poll(s)).statusCode).toBe(410);
  });
});
