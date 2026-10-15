import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYNC_PUSH_MAX_BYTES } from '@zollify/shared';
import { buildGateway } from '../app';
import { checkQuota, decodeUpload, downloadHeaders, storageUsed, uploadConfig } from '../upload-limits';

/**
 * The upload mechanism end to end through the real gateway: what the event
 * file route refuses and why, the account quota, and that an oversized body is
 * refused before it is read.
 */

const OWNER_EMAIL = 'owner@example.test';
const PASSWORD = 'correct horse battery staple';
const MB = 1024 * 1024;

let app: FastifyInstance;
let dataDir: string;
let owner: string;
let accountId: string;

const auth = () => ({ authorization: `Bearer ${owner}` });
const b64 = (b: Uint8Array | Buffer): string => Buffer.from(b).toString('base64');
const PDF_HEAD = Buffer.from('%PDF-1.4\n');
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A file of exactly `size` bytes beginning with `head`. */
const file = (head: Buffer, size: number): Buffer => Buffer.concat([head, Buffer.alloc(size - head.length)]);
const put = (eventId: string, id: string, body: object) => app.inject({ method: 'PUT', url: `/api/events/${eventId}/files/${id}`, headers: auth(), payload: body });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-uploads-'));
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
  accountId = (app.zollify.db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: string }).id;
});

afterAll(async () => {
  try {
    app.zollify?.db?.close();
  } catch {
    /* already closed */
  }
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  for (const k of ['OWNER_EMAIL', 'OWNER_PASSWORD', 'REQUIRE_CAPTCHA', 'ZOLLIFY_ACCOUNT_STORAGE_MB', 'ZOLLIFY_EVENT_FILES_MAX']) delete process.env[k];
});

describe('event file uploads', () => {
  it('takes a file exactly at its cap and one just below', async () => {
    expect((await put('ev-a', 'at', { name: 'at.pdf', mime: 'application/pdf', data: b64(file(PDF_HEAD, 10 * MB)) })).statusCode).toBe(200);
    expect((await put('ev-a', 'below', { name: 'below.pdf', mime: 'application/pdf', data: b64(file(PDF_HEAD, 10 * MB - 1)) })).statusCode).toBe(200);
  });

  it('refuses a file one byte over with a 413 that names the limit', async () => {
    const res = await put('ev-a', 'over', { name: 'over.pdf', mime: 'application/pdf', data: b64(file(PDF_HEAD, 10 * MB + 1)) });
    expect(res.statusCode).toBe(413);
    expect(res.json().message).toMatch(/10 MB/);
  });

  it('holds a picture to its lower cap', async () => {
    expect((await put('ev-a', 'p-ok', { name: 'a.png', mime: 'image/png', data: b64(file(PNG_HEAD, 5 * MB)) })).statusCode).toBe(200);
    const res = await put('ev-a', 'p-big', { name: 'b.png', mime: 'image/png', data: b64(file(PNG_HEAD, 5 * MB + 1)) });
    expect(res.statusCode).toBe(413);
    expect(res.json().message).toMatch(/5 MB/);
  });

  it('refuses a file whose bytes do not match its extension and type', async () => {
    const res = await put('ev-a', 'liar', { name: 'ticket.pdf', mime: 'application/pdf', data: b64(Buffer.from('this is plainly not a pdf')) });
    expect(res.statusCode).toBe(415);
    expect(res.json().message).toMatch(/not a type that can be uploaded|contents are/);
    const png = await put('ev-a', 'liar2', { name: 'ticket.pdf', mime: 'application/pdf', data: b64(file(PNG_HEAD, 100)) });
    expect(png.statusCode).toBe(415);
    const lie = await put('ev-a', 'liar3', { name: 'a.png', mime: 'image/png', data: b64(file(PDF_HEAD, 100)) });
    expect(lie.statusCode).toBe(415);
    expect(lie.json().error).toBe('type_mismatch');
  });

  it('refuses SVG and HTML dressed up as a picture or a document', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    for (const [name, mime, data] of [
      ['cat.png', 'image/png', svg],
      ['cat.jpg', 'image/jpeg', html],
      ['notes.txt', 'text/plain', html],
      ['plan.pdf', 'application/pdf', svg],
    ] as const) {
      const res = await put('ev-a', 'x' + name.length, { name, mime, data: b64(data) });
      expect(res.statusCode, name).toBe(415);
      expect(res.json().message, name).toMatch(/HTML, SVG|not a type/);
    }
  });

  it('stores the type the bytes prove', async () => {
    expect((await put('ev-b', 'j', { name: 'photo.jpg', mime: 'image/jpeg', data: b64(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])) })).statusCode).toBe(200);
    const row = app.zollify.db.prepare("SELECT mime FROM event_files WHERE id = 'j'").get() as { mime: string };
    expect(row.mime).toBe('image/jpeg');
    expect((await app.inject({ method: 'GET', url: '/api/events/ev-b/files/j', headers: auth() })).json().mime).toBe('image/jpeg');
  });

  it('refuses data that is not base64 at all', async () => {
    const res = await put('ev-b', 'junk', { name: 'a.pdf', mime: 'application/pdf', data: 'not base64!!' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/could not be read/);
  });

  it('stops at the per-event file count from the environment', async () => {
    process.env.ZOLLIFY_EVENT_FILES_MAX = '2';
    try {
      const body = { name: 'a.pdf', mime: 'application/pdf', data: b64(file(PDF_HEAD, 64)) };
      expect((await put('ev-count', 'c1', body)).statusCode).toBe(200);
      expect((await put('ev-count', 'c2', body)).statusCode).toBe(200);
      const res = await put('ev-count', 'c3', body);
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/2 files/);
    } finally {
      delete process.env.ZOLLIFY_EVENT_FILES_MAX;
    }
  });
});

describe('account storage quota', () => {
  it('counts what the account holds and refuses what would pass the quota', async () => {
    const used = storageUsed(app.zollify.db, accountId);
    expect(used).toBeGreaterThan(20 * MB);
    // Room for 1 MB more than it holds.
    process.env.ZOLLIFY_ACCOUNT_STORAGE_MB = String((used + MB) / MB);
    try {
      expect(uploadConfig().accountQuotaBytes).toBe(used + MB);
      expect((await put('ev-q', 'q1', { name: 'a.pdf', mime: 'application/pdf', data: b64(file(PDF_HEAD, MB)) })).statusCode).toBe(200);
      const res = await put('ev-q', 'q2', { name: 'b.pdf', mime: 'application/pdf', data: b64(file(PDF_HEAD, PDF_HEAD.length)) });
      expect(res.statusCode).toBe(413);
      expect(res.json().message).toMatch(/used up its file storage/);
      // Replacing a file frees its own bytes first: same size again still fits.
      expect((await put('ev-q', 'q1', { name: 'a.pdf', mime: 'application/pdf', data: b64(file(PDF_HEAD, MB)) })).statusCode).toBe(200);
    } finally {
      delete process.env.ZOLLIFY_ACCOUNT_STORAGE_MB;
    }
  });

  it('is per account', () => {
    expect(storageUsed(app.zollify.db, 'some-other-account')).toBe(0);
    expect(checkQuota(app.zollify.db, 'some-other-account', 1)).toBeNull();
  });

  it('counts the tables of modules that are not deployed as zero', () => {
    expect(() => storageUsed(app.zollify.db, accountId)).not.toThrow();
  });
});

describe('oversized bodies', () => {
  it('refuses a body over the route limit, and answers in the shape the app shows', async () => {
    const res = await put('ev-a', 'huge', { name: 'a.pdf', mime: 'application/pdf', data: 'A'.repeat(15 * MB) });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'too_large' });
    expect(res.json().message).toMatch(/too large/);
  });

  it('refuses from Content-Length alone, before any of the body is sent', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, method: 'PUT', path: '/api/events/ev-a/files/early', headers: { ...auth(), 'content-type': 'application/json', 'content-length': String(500 * MB) } },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        },
      );
      req.on('error', (e) => (e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e));
      // Only the start of the body is ever written.
      req.write('{"name":"a.pdf","data":"');
    });
    expect(status).toBe(413);
  });

  it('limits the sync push to what a device batch can need', async () => {
    const deviceId = 'dev-1';
    const op = { opId: '0'.repeat(16), deviceId, ts: 1, type: 'x', payload: 'y'.repeat(SYNC_PUSH_MAX_BYTES) };
    const res = await app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(), payload: { deviceId, ops: [op] } });
    expect(res.statusCode).toBe(413);
  });

  it('applies the default limit to routes that take no file', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(), payload: { note: 'z'.repeat(uploadConfig().maxBodyBytes + 1) } });
    expect(res.statusCode).toBe(413);
  });

  it('still answers other errors as before', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sync/push', headers: { ...auth(), 'content-type': 'application/json' }, payload: '{not json' });
    expect(res.statusCode).toBe(400);
  });
});

describe('decodeUpload', () => {
  it('refuses an oversized file from the text alone, before decoding it', () => {
    const res = decodeUpload('logo', 'A'.repeat(1_000_000));
    expect(res).toMatchObject({ ok: false, status: 413 });
  });

  it('refuses things that are not strings', () => {
    expect(decodeUpload('invoice', undefined)).toMatchObject({ ok: false, status: 400 });
    expect(decodeUpload('invoice', 42)).toMatchObject({ ok: false, status: 400 });
  });

  it('returns the bytes and the proven type of a good file', () => {
    const res = decodeUpload('invoice', b64(PDF_HEAD), { name: 'a.pdf', claimedMime: 'application/pdf' });
    expect(res).toMatchObject({ ok: true, kind: 'pdf', mime: 'application/pdf' });
    expect(res.ok && res.bytes.equals(PDF_HEAD)).toBe(true);
  });
});

describe('downloadHeaders', () => {
  it('serves a stored file as a download that a browser cannot run', () => {
    const h = downloadHeaders('../../evil "name".pdf', 'application/pdf');
    expect(h['content-disposition']).toMatch(/^attachment; filename="[\w.\- ]+"$/);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['content-security-policy']).toMatch(/^sandbox;/);
    expect(h['content-type']).toBe('application/pdf');
  });
});
