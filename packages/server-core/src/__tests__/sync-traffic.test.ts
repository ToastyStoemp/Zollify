import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../app';

/**
 * What a device downloads all day: a pull must not hand a device back its own
 * ops, should travel compressed, and cart snapshots go only to the screens
 * showing a customer display.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;
let token: string;

const auth = () => ({ authorization: `Bearer ${token}` });
let n = 0;
const op = (deviceId: string, type = 'setting.upsert', payload: unknown = { key: `k${n}`, value: 'x'.repeat(40), updatedAt: n }) => ({
  opId: `op-traffic-${String(++n).padStart(8, '0')}`,
  deviceId,
  ts: n,
  type,
  payload,
});

async function push(deviceId: string, count: number): Promise<void> {
  const res = await app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(), payload: { deviceId, ops: Array.from({ length: count }, () => op(deviceId)) } });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-traffic-'));
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
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'Test' } });
  token = res.json().accessToken;
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
});

describe('pull', () => {
  it('skips the caller’s own ops, and says when it has caught up', async () => {
    await push('carbon', 3);
    await push('laptop', 2);
    await push('carbon', 4); // the newest ops are all the caller's own

    const mine = await app.inject({ method: 'GET', url: '/api/sync/pull?since=0&device=carbon', headers: auth() });
    const body = mine.json();
    expect(body.ops.map((o: { deviceId: string }) => o.deviceId)).toEqual(['laptop', 'laptop']);
    // Its cursor can jump to the tail without another round trip.
    expect(body.caughtUp).toBe(true);
    expect(body.latestSeq).toBe(9);

    // Without the parameter (an older client) nothing changes.
    const all = (await app.inject({ method: 'GET', url: '/api/sync/pull?since=0', headers: auth() })).json();
    expect(all.ops).toHaveLength(9);
    expect(all.caughtUp).toBeUndefined();
  });

  it('pages without claiming to be caught up while more is left', async () => {
    const page = (await app.inject({ method: 'GET', url: '/api/sync/pull?since=0&limit=1&device=carbon', headers: auth() })).json();
    expect(page.ops).toHaveLength(1);
    expect(page.caughtUp).toBeUndefined();
  });

  it('is gzipped for a client that takes it, once it is worth it', async () => {
    await push('laptop', 40);
    const res = await app.inject({ method: 'GET', url: '/api/sync/pull?since=0', headers: { ...auth(), 'accept-encoding': 'gzip, deflate, br' } });
    expect(res.headers['content-encoding']).toBe('gzip');
    const json = gunzipSync(res.rawPayload).toString();
    expect(JSON.parse(json).ops.length).toBeGreaterThan(40);
    expect(res.rawPayload.length).toBeLessThan(json.length / 3);

    const plain = await app.inject({ method: 'GET', url: '/api/sync/pull?since=0', headers: auth() });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.json().ops.length).toBeGreaterThan(40);

    const tiny = await app.inject({ method: 'GET', url: '/api/sync/pull?since=999999', headers: { ...auth(), 'accept-encoding': 'gzip' } });
    expect(tiny.headers['content-encoding']).toBeUndefined();
  });
});

describe('customer display relay', () => {
  type Socket = WebSocket & { inbox: Record<string, unknown>[] };
  const open = async (deviceId: string): Promise<Socket> => {
    type Inject = (path: string, ctx: object, opts: { onInit(ws: WebSocket): void }) => Promise<WebSocket>;
    // Listen from the very start: the server greets a socket the moment it opens.
    return (await (app as unknown as { injectWS: Inject }).injectWS(`/api/sync/ws?token=${token}&deviceId=${deviceId}`, {}, {
      onInit(ws) {
        const s = ws as Socket;
        s.inbox = [];
        s.on('message', (raw) => s.inbox.push(JSON.parse(String(raw))));
      },
    })) as Socket;
  };
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const carts = (ws: Socket) => ws.inbox.filter((m) => m.type === 'display.cart');
  const listeners = (ws: Socket) => ws.inbox.filter((m) => m.type === 'display.listeners').map((m) => m.count);
  const cart = { deviceName: '', eventName: 'Con', currency: 'CHF', lines: [], discounts: [], total: 0, ts: 1 };

  it('sends carts only to screens showing a display, and tells registers who is listening', async () => {
    const till = await open('till');
    const terminal = await open('terminal');
    const display = await open('display');
    for (const ws of [till, terminal]) ws.send(JSON.stringify({ type: 'display.subscribe', on: false }));
    await settle();
    expect(listeners(till).at(-1)).toBe(0);

    display.send(JSON.stringify({ type: 'display.subscribe', on: true }));
    await settle();
    expect(listeners(till).at(-1)).toBe(1);

    till.send(JSON.stringify({ type: 'display.cart', cart }));
    await settle();
    expect(carts(display)).toHaveLength(1);
    expect(carts(terminal)).toHaveLength(0);

    // A dropped display (an injected socket only reports a hard drop).
    display.terminate();
    for (let i = 0; i < 40 && listeners(till).at(-1) !== 0; i++) await settle();
    expect(listeners(till).at(-1)).toBe(0);
    till.close();
    terminal.close();
  });

  it('keeps sending carts to an older client that never says what it is', async () => {
    const till = await open('till-2');
    const old = await open('old-display');
    till.send(JSON.stringify({ type: 'display.subscribe', on: false }));
    await settle();
    till.send(JSON.stringify({ type: 'display.cart', cart }));
    await settle();
    expect(carts(old)).toHaveLength(1);
    till.close();
    old.close();
  });
});
