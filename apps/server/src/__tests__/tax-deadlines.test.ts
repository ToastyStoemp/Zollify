import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, type MailMessage } from '@zollify/server-core';
import { accountSinceDay, sendDeadlineReminders, taxDeadlinesServerModule } from '../modules/tax-deadlines';

/**
 * Reminders are the point of the module: they must come at the lead times
 * picked, once each, never for a deadline ticked off, and not at night.
 */

const PASSWORD = 'correct horse battery staple';
const sent: MailMessage[] = [];
let app: FastifyInstance;
let dataDir: string;
let token: string;
let accountId: string;

const call = (method: 'GET' | 'PUT', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/tax-deadlines${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
const raised: { accountId: string; title: string }[] = [];
const notes = (): string[] => raised.filter((n) => n.accountId === accountId).map((n) => n.title);
const services = () => ({
  db: app.zollify.db,
  notify: (a: string, n: { title: string }) => void raised.push({ accountId: a, title: n.title }),
  mail: { enabled: true, send: async (m: MailMessage) => (sent.push(m), true) },
  webhooks: { emit: () => undefined },
  writeOps: () => 0,
});
// 10:00 in Berlin (UTC+2 in summer).
const at = (day: string, hour = 10) => Date.parse(`${day}T${String(hour - 2).padStart(2, '0')}:00:00Z`);

const SETTINGS = {
  profile: { country: 'DE', region: 'BY', legalForm: 'sole', vat: 'regular', vatFrequency: 'monthly', extension: false, advisor: false, tradeTax: false },
  reminders: { leadDays: [3, 14, 14], email: true, overdue: true, timeZone: 'Europe/Berlin' },
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-deadlines-'));
  process.env.OWNER_EMAIL = 'owner@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [taxDeadlinesServerModule],
    defaultModules: ['tax-deadlines'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
    mailer: { enabled: true, send: async (m) => (sent.push(m), true) },
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.test', password: PASSWORD } });
  token = login.json().accessToken;
  accountId = login.json().user.accountId;
  // Deadlines count from the account's creation day; pin it so the 2026 dates below stay this account's.
  app.zollify.db.prepare('UPDATE accounts SET createdAt = ? WHERE id = ?').run(Date.parse('2026-01-01T12:00:00Z'), accountId);
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('tax deadlines', () => {
  it('starts unconfigured and reminds about nothing', async () => {
    const res = await call('GET', '/state');
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.configured).toBe(false);
  });

  it('refuses an unknown time zone', async () => {
    const res = await call('PUT', '/settings', { ...SETTINGS, reminders: { ...SETTINGS.reminders, timeZone: 'Mars/Olympus' } });
    expect(res.statusCode).toBe(400);
  });

  it('saves settings with lead days cleaned up, and says when the account started', async () => {
    const res = await call('PUT', '/settings', { ...SETTINGS, since: '2020-01-01' });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({ configured: true, reminders: { leadDays: [14, 3] } });
    // `since` is the account's own creation day, whatever the client sent.
    expect(res.json().settings.since).toBe('2026-01-01');
    expect(accountSinceDay(app.zollify.db, accountId, 'Europe/Berlin')).toBe('2026-01-01');
  });

  it('reminds at the first lead time, once, and not at night', async () => {
    const svc = services() as unknown as Parameters<typeof sendDeadlineReminders>[0];
    // The September VAT return is due Monday 12 October 2026 (the 10th is a Saturday).
    expect(await sendDeadlineReminders(svc, at('2026-09-27'))).toBe(0);
    expect(await sendDeadlineReminders(svc, at('2026-09-28', 6))).toBe(0);
    expect(await sendDeadlineReminders(svc, at('2026-09-28'))).toBe(1);
    expect(notes()).toEqual(['VAT return September 2026 due in 14 days']);
    expect(sent.at(-1)).toMatchObject({ to: 'owner@example.test', subject: 'VAT return September 2026 due in 14 days' });
    expect(sent.at(-1)!.text).toContain('The law says Sat, 10 Oct 2026');
    expect(await sendDeadlineReminders(svc, at('2026-09-28', 15))).toBe(0);

    // Ticked off: no more reminders for it.
    const done = await call('PUT', '/done/de.vat-return:2026-09', { done: true });
    expect(done.json().done.map((d: { id: string }) => d.id)).toContain('de.vat-return:2026-09');
    expect(await sendDeadlineReminders(svc, at('2026-10-09'))).toBe(0);

    // Unticked: the three-day reminder comes after all.
    await call('PUT', '/done/de.vat-return:2026-09', { done: false });
    expect(await sendDeadlineReminders(svc, at('2026-10-09'))).toBe(1);
    expect(notes().at(-1)).toBe('VAT return September 2026 due in 3 days');
  });

  it('reminds about nothing from before the account existed', async () => {
    const svc = services() as unknown as Parameters<typeof sendDeadlineReminders>[0];
    const db = app.zollify.db;
    // An account created on 13 October 2026 has the September return (due 12 October) behind it already.
    db.prepare('UPDATE accounts SET createdAt = ? WHERE id = ?').run(Date.parse('2026-10-13T12:00:00Z'), accountId);
    try {
      expect(await sendDeadlineReminders(svc, at('2026-10-13'))).toBe(0);
      expect(notes().some((t) => t.startsWith('Overdue'))).toBe(false);
      // The October return (due 10 November) is this account's: its two-week reminder comes.
      expect(await sendDeadlineReminders(svc, at('2026-10-27'))).toBe(1);
      expect(notes().at(-1)).toBe('VAT return October 2026 due in 14 days');
    } finally {
      db.prepare('UPDATE accounts SET createdAt = ? WHERE id = ?').run(Date.parse('2026-01-01T12:00:00Z'), accountId);
    }
  });

  it('rejects odd deadline ids', async () => {
    const res = await call('PUT', '/done/not%20an%20id', { done: true });
    expect(res.statusCode).toBe(400);
  });
});
