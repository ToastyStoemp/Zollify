import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Transporter } from 'nodemailer';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Webhook } from '@zollify/shared';
import { buildGateway } from '../app';
import { createMailer, type Mailer, type MailMessage } from '../mailer';
import { checkDeployStatus, parseDeployStatus } from '../deploy-status';
import { reportProblem, type ServerModule } from '../modules/mount';
import {
  DAY_MS,
  RETENTION_MS,
  createProblems,
  decideReport,
  digestDue,
  expired,
  nextStreak,
  reasonOf,
  sanitizeText,
  streakOpens,
  type Problem,
  type ProblemInput,
} from '../problems';

/**
 * Problems are how an owner hears that something quietly failed. What matters:
 * repeats are one row, a success closes it, the bell and the email digest are
 * rate limited, only owners and admins of the account see them, and a row
 * never holds a secret or a payload.
 */

describe('decisions (pure)', () => {
  const now = 10 * DAY_MS;

  it('inserts a new problem and updates an open one', () => {
    expect(decideReport(null, 'warning', null, now)).toMatchObject({ action: 'insert', severity: 'warning', escalated: false, notify: false });
    expect(decideReport({ severity: 'warning' }, 'warning', null, now)).toMatchObject({ action: 'update', escalated: false, notify: false });
  });

  it('rings for a new error and for a warning that escalates, never for a repeat', () => {
    expect(decideReport(null, 'error', null, now).notify).toBe(true);
    expect(decideReport({ severity: 'warning' }, 'error', null, now)).toMatchObject({ severity: 'error', escalated: true, notify: true });
    expect(decideReport({ severity: 'error' }, 'error', null, now).notify).toBe(false);
  });

  it('never drops an open error back to a warning', () => {
    expect(decideReport({ severity: 'error' }, 'warning', null, now)).toMatchObject({ severity: 'error', escalated: false, notify: false });
  });

  it('rings at most once a day per source', () => {
    expect(decideReport(null, 'error', now - DAY_MS + 1000, now).notify).toBe(false);
    expect(decideReport(null, 'error', now - DAY_MS, now).notify).toBe(true);
  });

  it('counts a failure streak and opens at the threshold', () => {
    let s = 0;
    for (let i = 0; i < 3; i++) s = nextStreak(s, false);
    expect(s).toBe(3);
    expect(streakOpens(2, 3)).toBe(false);
    expect(streakOpens(3, 3)).toBe(true);
    expect(streakOpens(1, undefined)).toBe(true);
    expect(nextStreak(s, true)).toBe(0);
  });

  it('keeps resolved problems for 30 days, and sends one digest a day', () => {
    expect(expired(null, now)).toBe(false);
    expect(expired(now - RETENTION_MS + 1000, now)).toBe(false);
    expect(expired(now - RETENTION_MS - 1000, now)).toBe(true);
    expect(digestDue(null, now)).toBe(true);
    expect(digestDue(now - DAY_MS + 1000, now)).toBe(false);
    expect(digestDue(now - DAY_MS, now)).toBe(true);
  });

  it('strips secrets, links, addresses and tokens from text', () => {
    const dirty = `Failed for ana@example.test at https://hooks.example.test/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX with Bearer abc123 and key key_${'live'}_51H8abcdefghijklmnopqrstuvwxyz`;
    const clean = sanitizeText(dirty, 300);
    expect(clean).not.toMatch(/ana@|hooks\.example|abc123|key_live/);
    expect(clean).toContain('[email]');
    expect(sanitizeText('word '.repeat(100), 20)).toHaveLength(20);
    expect(sanitizeText('line one\r\nline two', 100)).toBe('line one line two');
  });

  it('reduces a failure to a status or a coarse class', () => {
    expect(reasonOf(503)).toBe('HTTP 503');
    expect(reasonOf(null, new Error('getaddrinfo ENOTFOUND secret-host.example.test'))).toBe('Address did not resolve');
    expect(reasonOf(null, 'Timed out.')).toBe('Timed out');
    expect(reasonOf(null, new Error('boom for ana@example.test'))).toBe('Failed');
  });

  it('reads the deploy script status', () => {
    expect(parseDeployStatus('state=failed\nstep=backup\nbackup=failed\nat=1700000000\n')).toEqual({ state: 'failed', step: 'backup', backup: 'failed', at: 1_700_000_000_000 });
    expect(parseDeployStatus('state=ok\nstep=done\nbackup=skipped\nat=1\n')?.backup).toBe('skipped');
    expect(parseDeployStatus('state=weird')).toBeNull();
    expect(parseDeployStatus('state=failed\nstep=$(rm -rf)\nat=1')?.step).toBe('unknown');
  });
});

// ── With a gateway ──────────────────────────────────────────────────────────

const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let accountId: string;
let receiver: Server;
let base = '';
let failWith = 0;
let mailFails = false;
const sentMail: MailMessage[] = [];
let n = 0;

const auth = (t = owner) => ({ authorization: `Bearer ${t}` });
const settle = () => new Promise((r) => setTimeout(r, 200));
const sale = (total: number) => ({
  opId: `op-prob-${String(++n).padStart(10, '0')}`,
  deviceId: 'd',
  ts: n,
  type: 'tx.create',
  payload: { id: `t${n}`, eventId: 'e1', deviceId: 'd', timestamp: Date.now(), method: 'cash', payments: [{ kind: 'cash', amount: total }], items: [{ pid: 'p', vid: null, title: 'Fox print', qty: 1, unitPrice: total, lineTotal: total }], discounts: [], total, currency: 'CHF' },
});
const push = (ops: unknown[]) => app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(), payload: { deviceId: 'd', ops } });
const list = async (t = owner): Promise<{ problems: Problem[]; openErrors: number; openWarnings: number; emailDigest: boolean }> => (await app.inject({ method: 'GET', url: '/api/problems', headers: auth(t) })).json();
const open = async (kind: string) => (await list()).problems.filter((p) => p.kind === kind && p.resolvedAt == null);
const bellTitles = async (): Promise<string[]> => (await app.inject({ method: 'GET', url: '/api/notifications', headers: auth() })).json().notifications.map((x: { title: string }) => x.title);
const register = async (email: string, invite: Record<string, unknown>): Promise<string> => {
  const code = (await app.inject({ method: 'POST', url: '/api/invites', headers: auth(), payload: invite })).json().code;
  return (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: PASSWORD, inviteCode: code } })).json().accessToken;
};

/** A module that mails and reports, as a real one would through its context. */
let onOpsThrows = false;
const probe: ServerModule = {
  id: 'probe',
  onOps: () => {
    if (onOpsThrows) throw new Error('module blew up on a payload for ana@example.test');
  },
  routes: (ctx) => async (r) => {
    r.post('/mail', async (req) => ({ ok: await ctx.mail.send({ to: (req.body as { to?: string } | null)?.to ?? 'someone@example.test', accountId: ctx.identity(req).accountId, subject: 's', text: 't' }) }));
    r.post('/report', async (req) => {
      reportProblem(ctx, ctx.identity(req).accountId, req.body as ProblemInput);
      return { ok: true };
    });
  },
};

const flakyTransport = {
  sendMail: async (msg: MailMessage & { to: string }) => {
    if (mailFails) throw Object.assign(new Error('535 authentication failed for secret-user@mail.example.test'), { code: 'EAUTH' });
    sentMail.push(msg);
    return {};
  },
} as unknown as Transporter;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.statusCode = failWith || 204;
      res.end('{"secret":"response-body-secret"}');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  dataDir = mkdtempSync(join(tmpdir(), 'zollify-problems-'));
  process.env.OWNER_EMAIL = 'owner@problems.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.WEBHOOK_ALLOW_PRIVATE = '1';
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [probe],
    defaultModules: ['probe'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
    mailer: createMailer({ from: 'Zollify <no-reply@problems.test>', transport: flakyTransport }),
  });
  await app.ready();
  owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@problems.test', password: PASSWORD } })).json().accessToken;
  accountId = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth() })).json().user.accountId;
  await push([{ opId: 'op-prob-event-0000001', deviceId: 'd', ts: 0, type: 'event.upsert', payload: { id: 'e1', name: 'Zurich shop', venue: {}, currency: 'CHF', status: 'active', updatedAt: 1 } }]);
});

beforeEach(() => {
  failWith = 0;
  mailFails = false;
  sentMail.length = 0;
});

afterAll(async () => {
  await app.close();
  receiver.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
  delete process.env.REQUIRE_CAPTCHA;
});

describe('problems service', () => {
  const svc = () => app.zollify.problems;
  const rows = (kind: string) => app.zollify.db.prepare('SELECT * FROM problems WHERE accountId = ? AND kind = ? ORDER BY firstSeen').all(accountId, kind) as (Problem & { notifiedAt: number | null })[];

  it('dedupes repeats of the same kind and key into one row, and keys apart', () => {
    for (let i = 0; i < 4; i++) svc().report(accountId, { kind: 't.dedupe', key: 'a', message: 'Source A failing' });
    svc().report(accountId, { kind: 't.dedupe', key: 'b', message: 'Source B failing' });
    const all = rows('t.dedupe');
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.key === 'a')).toMatchObject({ count: 4, severity: 'warning', resolvedAt: null });
    expect(all.find((r) => r.key === 'b')!.count).toBe(1);
  });

  it('closes a problem when its source succeeds, and a later failure is a new row', () => {
    svc().report(accountId, { kind: 't.resolve', message: 'Failing' });
    svc().resolve(accountId, 't.resolve');
    expect(rows('t.resolve')[0]!.resolvedAt).not.toBeNull();
    svc().report(accountId, { kind: 't.resolve', message: 'Failing again' });
    const all = rows('t.resolve');
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ count: 1, resolvedAt: null });
  });

  it('opens only on the Nth failure in a row, and a success resets the streak', () => {
    const input = { kind: 't.streak', key: 'dev', message: 'Keeps failing', after: 3 };
    svc().report(accountId, input);
    svc().report(accountId, input);
    expect(rows('t.streak')).toHaveLength(0);
    svc().resolve(accountId, 't.streak', 'dev');
    svc().report(accountId, input);
    svc().report(accountId, input);
    expect(rows('t.streak')).toHaveLength(0);
    svc().report(accountId, input);
    expect(rows('t.streak')).toHaveLength(1);
  });

  it('prunes resolved problems after 30 days and keeps open ones', () => {
    const db = app.zollify.db;
    svc().report(accountId, { kind: 't.prune', key: 'old', message: 'Old and done' });
    svc().report(accountId, { kind: 't.prune', key: 'recent', message: 'Recent and done' });
    svc().report(accountId, { kind: 't.prune', key: 'open', message: 'Still open' });
    svc().resolve(accountId, 't.prune', 'old');
    svc().resolve(accountId, 't.prune', 'recent');
    db.prepare("UPDATE problems SET resolvedAt = ? WHERE kind = 't.prune' AND key = 'old'").run(Date.now() - RETENTION_MS - DAY_MS);
    svc().prune();
    expect(rows('t.prune').map((r) => r.key).sort()).toEqual(['open', 'recent']);
  });

  it('never stores a secret, an address or a payload, whatever the caller passes', () => {
    svc().report(accountId, {
      kind: 't.secrets',
      message: 'Sending to ana@example.test failed',
      detail: `POST https://hooks.example.test/services/T0/B0/abcdefghijklmnopqrstuvwxyz0123 answered {"token":"key_${'live'}_51H8abcdefghijklmnopqrstuvwxyz"}`,
      link: 'https://evil.example.test/steal',
    });
    const row = rows('t.secrets')[0]!;
    const stored = JSON.stringify(row);
    expect(stored).not.toMatch(/ana@example|hooks\.example|abcdefghijklmnopqrstuvwxyz|key_live|evil\.example/);
    expect(row.link).toBeNull();
  });

  it('never throws, even with a broken database state', () => {
    expect(() => svc().report('no-such-account', { kind: 't.nothrow', message: 'x' })).not.toThrow();
    expect(() => svc().report(accountId, { kind: '', message: 'x' })).not.toThrow();
  });
});

describe('notification throttling and the email digest', () => {
  const db = () => app.zollify.db;
  const fresh = (mail: Mailer = { enabled: false, send: async () => false }) => {
    const rung: { accountId: string; title: string }[] = [];
    const p = createProblems(db(), { notify: (a, nn) => void rung.push({ accountId: a, title: nn.title }), mail: () => mail });
    return { p, rung };
  };

  it('rings for a new error, not for repeats, and not again within a day', () => {
    const { p, rung } = fresh();
    p.report(accountId, { kind: 't.ring', key: 'x', severity: 'error', message: 'It broke' });
    for (let i = 0; i < 5; i++) p.report(accountId, { kind: 't.ring', key: 'x', severity: 'error', message: 'It broke' });
    expect(rung).toHaveLength(1);
    expect(rung[0]!.title).toContain('It broke');

    // Dismissed and failing again the same day: the same news, so quiet.
    const id = p.list(accountId, { open: true }).find((r) => r.kind === 't.ring')!.id;
    expect(p.dismiss(accountId, id)).toBe(true);
    p.report(accountId, { kind: 't.ring', key: 'x', severity: 'error', message: 'It broke' });
    expect(rung).toHaveLength(1);

    // A day on, it may ring again.
    db().prepare("UPDATE problems SET notifiedAt = ? WHERE kind = 't.ring'").run(Date.now() - 2 * DAY_MS);
    p.dismiss(accountId, p.list(accountId, { open: true }).find((r) => r.kind === 't.ring')!.id);
    p.report(accountId, { kind: 't.ring', key: 'x', severity: 'error', message: 'It broke' });
    expect(rung).toHaveLength(2);
    p.stop();
  });

  it('stays quiet for a warning and rings when it escalates', () => {
    const { p, rung } = fresh();
    p.report(accountId, { kind: 't.escalate', message: 'Slow' });
    p.report(accountId, { kind: 't.escalate', message: 'Slow' });
    expect(rung).toHaveLength(0);
    p.report(accountId, { kind: 't.escalate', severity: 'error', message: 'Down' });
    expect(rung).toHaveLength(1);
    expect(p.list(accountId, { open: true }).find((r) => r.kind === 't.escalate')).toMatchObject({ severity: 'error', count: 3, message: 'Down' });
    p.stop();
  });

  it('emails the owner one digest of new errors a day, and respects the opt-out', async () => {
    const mails: MailMessage[] = [];
    const mail: Mailer = { enabled: true, send: async (m) => (mails.push(m), true) };
    const { p } = fresh(mail);
    db().prepare('DELETE FROM problems').run();
    db().prepare('DELETE FROM problem_settings').run();
    p.report(accountId, { kind: 't.digest', key: '1', severity: 'error', message: 'First thing broke' });
    p.report(accountId, { kind: 't.digest', key: 'w', severity: 'warning', message: 'Just a warning' });
    expect(await p.sendDigests()).toBe(1);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe('owner@problems.test');
    expect(mails[0]!.text).toContain('First thing broke');
    expect(mails[0]!.text).not.toContain('Just a warning');

    // Nothing new: nothing sent. Something new the same day: still not before a day is up.
    expect(await p.sendDigests()).toBe(0);
    p.report(accountId, { kind: 't.digest', key: '2', severity: 'error', message: 'Second thing broke' });
    expect(await p.sendDigests()).toBe(0);
    expect(await p.sendDigests(Date.now() + DAY_MS + 1000)).toBe(1);
    expect(mails[1]!.text).toContain('Second thing broke');
    expect(mails[1]!.text).not.toContain('First thing broke');

    // Opted out.
    expect((await app.inject({ method: 'PUT', url: '/api/problems/settings', headers: auth(), payload: { emailDigest: false } })).statusCode).toBe(200);
    p.report(accountId, { kind: 't.digest', key: '3', severity: 'error', message: 'Third thing broke' });
    expect(await p.sendDigests(Date.now() + 3 * DAY_MS)).toBe(0);
    expect((await list()).emailDigest).toBe(false);
    await app.inject({ method: 'PUT', url: '/api/problems/settings', headers: auth(), payload: { emailDigest: true } });
    p.stop();
  });

  it('keeps an error for tomorrow when the digest could not be sent', async () => {
    const { p } = fresh({ enabled: true, send: async () => false });
    db().prepare('DELETE FROM problems').run();
    db().prepare('DELETE FROM problem_settings').run();
    p.report(accountId, { kind: 't.digest-fail', severity: 'error', message: 'Broke' });
    expect(await p.sendDigests()).toBe(0);
    const ok = fresh({ enabled: true, send: async () => true });
    expect(await ok.p.sendDigests(Date.now() + DAY_MS + 1000)).toBe(1);
    p.stop();
    ok.p.stop();
  });
});

describe('who sees problems', () => {
  it('is for owners and admins of the account; staff see nothing and change nothing', async () => {
    app.zollify.problems.report(accountId, { kind: 't.perm', severity: 'error', message: 'Visible to admins' });
    const id = (await open('t.perm'))[0]!.id;
    const staff = await register('staff@problems.test', { role: 'member' });
    const admin = await register('admin@problems.test', { role: 'admin' });

    expect((await app.inject({ method: 'GET', url: '/api/problems', headers: auth(staff) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/problems/${id}/dismiss`, headers: auth(staff) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/problems/settings', headers: auth(staff), payload: { emailDigest: false } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/problems' })).statusCode).toBe(401);

    expect((await list(admin)).problems.some((p) => p.id === id)).toBe(true);
    // The digest switch is the owner's.
    expect((await app.inject({ method: 'PUT', url: '/api/problems/settings', headers: auth(admin), payload: { emailDigest: false } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/problems/${id}/dismiss`, headers: auth(admin) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/problems/${id}/dismiss`, headers: auth(admin) })).statusCode).toBe(404);
    // Staff do not hear the notification either.
    app.zollify.problems.report(accountId, { kind: 't.perm2', severity: 'error', message: 'Only for admins' });
    const bell = (await app.inject({ method: 'GET', url: '/api/notifications', headers: auth(staff) })).json().notifications.map((x: { title: string }) => x.title);
    expect(bell.some((t: string) => t.includes('Only for admins'))).toBe(false);
  });

  it('keeps one account out of another', async () => {
    app.zollify.problems.report(accountId, { kind: 't.tenant', severity: 'error', message: 'Mine' });
    const id = (await open('t.tenant'))[0]!.id;
    const other = await register('other@problems.test', { newAccount: true, role: 'admin' });
    expect((await list(other)).problems.some((p) => p.id === id)).toBe(false);
    expect((await app.inject({ method: 'POST', url: `/api/problems/${id}/dismiss`, headers: auth(other) })).statusCode).toBe(404);
    expect((await open('t.tenant')).length).toBe(1);
  });
});

describe('end to end', () => {
  async function hook(body: Record<string, unknown>): Promise<Webhook> {
    const res = await app.inject({ method: 'POST', url: '/api/webhooks', headers: auth(), payload: { timeZone: 'UTC', format: 'json', ...body } });
    expect(res.statusCode).toBe(201);
    return res.json().webhook;
  }

  it('a failing webhook warns after 3 failures, errors when switched off, and clears when it delivers again', async () => {
    const h = await hook({ name: 'Flaky chat', url: `${base}/flaky`, events: ['sale'] });
    failWith = 500;
    for (let i = 0; i < 2; i++) await push([sale(5)]);
    await settle();
    expect(await open('webhook')).toHaveLength(0);

    await push([sale(5)]);
    await settle();
    const warn = (await open('webhook'))[0]!;
    expect(warn).toMatchObject({ severity: 'warning', message: 'Webhook "Flaky chat" keeps failing', link: '/settings?panel=core.webhooks' });
    expect(warn.detail).toContain('HTTP 500');
    // Neither the address nor what the other side answered is kept.
    expect(JSON.stringify(warn)).not.toMatch(/127\.0\.0\.1|response-body-secret|flaky/);
    expect((await list()).openWarnings).toBeGreaterThan(0);

    // Delivering again closes it.
    failWith = 0;
    await push([sale(5)]);
    await settle();
    expect(await open('webhook')).toHaveLength(0);

    // Keeps failing until it switches itself off: an error, with the existing note under the bell.
    failWith = 500;
    for (let i = 0; i < 20; i++) await push([sale(5)]);
    await new Promise((r) => setTimeout(r, 1500));
    const off = (await open('webhook'))[0]!;
    expect(off.severity).toBe('error');
    expect(off.message).toContain('switched off');
    expect((await list()).openErrors).toBeGreaterThan(0);
    expect(await bellTitles()).toContain('Webhook "Flaky chat" switched off');

    // Switching it back on is a fresh start.
    await app.inject({ method: 'PUT', url: `/api/webhooks/${h.id}`, headers: auth(), payload: { name: h.name, url: h.url, format: h.format, events: h.events, timeZone: 'UTC', enabled: true } });
    expect(await open('webhook')).toHaveLength(0);
    await app.inject({ method: 'DELETE', url: `/api/webhooks/${h.id}`, headers: auth() });
  });

  it('deleting a failing webhook closes its problem', async () => {
    const h = await hook({ name: 'Doomed', url: `${base}/doomed`, events: ['sale'] });
    failWith = 500;
    for (let i = 0; i < 3; i++) await push([sale(5)]);
    await settle();
    expect(await open('webhook')).toHaveLength(1);
    await app.inject({ method: 'DELETE', url: `/api/webhooks/${h.id}`, headers: auth() });
    expect(await open('webhook')).toHaveLength(0);
  });

  it('a failing mailer opens an error once, tells the bell once, and a delivered mail closes it', async () => {
    app.zollify.db.prepare("DELETE FROM problems WHERE kind = 'email'").run();
    app.zollify.db.prepare('UPDATE notifications SET readAt = 1').run();
    mailFails = true;
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/m/probe/mail', headers: auth() });
      expect(res.json()).toEqual({ ok: false });
    }
    const problem = (await open('email'))[0]!;
    expect(problem).toMatchObject({ severity: 'error', count: 3 });
    expect(JSON.stringify(problem)).not.toMatch(/secret-user|someone@example|EAUTH|535/);
    expect((await bellTitles()).filter((t) => t.startsWith('Needs attention: Email could not be sent'))).toHaveLength(1);

    mailFails = false;
    expect((await app.inject({ method: 'POST', url: '/api/m/probe/mail', headers: auth() })).json()).toEqual({ ok: true });
    expect(sentMail).toHaveLength(1);
    expect(await open('email')).toHaveLength(0);
  });

  it('a malformed recipient is not a mail outage', async () => {
    app.zollify.db.prepare("DELETE FROM problems WHERE kind = 'email'").run();
    mailFails = true;
    const res = await app.inject({ method: 'POST', url: '/api/m/probe/mail', headers: auth(), payload: { to: 'not an address' } });
    expect(res.json()).toEqual({ ok: false });
    expect(await open('email')).toHaveLength(0);
  });

  it('a module reports through its context', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/m/probe/report', headers: auth(), payload: { kind: 'job.probe', message: 'A job crashed', severity: 'error', detail: 'Failed' } });
    expect(res.statusCode).toBe(200);
    expect((await open('job.probe'))[0]).toMatchObject({ severity: 'error', message: 'A job crashed' });
  });

  it('a device whose pushes keep crashing a module shows after 3, and clears when they stop', async () => {
    onOpsThrows = true;
    for (let i = 0; i < 2; i++) expect((await push([sale(7)])).statusCode).toBe(200);
    expect(await open('sync')).toHaveLength(0);
    expect((await push([sale(7)])).statusCode).toBe(200);
    const p = (await open('sync'))[0]!;
    expect(p).toMatchObject({ severity: 'warning', key: 'd' });
    expect(JSON.stringify(p)).not.toMatch(/ana@|blew up/);
    onOpsThrows = false;
    await push([sale(7)]);
    expect(await open('sync')).toHaveLength(0);
  });

  it('reads the deploy script status into problems for the server owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zollify-deploy-'));
    const db = app.zollify.db;
    const p = app.zollify.problems;
    const openOf = (kind: string) => db.prepare('SELECT severity FROM problems WHERE accountId = ? AND kind = ? AND resolvedAt IS NULL').all(accountId, kind);

    writeFileSync(join(dir, 'status'), 'state=failed\nstep=health\nbackup=failed\nat=1700000000\n');
    checkDeployStatus(db, dir, p);
    expect(openOf('server.update')).toHaveLength(1);
    expect(openOf('server.backup')).toHaveLength(1);

    writeFileSync(join(dir, 'status'), 'state=ok\nstep=done\nbackup=ok\nat=1700000100\n');
    checkDeployStatus(db, dir, p);
    expect(openOf('server.update')).toHaveLength(0);
    expect(openOf('server.backup')).toHaveLength(0);

    // A request nobody picked up.
    writeFileSync(join(dir, 'requested'), 'x');
    checkDeployStatus(db, dir, p, Date.now() + 20 * 60_000);
    expect(openOf('server.update')).toHaveLength(1);
    checkDeployStatus(db, join(dir, 'missing'), p);
    expect(openOf('server.update')).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
