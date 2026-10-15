import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, storageUsed } from '@zollify/server-core';
import { taxServerModule } from '../modules/tax/index';
import { sourcingServerModule } from '../modules/sourcing';

/**
 * Every route in the modules that takes file content, held to the shared
 * upload rules: real type from the bytes, a cap per purpose, the account quota,
 * and a body limit that refuses an oversized request before it is read.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'correct horse battery staple';
const SECRET = 'test-secret-value-long-enough-for-signing';
const MB = 1024 * 1024;

let app: FastifyInstance;
let dataDir: string;
let token: string;
let accountId: string;
const auth = () => ({ authorization: `Bearer ${token}` });
const TAX = '/api/m/tax';
const SRC = '/api/m/sourcing';

const b64 = (b: Buffer): string => b.toString('base64');
const PDF_HEAD = Buffer.from('%PDF-1.4\n');
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const file = (head: Buffer, size: number): Buffer => Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-uploads-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = OWNER_PASSWORD;
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: SECRET,
    serverModules: [taxServerModule(SECRET), sourcingServerModule],
    defaultModules: ['tax', 'sourcing'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'Test' } });
  token = login.json().accessToken;
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
  delete process.env.OWNER_EMAIL;
  delete process.env.OWNER_PASSWORD;
  delete process.env.ZOLLIFY_ACCOUNT_STORAGE_MB;
});

describe('tax: ledger invoices', () => {
  let expenseId: string;
  const attach = (payload: object) => app.inject({ method: 'POST', url: `${TAX}/ledger/expenses/${expenseId}/invoice`, headers: auth(), payload });
  const newExpense = async (vendor: string): Promise<string> => {
    const add = await app.inject({
      method: 'POST',
      url: `${TAX}/ledger/expenses`,
      headers: auth(),
      payload: { eventId: 'ev-1', category: 'travel', amount: 10, currency: 'EUR', date: '2026-03-06', vendor },
    });
    return add.json().expense.id;
  };

  beforeAll(async () => {
    expenseId = await newExpense('Train');
  });

  it('keeps a PDF at the cap and below it, and refuses one byte over', async () => {
    expect((await attach({ base64: b64(file(PDF_HEAD, 10 * MB)), filename: 'at.pdf' })).statusCode).toBe(200);
    expect((await attach({ base64: b64(file(PDF_HEAD, 10 * MB - 1)), filename: 'below.pdf' })).statusCode).toBe(200);
    const over = await attach({ base64: b64(file(PDF_HEAD, 10 * MB + 1)), filename: 'over.pdf' });
    expect(over.statusCode).toBe(413);
    expect(over.json().message).toMatch(/10 MB/);
  });

  it('refuses a picture, SVG or text named .pdf', async () => {
    for (const body of [file(PNG_HEAD, 100), SVG, Buffer.from('just some words')]) {
      const res = await attach({ base64: b64(body), filename: 'invoice.pdf' });
      expect(res.statusCode).toBe(415);
      expect(res.json().message).toMatch(/\S/);
    }
  });

  it('refuses an empty or unreadable file', async () => {
    expect((await attach({ base64: '', filename: 'a.pdf' })).statusCode).toBe(400);
    expect((await attach({ filename: 'a.pdf' })).statusCode).toBe(400);
    expect((await attach({ base64: '%%%', filename: 'a.pdf' })).statusCode).toBe(400);
  });

  it('refuses a body over the route limit before reading it', async () => {
    const res = await attach({ base64: 'A'.repeat(15 * MB), filename: 'a.pdf' });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('too_large');
  });

  it('counts the stored invoice toward the account quota', async () => {
    // The first invoice holds 10 MB - 1 now. Replacing it with 4 MB shrinks the account, so it fits a quota just below what is used.
    const used = storageUsed(app.zollify.db, accountId);
    expect(used).toBeGreaterThanOrEqual(10 * MB - 1);
    process.env.ZOLLIFY_ACCOUNT_STORAGE_MB = String((used - 1) / MB);
    try {
      expect((await attach({ base64: b64(file(PDF_HEAD, 4 * MB)), filename: 'smaller.pdf' })).statusCode).toBe(200);
      // Now the account sits at exactly its quota: a new invoice has no room.
      process.env.ZOLLIFY_ACCOUNT_STORAGE_MB = String(storageUsed(app.zollify.db, accountId) / MB);
      const other = await newExpense('Bus');
      const full = await app.inject({
        method: 'POST',
        url: `${TAX}/ledger/expenses/${other}/invoice`,
        headers: auth(),
        payload: { base64: b64(file(PDF_HEAD, 1000)), filename: 'bus.pdf' },
      });
      expect(full.statusCode).toBe(413);
      expect(full.json().message).toMatch(/used up its file storage/);
    } finally {
      delete process.env.ZOLLIFY_ACCOUNT_STORAGE_MB;
    }
  });
});

describe('tax: invoice scanning', () => {
  const scan = (payload: object) => app.inject({ method: 'POST', url: `${TAX}/ledger/parse`, headers: auth(), payload });

  beforeAll(async () => {
    // A key is needed to get past "scanning is off"; the files below are all refused before any call to the provider.
    await app.inject({ method: 'PUT', url: `${TAX}/config`, headers: auth(), payload: { set: { ANTHROPIC_API_KEY: 'sk-ant-test' } } });
  });

  it('refuses what is not a PDF without sending it on', async () => {
    for (const body of [file(PNG_HEAD, 100), SVG]) {
      const res = await scan({ base64: b64(body) });
      expect(res.statusCode).toBe(415);
    }
  });

  it('refuses a PDF over the scanner cap', async () => {
    const res = await scan({ base64: b64(file(PDF_HEAD, 5 * MB + 1)) });
    expect(res.statusCode).toBe(413);
    expect(res.json().message).toMatch(/5 MB/);
  });

  it('refuses an empty request, and a body over the route limit', async () => {
    expect((await scan({})).statusCode).toBe(400);
    expect((await scan({ base64: 'A'.repeat(8 * MB) })).statusCode).toBe(413);
  });
});

describe('tax: accounting voucher PDF', () => {
  const book = (extra: object) =>
    app.inject({
      method: 'POST',
      url: `${TAX}/lexware/book`,
      headers: auth(),
      payload: { kind: 'revenue', dryRun: true, voucherNumber: 'V1', totalGrossAmount: 10, voucherDate: '2026-03-07', taxRatePercent: 0, ...extra },
    });

  it('accepts a real PDF and refuses anything else before booking', async () => {
    expect((await book({ pdfBase64: b64(PDF_HEAD) })).statusCode).toBe(200);
    expect((await book({ pdfBase64: b64(SVG) })).statusCode).toBe(415);
    expect((await book({ pdfBase64: b64(file(PNG_HEAD, 50)) })).statusCode).toBe(415);
    expect((await book({ pdfBase64: b64(file(PDF_HEAD, 10 * MB + 1)) })).statusCode).toBe(413);
  });

  it('refuses a body over the route limit', async () => {
    expect((await book({ pdfBase64: 'A'.repeat(15 * MB) })).statusCode).toBe(413);
  });
});

describe('sourcing: design files and proofs', () => {
  const upload = (payload: object) => app.inject({ method: 'POST', url: `${SRC}/files`, headers: auth(), payload });
  const body = (data: Buffer, over: object = {}) => ({ dossierId: 'd1', filename: 'design.png', mime: 'image/png', kind: 'design', dataB64: b64(data), ...over });

  it('stores a design at the cap and refuses one byte over', async () => {
    const ok = await upload(body(file(PNG_HEAD, 25 * MB)));
    expect(ok.statusCode).toBe(201);
    expect(ok.json().file.mime).toBe('image/png');
    const over = await upload(body(file(PNG_HEAD, 25 * MB + 1)));
    expect(over.statusCode).toBe(413);
    expect(over.json().message).toMatch(/25 MB/);
  });

  it('refuses SVG and HTML, however they are labelled', async () => {
    for (const [name, mime, data] of [
      ['logo.svg', 'image/svg+xml', SVG],
      ['logo.png', 'image/png', SVG],
      ['page.pdf', 'application/pdf', Buffer.from('<html><script>alert(1)</script></html>')],
    ] as const) {
      const res = await upload(body(data, { filename: name, mime }));
      expect(res.statusCode, name).toBe(415);
    }
  });

  it('refuses a claim the bytes contradict, and takes an unknown claim as no claim', async () => {
    expect((await upload(body(file(PDF_HEAD, 100), { mime: 'image/png' }))).statusCode).toBe(415);
    const res = await upload(body(file(PDF_HEAD, 100), { filename: 'proof.pdf', mime: 'application/octet-stream', kind: 'proof' }));
    expect(res.statusCode).toBe(201);
    expect(res.json().file.mime).toBe('application/pdf');
  });

  it('refuses a body over the route limit before reading it', async () => {
    const res = await upload({ dossierId: 'd1', filename: 'a.png', dataB64: 'A'.repeat(40 * MB) });
    expect(res.statusCode).toBe(413);
  });
});
