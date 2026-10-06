import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGateway, setEnabled } from '@zollify/server-core';
import type { PeppolDocument } from '@zollify/shared';
import { peppolServerModule } from '../modules/peppol-be';

/**
 * Belgian e-invoices: numbers must run without gaps and never repeat, an
 * issued invoice must never change, and one business must never see
 * another's invoices or customers.
 */

const PASSWORD = 'correct horse battery staple';
const kbo = (b: string): string => `${b}${String(97 - (Number(b) % 97)).padStart(2, '0')}`;
const SELLER = kbo('04031707');
const BUYER = kbo('08765432');
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let accountId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (t: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/m/peppol-be${url}`, headers: auth(t), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
const buyer = { name: 'Café Lumière', vatNumber: `BE${BUYER}`, companyId: BUYER, street: 'Meir 2', city: 'Antwerp', postalCode: '2000', country: 'BE', peppolScheme: '0208', peppolId: BUYER };
const invoice = (extra: Record<string, unknown> = {}) => ({
  issueDate: '2026-10-06',
  dueDate: '2026-11-05',
  buyer,
  buyerReference: 'PO-77',
  lines: [{ description: 'Fox print', quantity: 2, unitPrice: 100, vatCategory: 'S', vatRate: 21 }],
  ...extra,
});

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-peppol-'));
  process.env.OWNER_EMAIL = 'owner@peppol.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [peppolServerModule('test-secret-value-long-enough-for-signing')],
    defaultModules: ['peppol-be'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  const login = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@peppol.test', password: PASSWORD } })).json();
  owner = login.accessToken;
  accountId = login.user.accountId;
  setEnabled(app.zollify.db, accountId, 'peppol-be', true);
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
  vi.restoreAllMocks();
});

describe('issuing', () => {
  let first: PeppolDocument;

  it('refuses to issue until the details are complete, and says why', async () => {
    const created = await call(owner, 'POST', '/documents', invoice());
    if (created.statusCode !== 201) throw new Error(created.body);
    const draft = created.json();
    expect(draft.document).toMatchObject({ status: 'draft', number: null });
    const res = await call(owner, 'POST', `/documents/${draft.document.id}/issue`);
    expect(res.statusCode).toBe(422);
    expect(res.json().problems.map((p: { rule: string }) => p.rule)).toContain('PEPPOL-EN16931-R020');
    first = draft.document;
  });

  it('numbers issued invoices in order, without gaps from discarded drafts, and freezes them', async () => {
    await call(owner, 'PUT', '/settings', { name: 'Kunsthaus BV', vatNumber: `BE${SELLER}`, companyId: SELLER, street: 'Rue Haute 1', city: 'Brussels', postalCode: '1000', country: 'BE', peppolScheme: '0208', peppolId: SELLER, iban: 'BE68539007547034' });
    const discarded = (await call(owner, 'POST', '/documents', invoice())).json().document;
    expect((await call(owner, 'DELETE', `/documents/${discarded.id}`)).statusCode).toBe(200);
    const a = (await call(owner, 'POST', `/documents/${first.id}/issue`)).json().document;
    const second = (await call(owner, 'POST', '/documents', invoice())).json().document;
    const b = (await call(owner, 'POST', `/documents/${second.id}/issue`)).json().document;
    expect([a.number, b.number]).toEqual(['INV-2026-0001', 'INV-2026-0002']);
    expect(a.paymentReference).toMatch(/^\+\+\+\d{3}\/\d{4}\/\d{5}\+\+\+$/);
    // Issued: no changes, no deleting, no issuing twice.
    expect((await call(owner, 'PUT', `/documents/${a.id}`, invoice({ buyerReference: 'changed' }))).statusCode).toBe(409);
    expect((await call(owner, 'DELETE', `/documents/${a.id}`)).statusCode).toBe(409);
    expect((await call(owner, 'POST', `/documents/${a.id}/issue`)).statusCode).toBe(409);
    first = a;
  });

  it('serves the UBL as issued', async () => {
    const res = await call(owner, 'GET', `/documents/${first.id}/xml`);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.headers['content-disposition']).toContain('INV-2026-0001.xml');
    expect(res.body).toContain('<cbc:ID>INV-2026-0001</cbc:ID>');
    expect(res.body).toContain('<cbc:PayableAmount currencyID="EUR">242.00</cbc:PayableAmount>');
    // Later settings changes never touch an issued invoice.
    await call(owner, 'PUT', '/settings', { name: 'Renamed BV', vatNumber: `BE${SELLER}`, companyId: SELLER, street: 'Rue Haute 1', city: 'Brussels', postalCode: '1000', country: 'BE', peppolScheme: '0208', peppolId: SELLER, iban: 'BE68539007547034' });
    expect((await call(owner, 'GET', `/documents/${first.id}/xml`)).body).toContain('Kunsthaus BV');
  });

  it('corrects with a credit note in its own series, referring to the invoice', async () => {
    const credit = (await call(owner, 'POST', `/documents/${first.id}/credit`)).json().document;
    expect(credit).toMatchObject({ kind: 'credit', status: 'draft', invoiceRef: { number: 'INV-2026-0001' } });
    const issued = (await call(owner, 'POST', `/documents/${credit.id}/issue`)).json().document;
    expect(issued.number).toBe('CN-2026-0001');
    const xml = (await call(owner, 'GET', `/documents/${credit.id}/xml`)).body;
    expect(xml).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>');
    expect(xml).toContain('<cbc:ID>INV-2026-0001</cbc:ID>');
  });
});

describe('sending', () => {
  it('needs an access point, keeps its key on the server, and sends once through Storecove', async () => {
    const doc = (await call(owner, 'GET', '/documents')).json().documents.find((d: { number: string }) => d.number === 'INV-2026-0002');
    expect((await call(owner, 'POST', `/documents/${doc.id}/send`)).statusCode).toBe(400);
    expect((await call(owner, 'PUT', '/access-point', { provider: 'nobody', apiKey: 'k' })).statusCode).toBe(400);
    await call(owner, 'PUT', '/access-point', { provider: 'storecove', apiKey: 'secret-key-123', accountRef: '4242' });
    const settings = (await call(owner, 'GET', '/settings')).body;
    expect(settings).not.toContain('secret-key-123');
    expect(JSON.parse(settings).accessPoint).toMatchObject({ provider: 'storecove', accountRef: '4242', hasKey: true });

    const real = globalThis.fetch;
    const seen: { url: string; body: { legalEntityId: number; idempotencyGuid: string; routing: { eIdentifiers: { scheme: string; id: string }[] }; document: { rawDocumentData: { document: string } } }; auth: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (!String(url).startsWith('https://api.storecove.com/')) return real(url, init);
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: String((init?.headers as Record<string, string>).authorization) });
      return new Response(JSON.stringify({ guid: 'sc-guid-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const res = await call(owner, 'POST', `/documents/${doc.id}/send`);
    expect(res.json()).toMatchObject({ reference: 'sc-guid-1', document: { status: 'sent', sentVia: { provider: 'storecove' } } });
    expect(seen[0]!.auth).toBe('Bearer secret-key-123');
    expect(seen[0]!.body).toMatchObject({ legalEntityId: 4242, idempotencyGuid: doc.id, routing: { eIdentifiers: [{ scheme: 'BE:EN', id: BUYER }] } });
    expect(Buffer.from(seen[0]!.body.document.rawDocumentData.document, 'base64').toString()).toContain('<cbc:ID>INV-2026-0002</cbc:ID>');
    vi.restoreAllMocks();
  });
});

describe('isolation', () => {
  it("keeps one business's invoices from another and from staff", async () => {
    const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { newAccount: true } });
    const other = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'other@peppol.test', password: PASSWORD, inviteCode: invite.json().code } })).json();
    setEnabled(app.zollify.db, other.user.accountId, 'peppol-be', true);
    const mine = (await call(owner, 'GET', '/documents')).json().documents[0];
    expect((await call(other.accessToken, 'GET', '/documents')).json().documents).toEqual([]);
    expect((await call(other.accessToken, 'GET', `/documents/${mine.id}`)).statusCode).toBe(404);
    expect((await call(other.accessToken, 'GET', `/documents/${mine.id}/xml`)).statusCode).toBe(404);
    expect((await call(other.accessToken, 'POST', `/documents/${mine.id}/credit`)).statusCode).toBe(404);

    const staffInvite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'member' } });
    const staff = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'staff@peppol.test', password: PASSWORD, inviteCode: staffInvite.json().code } })).json().accessToken;
    expect((await call(staff, 'GET', '/documents')).statusCode).toBe(403);
  });

  it('refuses odd lookup input before it reaches the directory', async () => {
    expect((await call(owner, 'GET', '/lookup?scheme=0208&id=../../etc')).statusCode).toBe(400);
    expect((await call(owner, 'GET', '/lookup?scheme=abc&id=0123')).statusCode).toBe(400);
  });
});
