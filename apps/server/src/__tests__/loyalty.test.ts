import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, type MailMessage } from '@zollify/server-core';
import { loyaltyServerModule, setWalletFetch } from '../modules/loyalty';
import { resetWalletTokens } from '../modules/google-wallet';

/**
 * A stamp card on the customer's phone: joining from the QR with a confirmed
 * email, the card page, the till reading a card, stamps counted from the
 * synced sales (and given back on a revert), rewards, the owner's hand on
 * the ledger, erasure, and the pass on Google's side through a pretend
 * Google.
 */

process.env.SIGNUP_CAPTCHA_BITS = '10';
const PASSWORD = 'correct horse battery staple';
const SECRET = 'test-secret-value-long-enough-for-signing';
const sent: MailMessage[] = [];
const google: { method: string; url: string; body: unknown }[] = [];
let googleFails = false;
const objects = new Map<string, Record<string, unknown>>();
let app: FastifyInstance;
let dataDir: string;
let owner = '';
let staff = '';
let joinUrl = '';
let code = '';
let memberId = '';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (t: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/loyalty${url}`, headers: auth(t), ...(payload ? { payload } : {}) });
let ip = 0;
const pub = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, remoteAddress: `10.8.${Math.floor(++ip / 250)}.${ip % 250}`, ...(payload ? { payload } : {}) });

function solve(nonce: string, difficulty: number): string {
  for (let i = 0; ; i++) {
    const h = createHash('sha256').update(`${nonce}:${i}`).digest();
    let bits = 0;
    for (const b of h) {
      if (b === 0) {
        bits += 8;
        continue;
      }
      bits += Math.clz32(b) - 24;
      break;
    }
    if (bits >= difficulty) return String(i);
  }
}
async function joinWith(body: Record<string, unknown>) {
  const ch = (await pub('GET', '/p/loyalty/challenge')).json();
  return pub('POST', new URL(joinUrl).pathname, { ...body, captchaToken: ch.token, captchaSolution: solve(ch.nonce, ch.difficulty) });
}
const linkIn = (m: MailMessage): string => /https?:\/\/\S+/.exec(m.text)![0];

// A separator before the padding: 't1' and 't10' padded with zeros alone would be the same op id.
const op = (opId: string, type: string, payload: unknown) => ({ opId: `${opId}:`.padEnd(16, '0'), deviceId: 'dev-1', ts: 1, type, payload });
// Modules hear pushed ops after the push is answered (setImmediate), so give them a moment.
const push = async (ops: unknown[]) => {
  const res = await app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(owner), payload: { deviceId: 'dev-1', ops } });
  await new Promise((r) => setTimeout(r, 30));
  return res;
};
const memberLine = (id: string) => ({ pid: 'module:loyalty:member', vid: null, title: 'Stamp card', qty: 1, unitPrice: 0, lineTotal: 0, ref: { moduleId: 'loyalty', kind: 'member', id } });
const rewardLine = (id: string, amount: number) => ({ pid: 'module:loyalty:reward', vid: null, title: 'Reward', qty: 1, unitPrice: -amount, lineTotal: -amount, ref: { moduleId: 'loyalty', kind: 'reward', id } });
let tick = 0;
/** Each sale a second after the last, so the ledger's order is a fact. */
const sale = (id: string, total: number, items: unknown[], ts = 1_700_000_000_000 + ++tick * 1000) => ({
  id, eventId: 'ev-1', deviceId: 'dev-1', timestamp: ts, method: 'cash', payments: [{ kind: 'cash', amount: total }], items, discounts: [], total, currency: 'EUR',
});

/** A pretend Google: a token, a class store, an object store; 500s when asked. */
function pretendGoogle(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  // The token request is a form; everything else is JSON.
  const raw = init?.body ? String(init.body) : '';
  const body = raw.startsWith('{') ? JSON.parse(raw) : undefined;
  google.push({ method, url, body });
  const reply = (status: number, json: unknown) => Promise.resolve(new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } }));
  if (url.includes('oauth2.googleapis.com')) return reply(200, { access_token: 'tok', expires_in: 3600 });
  if (googleFails) return reply(500, { error: { message: 'backend down' } });
  if (url.endsWith('/loyaltyClass') && method === 'POST') return reply(objects.has(body.id) ? 409 : 200, body).then((r) => (objects.set(body.id, body), r));
  if (url.includes('/loyaltyClass/') && method === 'PUT') return reply(200, body);
  if (url.endsWith('/loyaltyObject') && method === 'POST') {
    objects.set(body.id, body);
    return reply(200, body);
  }
  const m = /\/loyaltyObject\/([^/?]+)/.exec(url);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    if (method === 'GET') return objects.has(id) ? reply(200, objects.get(id)) : reply(404, { error: { message: 'not found' } });
    if (method === 'PATCH') {
      objects.set(id, { ...objects.get(id), ...body });
      return reply(200, objects.get(id));
    }
  }
  return reply(400, { error: { message: `unexpected ${method} ${url}` } });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-loyalty-'));
  process.env.OWNER_EMAIL = 'shop@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  process.env.PUBLIC_ORIGIN = 'https://till.example.test';
  setWalletFetch(pretendGoogle);
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: SECRET,
    serverModules: [loyaltyServerModule(SECRET)],
    defaultModules: ['loyalty'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
    mailer: { enabled: true, send: async (m) => (sent.push(m), true) },
  });
  await app.ready();
  owner = (await pub('POST', '/api/auth/login', { email: 'shop@example.test', password: PASSWORD })).json().accessToken;
  await app.inject({ method: 'PUT', url: '/api/account/profile', headers: auth(owner), payload: { name: 'Ink Booth', defaultCurrency: 'EUR' } });
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'member' } });
  staff = (await pub('POST', '/api/auth/register', { email: 'staff@example.test', password: PASSWORD, inviteCode: invite.json().code })).json().accessToken;
  await push([op('ev', 'event.upsert', { id: 'ev-1', name: 'Leipzig Con', dateStart: '2026-03-07', dateEnd: '2026-03-08', venue: { country: 'Germany' }, currency: 'EUR', status: 'active', updatedAt: 1 })]);
});

afterAll(async () => {
  setWalletFetch(null);
  resetWalletTokens();
  delete process.env.PUBLIC_ORIGIN;
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the programme', () => {
  it('starts with a stamp card, a join link, and is the admin\'s to change', async () => {
    const res = await call(owner, 'GET', '/settings');
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({ scheme: 'stamps', stampEvery: 10, rewardCost: 10, reward: { kind: 'amount', amount: 5 } });
    joinUrl = res.json().joinUrl;
    expect(joinUrl).toMatch(/^https:\/\/till\.example\.test\/p\/loyalty\/j\/[A-Za-z0-9_-]{20,}$/);
    expect(res.json().emailEnabled).toBe(true);
    expect((await call(staff, 'GET', '/settings')).statusCode).toBe(403);

    const put = await call(owner, 'PUT', '/settings', { programme: 'Ink Booth stamps', scheme: 'stamps', stampEvery: 10, rewardCost: 3, reward: { kind: 'amount', amount: 5 }, joinIntro: 'Thanks for coming back.' });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.rewardCost).toBe(3);
    expect((await call(owner, 'PUT', '/settings', { reward: { kind: 'percent', percent: 500 } })).statusCode).toBe(400);
  });
});

describe('joining from the QR', () => {
  it('shows the sign-up page with the reward, and refuses an unknown link', async () => {
    const res = await pub('GET', new URL(joinUrl).pathname);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Ink Booth stamps');
    expect(res.body).toContain('3 stamps = €5.00 off');
    expect(res.body).toContain('Thanks for coming back.');
    expect(res.body).toContain('/p/loyalty/join.js');
    expect((await pub('GET', '/p/loyalty/j/nope')).statusCode).toBe(404);
  });

  it('needs the proof-of-work and a real address, and a bot gets a quiet yes', async () => {
    expect((await pub('POST', new URL(joinUrl).pathname, { email: 'ana@example.test' })).statusCode).toBe(403);
    expect((await joinWith({ email: 'not an address' })).statusCode).toBe(400);
    const bot = await joinWith({ email: 'bot@example.test', website: 'http://spam' });
    expect(bot.json()).toEqual({ emailed: true });
    expect(sent).toHaveLength(0);
  });

  it('mails a confirmation link; opening it makes the card and shows it', async () => {
    const res = await joinWith({ email: 'Ana@Example.test', name: 'Ana' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ emailed: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('ana@example.test');
    const confirm = linkIn(sent[0]!);
    expect(confirm).toContain('/p/loyalty/confirm/');
    // Not a member until confirmed: the till does not know the card yet.
    expect((await call(owner, 'GET', '/members')).json().members).toHaveLength(0);

    const opened = await pub('GET', new URL(confirm).pathname);
    expect(opened.statusCode).toBe(303);
    expect(opened.headers.location).toMatch(/^\/p\/loyalty\/c\/LY-[0-9A-HJKMNP-TV-Z]{16}$/);
    code = String(opened.headers.location).split('/').pop()!;
    const card = await pub('GET', opened.headers.location as string);
    expect(card.statusCode).toBe(200);
    expect(card.body).toContain('Ana');
    expect(card.body).toContain('3 more stamps to the next reward');
    expect(card.body).toContain('<svg');
    expect(card.body).not.toContain('Add to Google Wallet');
    // The link is single use.
    expect((await pub('GET', new URL(confirm).pathname)).statusCode).toBe(404);

    const members = (await call(owner, 'GET', '/members')).json().members;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ email: 'ana@example.test', name: 'Ana', code, standing: { balance: 0, rewards: 0, toNext: 3 } });
    memberId = members[0].id;
  });

  it('sends an existing member their card again rather than a second one', async () => {
    const res = await joinWith({ email: 'ana@example.test' });
    expect(res.json()).toEqual({ emailed: true });
    expect(sent).toHaveLength(2);
    expect(linkIn(sent[1]!)).toBe(`https://till.example.test/p/loyalty/c/${code}`);
    expect((await call(owner, 'GET', '/members')).json().members).toHaveLength(1);
  });
});

describe('the till', () => {
  it('reads a card by its code or its URL, for staff too', async () => {
    const res = await call(staff, 'GET', `/lookup?code=${encodeURIComponent(`https://till.example.test/p/loyalty/c/${code}`)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().member).toMatchObject({ id: memberId, name: 'Ana', standing: { balance: 0 } });
    expect(res.json().settings).toMatchObject({ scheme: 'stamps', rewardCost: 3, reward: { kind: 'amount', amount: 5 } });
    expect((await call(staff, 'GET', `/lookup?code=${code.toLowerCase()}`)).statusCode).toBe(200);
    expect((await call(staff, 'GET', '/lookup?code=LY-0000000000000000')).statusCode).toBe(404);
    expect((await call(staff, 'GET', '/lookup?code=SMP-POSTCARDS')).statusCode).toBe(404);
  });
});

describe('stamps from the sales', () => {
  it('counts a member\'s sale as it syncs, once, and gives it back on a revert', async () => {
    await push([op('t1', 'tx.create', sale('t1', 25, [{ pid: 'pin', vid: null, title: 'Pin', qty: 1, unitPrice: 25, lineTotal: 25 }, memberLine(memberId)]))]);
    let st = (await call(staff, 'GET', `/lookup?code=${code}`)).json().member.standing;
    expect(st).toMatchObject({ earned: 2, spent: 0, balance: 2, rewards: 0, toNext: 1 });
    // The same sale pushed again (a retry) changes nothing.
    await push([op('t1', 'tx.create', sale('t1', 25, [memberLine(memberId)]))]);
    expect((await call(staff, 'GET', `/lookup?code=${code}`)).json().member.standing.earned).toBe(2);
    // A sale with no member line is nobody's; one below the stamp size earns nothing.
    await push([op('t2', 'tx.create', sale('t2', 40, [{ pid: 'pin', vid: null, title: 'Pin', qty: 1, unitPrice: 40, lineTotal: 40 }]))]);
    await push([op('t3', 'tx.create', sale('t3', 4, [memberLine(memberId)]))]);
    expect((await call(staff, 'GET', `/lookup?code=${code}`)).json().member.standing.earned).toBe(2);
    // A third stamp, then the sale is reverted.
    await push([op('t4', 'tx.create', sale('t4', 10, [memberLine(memberId)]))]);
    st = (await call(staff, 'GET', `/lookup?code=${code}`)).json().member.standing;
    expect(st).toMatchObject({ balance: 3, rewards: 1 });
    expect((await pub('GET', `/p/loyalty/c/${code}`)).body).toContain('1 reward to use');
    await push([op('r4', 'tx.revert', { id: 't4', revertedAt: 2, revertedBy: 'r4' })]);
    expect((await call(staff, 'GET', `/lookup?code=${code}`)).json().member.standing).toMatchObject({ balance: 2, rewards: 0 });
  });

  it('a reward in a sale spends a card, and the sale still earns on what was paid', async () => {
    await push([op('t5', 'tx.create', sale('t5', 10, [memberLine(memberId)]))]);
    expect((await call(staff, 'GET', `/lookup?code=${code}`)).json().member.standing.rewards).toBe(1);
    // 15 of goods, 5 off as the reward, 10 paid: the reward costs 3 stamps, the 10 paid earns 1.
    await push([op('t6', 'tx.create', sale('t6', 10, [{ pid: 'print', vid: null, title: 'Print', qty: 1, unitPrice: 15, lineTotal: 15 }, memberLine(memberId), rewardLine(memberId, 5)]))]);
    const st = (await call(staff, 'GET', `/lookup?code=${code}`)).json().member.standing;
    expect(st).toMatchObject({ earned: 4, spent: 3, balance: 1, rewards: 0, toNext: 2 });
  });

  it('test-mode sales stamp no real card', async () => {
    await push([op('x1', 'tx.test.create', { ...sale('x1', 100, [memberLine(memberId)]), testRun: 'run-1' })]);
    expect((await call(staff, 'GET', `/lookup?code=${code}`)).json().member.standing.earned).toBe(4);
  });
});

describe("the owner's hand", () => {
  it('gives or takes by hand, shows the ledger, and recounts from the sales', async () => {
    const adj = await call(owner, 'POST', `/members/${memberId}/adjust`, { delta: 2, note: 'sorry for the wait' });
    expect(adj.statusCode).toBe(200);
    expect(adj.json().member.standing).toMatchObject({ earned: 6, balance: 3, rewards: 1 });
    expect((await call(staff, 'POST', `/members/${memberId}/adjust`, { delta: 2 })).statusCode).toBe(403);
    expect((await call(owner, 'POST', `/members/${memberId}/adjust`, { delta: 0 })).statusCode).toBe(400);
    const one = (await call(owner, 'GET', `/members/${memberId}`)).json();
    expect(one.ledger.map((l: { amount: number; note: string }) => [l.amount, l.note])).toEqual([[2, 'sorry for the wait'], [1, ''], [-3, 'reward'], [1, ''], [2, '']]);

    // The earning rule changes: a recount reads every sale the new way and keeps the hand adjustments.
    await call(owner, 'PUT', '/settings', { programme: 'Ink Booth stamps', scheme: 'stamps', stampEvery: 5, rewardCost: 3, reward: { kind: 'amount', amount: 5 } });
    expect((await call(owner, 'POST', '/recount')).json()).toEqual({ members: 1 });
    // t1 25 → 5, t3 4 → 0, t5 10 → 2, t6 10 → 2 and spent 3, plus 2 by hand: earned 11, spent 3.
    expect((await call(owner, 'GET', `/members/${memberId}`)).json().member.standing).toMatchObject({ earned: 11, spent: 3, balance: 8 });
  });
});

describe('a balance set by hand - moving a customer over', () => {
  let entryId = '';
  it('is refused to staff until an admin allows it, then logged with who did it', async () => {
    expect((await call(staff, 'POST', `/members/${memberId}/set`, { balance: 7 })).statusCode).toBe(403);
    expect((await call(staff, 'GET', `/lookup?code=${code}`)).json().maySet).toBe(false);
    const current = (await call(owner, 'GET', '/settings')).json().settings;
    expect((await call(owner, 'PUT', '/settings', { ...current, staffMaySet: true })).statusCode).toBe(200);
    expect((await call(staff, 'GET', `/lookup?code=${code}`)).json().maySet).toBe(true);
    const set = await call(staff, 'POST', `/members/${memberId}/set`, { balance: 7, note: 'old paper card' });
    expect(set.statusCode).toBe(200);
    expect(set.json().member.standing).toMatchObject({ balance: 7 });
    const ledger = (await call(owner, 'GET', `/members/${memberId}`)).json().ledger;
    expect(ledger[0]).toMatchObject({ amount: -1, note: 'old paper card', by: { email: 'staff@example.test' } });
    expect(ledger.find((l: { note: string }) => l.note === 'sorry for the wait').by.email).toBe('shop@example.test');
    expect(ledger.find((l: { saleId: string | null }) => l.saleId === 't1').by).toBeNull();
    entryId = ledger[0].id;
    expect((await call(staff, 'POST', `/members/${memberId}/set`, { balance: -1 })).statusCode).toBe(400);
  });

  it('is the admin\'s to change or remove; sale rows are not', async () => {
    expect((await call(staff, 'PUT', `/ledger/${entryId}`, { amount: 5, note: 'x' })).statusCode).toBe(403);
    const edited = await call(owner, 'PUT', `/ledger/${entryId}`, { amount: 3, note: 'old card, recounted' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().standing.balance).toBe(11);
    expect(edited.json().ledger[0]).toMatchObject({ amount: 3, note: 'old card, recounted', by: { email: 'staff@example.test' } });
    expect((await call(owner, 'PUT', '/ledger/t1:earn', { amount: 99, note: '' })).statusCode).toBe(404);
    expect((await call(owner, 'DELETE', '/ledger/t1:earn')).statusCode).toBe(404);
    const removed = await call(owner, 'DELETE', `/ledger/${entryId}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().standing.balance).toBe(8);
    expect((await call(owner, 'DELETE', `/ledger/${entryId}`)).statusCode).toBe(404);
  });
});

describe('Google Wallet', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const serviceAccountJson = JSON.stringify({ type: 'service_account', client_email: 'wallet@proj.iam.gserviceaccount.com', private_key: pem });

  it('is set up with the issuer id and the service account file, proved on Google first', async () => {
    expect((await call(owner, 'PUT', '/google', { issuerId: '12', serviceAccountJson })).statusCode).toBe(400);
    expect((await call(owner, 'PUT', '/google', { issuerId: '3388000000012345678', serviceAccountJson: '{"nope":1}' })).statusCode).toBe(400);
    googleFails = true;
    const refused = await call(owner, 'PUT', '/google', { issuerId: '3388000000012345678', serviceAccountJson, logoUrl: 'https://ink.example/logo.png' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain('500');
    googleFails = false;
    const ok = await call(owner, 'PUT', '/google', { issuerId: '3388000000012345678', serviceAccountJson, logoUrl: 'https://ink.example/logo.png' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().clientEmail).toBe('wallet@proj.iam.gserviceaccount.com');
    const cls = google.find((g) => g.url.endsWith('/loyaltyClass') && g.method === 'POST')!.body as Record<string, unknown>;
    expect(cls).toMatchObject({ id: expect.stringMatching(/^3388000000012345678\.card-/), programName: 'Ink Booth stamps', issuerName: 'Ink Booth', programLogo: { sourceUri: { uri: 'https://ink.example/logo.png' } } });
    expect((await call(owner, 'GET', '/settings')).json().google).toMatchObject({ issuerId: '3388000000012345678', clientEmail: 'wallet@proj.iam.gserviceaccount.com' });
    expect((await call(staff, 'PUT', '/google', { issuerId: '3388000000012345678', serviceAccountJson })).statusCode).toBe(403);
  });

  it('puts a save link on the card page, signed for this origin and carrying the pass', async () => {
    const card = await pub('GET', `/p/loyalty/c/${code}`);
    const m = /href="(https:\/\/pay\.google\.com\/gp\/v\/save\/[^"]+)"/.exec(card.body);
    expect(m).not.toBeNull();
    const jwt = m![1]!.split('/').pop()!;
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
    expect(payload).toMatchObject({ aud: 'google', typ: 'savetowallet', iss: 'wallet@proj.iam.gserviceaccount.com', origins: ['https://till.example.test'] });
    const obj = payload.payload.loyaltyObjects[0];
    expect(obj).toMatchObject({ id: `3388000000012345678.${memberId}`, state: 'ACTIVE', accountId: code, accountName: 'Ana', loyaltyPoints: { label: 'Stamps', balance: { int: 8 } }, barcode: { type: 'QR_CODE', value: `https://till.example.test/p/loyalty/c/${code}`, alternateText: code } });
  });

  it('brings the pass up to date after a sale, and reports when Google will not take it', async () => {
    google.length = 0;
    await push([op('t7', 'tx.create', sale('t7', 10, [memberLine(memberId)]))]);
    await new Promise((r) => setTimeout(r, 50));
    const posted = google.find((g) => g.url.endsWith('/loyaltyObject') && g.method === 'POST');
    expect(posted?.body).toMatchObject({ id: `3388000000012345678.${memberId}`, loyaltyPoints: { balance: { int: 10 } } });
    google.length = 0;
    await push([op('t8', 'tx.create', sale('t8', 10, [memberLine(memberId)]))]);
    await new Promise((r) => setTimeout(r, 50));
    const patched = google.find((g) => g.method === 'PATCH');
    expect(patched?.body).toMatchObject({ loyaltyPoints: { balance: { int: 12 } }, secondaryLoyaltyPoints: { balance: { int: 4 } } });

    googleFails = true;
    await push([op('t9', 'tx.create', sale('t9', 10, [memberLine(memberId)]))]);
    await new Promise((r) => setTimeout(r, 50));
    const problems = (await app.inject({ method: 'GET', url: '/api/problems', headers: auth(owner) })).json().problems as { kind: string; resolvedAt: number | null; message: string }[];
    expect(problems.find((p) => p.kind === 'loyalty.google' && !p.resolvedAt)?.message).toBe('Google Wallet is not taking card updates');
    googleFails = false;
    await push([op('t10', 'tx.create', sale('t10', 10, [memberLine(memberId)]))]);
    await new Promise((r) => setTimeout(r, 50));
    const after = (await app.inject({ method: 'GET', url: '/api/problems', headers: auth(owner) })).json().problems as { kind: string; resolvedAt: number | null }[];
    expect(after.find((p) => p.kind === 'loyalty.google')?.resolvedAt).toBeTruthy();
  });

  it('is removed with its key', async () => {
    expect((await call(owner, 'DELETE', '/google')).statusCode).toBe(200);
    expect((await call(owner, 'GET', '/settings')).json().google).toBeNull();
    expect((await pub('GET', `/p/loyalty/c/${code}`)).body).not.toContain('Add to Google Wallet');
  });
});

describe('erasure', () => {
  it('takes the member, their ledger and their card page', async () => {
    expect((await call(staff, 'DELETE', `/members/${memberId}`)).statusCode).toBe(403);
    expect((await call(owner, 'DELETE', `/members/${memberId}`)).statusCode).toBe(200);
    expect((await call(owner, 'GET', '/members')).json().members).toHaveLength(0);
    expect((await pub('GET', `/p/loyalty/c/${code}`)).statusCode).toBe(404);
    expect((await call(staff, 'GET', `/lookup?code=${code}`)).statusCode).toBe(404);
    expect(app.zollify.db.prepare('SELECT COUNT(*) AS n FROM loyalty_ledger').get()).toEqual({ n: 0 });
  });
});
