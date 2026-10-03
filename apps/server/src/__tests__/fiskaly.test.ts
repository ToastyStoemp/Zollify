import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '@zollify/server-core';
import { FiskalyApi, parseFinished, type Fetch } from '../modules/fiskaly/api';

/**
 * fiskaly cloud TSE, signed on the server. Against a stand-in for fiskaly's
 * API that keeps its rules - admin login for clients and initialising, a
 * registered client for transactions, revisions in order - and answers in
 * the shape of a response captured from fiskaly's TEST environment.
 */

const { posServerModule } = await import('../modules/receipts');

/** A FINISHED transaction captured from fiskaly's TEST environment (public TEST data, no secrets). */
const CAPTURED = {
  schema: { raw: { process_type: 'Kassenbeleg-V1', process_data: 'QmVsZWdeNC4yMF8wLjAwXzAuMDBfMC4wMF8wLjAwXjQuMjA6VW5iYXI=' } },
  state: 'FINISHED',
  tss_serial_number: '2be721cf1a255afd12626533e251fe7b3e3c8af625b9f12803918a9bb1952867',
  client_serial_number: 'UT-TEST-101bd1cd-286c-4c3b-9ae5-43d4fad02f08',
  number: 1,
  time_start: 1787078299,
  time_end: 1787078299,
  signature: { value: 'kHCYf4/f/zz+51m5XlzLtuEOFvVyAF3wrzsz+p+iyQcxzICkza8O9m/P45pRDQRWwEvxYzYZQWR3wGqEsSf2iA==', algorithm: 'ecdsa-plain-SHA256', counter: 27, public_key: 'BAVHkwS3tptbKRK2Z8E6a8u8N/Qkw/6gBr89NivYZciYJVpF5uQPQTpgb64I3STVhUpLVc/ZCZOz7eaBol+qUnY=' },
  log: { operation: 'Finish', timestamp: 1787078299, timestamp_format: 'unixTime' },
  qr_code_data:
    'V0;UT-TEST-101bd1cd-286c-4c3b-9ae5-43d4fad02f08;Kassenbeleg-V1;Beleg^4.20_0.00_0.00_0.00_0.00^4.20:Unbar;1;27;2026-08-18T18:38:19.000Z;2026-08-18T18:38:19.000Z;ecdsa-plain-SHA256;unixTime;kHCYf4/f/zz+51m5XlzLtuEOFvVyAF3wrzsz+p+iyQcxzICkza8O9m/P45pRDQRWwEvxYzYZQWR3wGqEsSf2iA==;BAVHkwS3tptbKRK2Z8E6a8u8N/Qkw/6gBr89NivYZciYJVpF5uQPQTpgb64I3STVhUpLVc/ZCZOz7eaBol+qUnY=',
};

describe('reading a fiskaly transaction', () => {
  it('takes the signed values from fiskaly’s own QR string', () => {
    expect(parseFinished(CAPTURED, 'TEST')).toEqual({
      number: 1,
      signatureCounter: 27,
      time: 1787078299000,
      signature: CAPTURED.signature.value,
      info: { serial: CAPTURED.tss_serial_number, publicKey: CAPTURED.signature.public_key, algorithm: 'ecdsa-plain-SHA256', timeFormat: 'unixTime', certified: false },
      exact: {
        clientId: 'UT-TEST-101bd1cd-286c-4c3b-9ae5-43d4fad02f08',
        processType: 'Kassenbeleg-V1',
        processData: 'Beleg^4.20_0.00_0.00_0.00_0.00^4.20:Unbar',
        start: '2026-08-18T18:38:19.000Z',
        finish: '2026-08-18T18:38:19.000Z',
      },
    });
    expect(parseFinished(CAPTURED, 'LIVE').info.certified).toBe(true);
  });
});

// ── A stand-in fiskaly ──────────────────────────────────────────────────────

interface FakeTss {
  state: string;
  puk: string;
  pin?: string;
  admin: boolean;
  clients: Map<string, string>;
  txs: Map<string, { number: number; revision: number; clientId: string; start: number }>;
  counter: number;
}

function fakeFiskaly() {
  const tss = new Map<string, FakeTss>();
  const calls: string[] = [];
  let down = false;
  const fetch: Fetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace('/api/v2', '');
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push(`${init.method} ${path}`);
    const reply = (status: number, data: unknown) => ({ status, ok: status < 400, json: async () => data });
    if (down) throw new Error('connect ECONNREFUSED');
    if (path === '/auth') {
      return body.api_key === 'key' && body.api_secret === 'secret'
        ? reply(200, { access_token: 'tok', access_token_claims: { env: 'TEST', organization_id: 'org' }, access_token_expires_in: 600 })
        : reply(401, { message: 'Invalid credentials' });
    }
    if (init.headers.authorization !== 'Bearer tok') return reply(401, { message: 'Unauthorized' });
    const m = /^\/tss\/([^/]+)(?:\/(admin|client|tx)(?:\/(auth|logout|[^/]+))?)?$/.exec(path);
    if (!m) return reply(404, { message: 'Not found' });
    const [, id, kind, sub] = m;
    let t = tss.get(id!);
    if (!kind) {
      if (init.method === 'PUT') {
        t = { state: 'CREATED', puk: 'PUK123', admin: false, clients: new Map(), txs: new Map(), counter: 0 };
        tss.set(id!, t);
        return reply(200, { _id: id, state: 'CREATED', admin_puk: 'PUK123' });
      }
      if (!t) return reply(404, { message: 'TSS not found' });
      if (init.method === 'GET') return reply(200, { _id: id, state: t.state, serial_number: 'serial-of-' + id });
      if (body.state === 'UNINITIALIZED' && t.state === 'CREATED') t.state = 'UNINITIALIZED';
      else if (body.state === 'INITIALIZED' && t.state === 'UNINITIALIZED' && t.admin) t.state = 'INITIALIZED';
      else return reply(409, { message: `Cannot go from ${t.state} to ${body.state}` });
      return reply(200, { state: t.state });
    }
    if (!t) return reply(404, { message: 'TSS not found' });
    if (kind === 'admin') {
      if (!sub) {
        if (body.admin_puk !== t.puk || String(body.new_admin_pin ?? '').length < 6) return reply(400, { message: 'Bad PUK or PIN' });
        t.pin = String(body.new_admin_pin);
        return reply(200, {});
      }
      if (sub === 'auth') {
        if (!t.pin || body.admin_pin !== t.pin) return reply(401, { message: 'Wrong PIN' });
        t.admin = true;
        return reply(200, {});
      }
      t.admin = false;
      return reply(200, {});
    }
    if (kind === 'client') {
      if (!t.admin) return reply(401, { message: 'Admin login required' });
      if (/[/_]/.test(String(body.serial_number))) return reply(400, { message: 'Bad serial' });
      t.clients.set(sub!, String(body.serial_number));
      return reply(200, { _id: sub, serial_number: body.serial_number, state: 'REGISTERED' });
    }
    // tx
    if (t.state !== 'INITIALIZED') return reply(409, { message: 'TSS not initialized' });
    const serial = t.clients.get(String(body.client_id));
    if (!serial) return reply(404, { message: 'Client not found' });
    const revision = Number(u.searchParams.get('tx_revision'));
    const tx = t.txs.get(sub!);
    if (body.state === 'ACTIVE' && revision === 1 && !tx) {
      const now = 1787078299;
      t.txs.set(sub!, { number: t.txs.size + 1, revision: 1, clientId: String(body.client_id), start: now });
      t.counter++;
      return reply(200, { state: 'ACTIVE', number: t.txs.size, time_start: now });
    }
    if (body.state === 'FINISHED' && tx && revision === tx.revision + 1) {
      const raw = (body.schema as { raw: { process_type: string; process_data: string } }).raw;
      const data = Buffer.from(raw.process_data, 'base64').toString('utf8');
      t.counter++;
      tx.revision = revision;
      const iso = new Date((tx.start + 2) * 1000).toISOString();
      return reply(200, {
        ...CAPTURED,
        number: tx.number,
        tss_serial_number: 'serial-of-' + id,
        signature: { ...CAPTURED.signature, counter: t.counter },
        log: { ...CAPTURED.log, timestamp: tx.start + 2 },
        qr_code_data: ['V0', serial, raw.process_type, data, tx.number, t.counter, new Date(tx.start * 1000).toISOString(), iso, 'ecdsa-plain-SHA256', 'unixTime', CAPTURED.signature.value, CAPTURED.signature.public_key].join(';'),
      });
    }
    return reply(409, { message: 'Bad transaction revision or state' });
  };
  return { fetch, tss, calls, setDown: (v: boolean) => (down = v) };
}

// ── Through the server ──────────────────────────────────────────────────────

const fake = fakeFiskaly();
let app: FastifyInstance;
let dataDir: string;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-fiskaly-'));
  process.env.OWNER_EMAIL = 'owner@example.test';
  process.env.OWNER_PASSWORD = 'correct horse battery staple';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [posServerModule('test-secret-value-long-enough-for-signing', { fiskaly: new FiskalyApi(fake.fetch, 'https://fake.fiskaly.test/api/v2') })],
    defaultModules: ['pos'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  token = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.test', password: 'correct horse battery staple', deviceName: 'Test' } })).json().accessToken;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) => app.inject({ method, url: `/api/m/pos${url}`, headers: auth(), ...(payload ? { payload } : {}) });

describe('fiskaly cloud TSE', () => {
  it('checks the API key with fiskaly before keeping it, and never hands it out', async () => {
    expect((await call('GET', '/fiskaly')).json()).toEqual({ configured: false });
    const bad = await call('PUT', '/fiskaly', { apiKey: 'key', apiSecret: 'wrong' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().message).toContain('Invalid credentials');
    expect((await call('PUT', '/fiskaly', { apiKey: 'key', apiSecret: 'secret' })).json()).toEqual({ configured: true, env: 'TEST' });
    const status = await call('GET', '/fiskaly');
    expect(status.json()).toEqual({ configured: true, env: 'TEST', tss: null });
    expect(status.body).not.toContain('secret');
  });

  it('refuses to sign before the TSE is set up', async () => {
    const res = await call('POST', '/fiskaly/start', { clientId: 'ZOLLIFY-PHONE1' });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain('not set up');
  });

  it('creates and initialises the TSS: PUK, admin PIN, admin login, INITIALIZED', async () => {
    const res = await call('POST', '/fiskaly/setup');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tss).toMatchObject({ state: 'INITIALIZED', serial: `serial-of-${body.tss.id}` });
    expect([...fake.tss.values()][0]!.pin).toMatch(/^\d{10}$/);
    // Running it again changes nothing.
    expect((await call('POST', '/fiskaly/setup')).json().tss).toEqual(body.tss);
    expect(fake.tss.size).toBe(1);
  });

  it('registers each till the first time it signs, and signs exactly the processData sent', async () => {
    const started = (await call('POST', '/fiskaly/start', { clientId: 'ZOLLIFY-PHONE1' })).json();
    expect(started).toEqual({ number: 1, time: 1787078299000 });
    const finished = await call('POST', '/fiskaly/finish', { clientId: 'ZOLLIFY-PHONE1', number: 1, processType: 'Kassenbeleg-V1', processData: 'Beleg^21.00_0.00_0.00_0.00_0.00^21.00:Unbar' });
    expect(finished.statusCode).toBe(200);
    expect(finished.json()).toMatchObject({
      number: 1,
      signatureCounter: 2,
      signature: CAPTURED.signature.value,
      info: { algorithm: 'ecdsa-plain-SHA256', timeFormat: 'unixTime', certified: false },
      exact: { clientId: 'ZOLLIFY-PHONE1', processType: 'Kassenbeleg-V1', processData: 'Beleg^21.00_0.00_0.00_0.00_0.00^21.00:Unbar' },
    });
    // A second till gets its own client; the first is not registered again.
    const clientsBefore = fake.calls.filter((c) => c.includes('/client/')).length;
    await call('POST', '/fiskaly/start', { clientId: 'ZOLLIFY-PHONE1' });
    expect(fake.calls.filter((c) => c.includes('/client/')).length).toBe(clientsBefore);
    await call('POST', '/fiskaly/start', { clientId: 'ZOLLIFY-CARBON' });
    expect([...fake.tss.values()][0]!.clients.size).toBe(2);
  });

  it('says why when fiskaly cannot be reached, and refuses bad input', async () => {
    fake.setDown(true);
    const res = await call('POST', '/fiskaly/start', { clientId: 'ZOLLIFY-PHONE1' });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain('could not be reached');
    fake.setDown(false);
    expect((await call('POST', '/fiskaly/start', { clientId: 'BAD_SERIAL' })).statusCode).toBe(400);
    expect((await call('POST', '/fiskaly/finish', { clientId: 'ZOLLIFY-PHONE1', number: 999, processType: 'Kassenbeleg-V1', processData: 'x' })).statusCode).toBe(404);
  });
});
