import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '@zollify/server-core';
import { publicEventsServerModule } from '../modules/public-events';

/**
 * Booth facts live on the event. Legacy overlay values are carried onto their
 * events and cleared from the overlay at startup, so the public output is the
 * same as before for them, and a field the user clears later stays cleared.
 * The legacy rows are written straight into the table (the endpoint no longer
 * accepts them) and the gateway is restarted, the way a real upgrade happens.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });
const base = '/p/public-events/booth-test';

const eventOp = (n: number, id: string, extra: Record<string, unknown>) => ({
  opId: `op-00000000000000${String(n).padStart(2, '0')}`,
  deviceId: 'dev-1',
  ts: n,
  type: 'event.upsert',
  payload: {
    id,
    name: `Con ${id}`,
    dateStart: `2099-0${n}-01`,
    venue: { city: 'Zürich', country: 'Switzerland' },
    currency: 'CHF',
    status: 'planned',
    updatedAt: 1,
    ...extra,
  },
});

const upcoming = async (id: string) => {
  const json = (await app.inject({ method: 'GET', url: `${base}/events.json` })).json();
  return json.upcoming.find((e: { id: string }) => e.id === id);
};

async function boot(): Promise<void> {
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [publicEventsServerModule],
    defaultModules: ['public-events'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'Test' },
  });
  token = login.json().accessToken;
}

async function stop(): Promise<void> {
  try {
    app.zollify?.db?.close();
  } catch {
    /* already closed */
  }
  await app.close();
}

const push = (ops: object[]) => app.inject({ method: 'POST', url: '/api/sync/push', headers: auth(), payload: { deviceId: 'dev-1', ops } });
const db = () => app.zollify.db;
const overlayRow = (id: string) =>
  JSON.parse((db().prepare('SELECT overlay FROM public_events_overlay WHERE eventId = ?').get(id) as { overlay: string }).overlay);
const eventOps = () =>
  db().prepare("SELECT deviceId, payload FROM ops WHERE type = 'event.upsert' ORDER BY seq").all() as { deviceId: string; payload: string }[];

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-booth-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = OWNER_PASSWORD;
  await boot();

  const res = await push([
    // own: booth on the event, a different one in the overlay
    eventOp(1, 'own', { booth: { hall: '9', number: 'Z-1', link: 'https://own.example', note: 'From event' } }),
    // legacy: nothing on the event, everything in the overlay
    eventOp(2, 'legacy', {}),
    // mixed: hall on the event, booth number only in the overlay
    eventOp(3, 'mixed', { booth: { hall: '7' } }),
    // hostile: markup and a javascript: link on the event
    eventOp(4, 'evil', { booth: { hall: '<b>1</b>', number: '"><img src=x>', link: 'javascript:alert(1)', note: '<script>alert(1)</script>' } }),
    // hid: only a legacy hall in the overlay, and hidden from the public
    eventOp(5, 'hid', {}),
  ]);
  expect(res.statusCode).toBe(200);
  await app.inject({ method: 'PUT', url: '/api/m/public-events/config', headers: auth(), payload: { slug: 'booth-test' } });

  // Rows as the old endpoint stored them, then the upgrade restart.
  const now = Date.now();
  const put = (id: string, overlay: object) =>
    db()
      .prepare('INSERT INTO public_events_overlay (accountId, eventId, overlay, updatedAt) SELECT id, ?, ?, ? FROM accounts LIMIT 1')
      .run(id, JSON.stringify(overlay), now);
  put('own', { hall: '3', booth: 'B-12', link: 'https://overlay.example', blurb: 'From overlay', igHandle: '@own', hidden: false });
  put('legacy', { hall: '4', booth: 'C-2', link: 'https://legacy.example', blurb: 'Legacy blurb', igHandle: '@legacycon', hidden: false });
  put('mixed', { hall: '1', booth: 'D-5', link: '', blurb: '', igHandle: '', hidden: false });
  put('hid', { hall: '8', igHandle: '', hidden: true });
  await stop();
  await boot();
});

afterAll(async () => {
  await stop();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
  delete process.env.OWNER_EMAIL;
  delete process.env.OWNER_PASSWORD;
});

describe('public events booth facts', () => {
  it('the event field wins over the overlay', async () => {
    expect(await upcoming('own')).toMatchObject({ hall: '9', booth: 'Z-1', link: 'https://own.example', blurb: 'From event' });
  });

  it('keeps showing what the overlay held, now carried onto the event', async () => {
    expect(await upcoming('legacy')).toMatchObject({ hall: '4', booth: 'C-2', link: 'https://legacy.example', blurb: 'Legacy blurb' });
    expect(await upcoming('mixed')).toMatchObject({ hall: '7', booth: 'D-5' });
    const copied = eventOps().filter((o) => o.deviceId === 'server:public-events').map((o) => JSON.parse(o.payload));
    expect(copied.map((e) => e.id).sort()).toEqual(['hid', 'legacy', 'mixed']);
    expect(copied.find((e) => e.id === 'legacy').booth).toEqual({ hall: '4', number: 'C-2', link: 'https://legacy.example', note: 'Legacy blurb' });
  });

  it('removes the legacy overlay fields but leaves the publishing fields', () => {
    expect(overlayRow('own')).toEqual({ igHandle: '@own', hidden: false });
    expect(overlayRow('legacy')).toEqual({ igHandle: '@legacycon', hidden: false });
    expect(overlayRow('mixed')).toEqual({ igHandle: '', hidden: false });
    expect(overlayRow('hid')).toEqual({ igHandle: '', hidden: true });
  });

  it('still honours the hidden flag and the Instagram handle', async () => {
    expect(await upcoming('hid')).toBeUndefined();
    const json = (await app.inject({ method: 'GET', url: `${base}/events.json` })).json();
    expect(json.upcoming.find((e: { id: string }) => e.id === 'legacy').igHandle).toBe('@legacycon');
  });

  it('shows hall and booth in the page, calendar and bio as before', async () => {
    const page = (await app.inject({ method: 'GET', url: base })).body;
    expect(page).toContain('Hall 9 · Booth Z-1');
    expect(page).toContain('Hall 4 · Booth C-2');
    const ics = (await app.inject({ method: 'GET', url: `${base}/events.ics` })).body;
    expect(ics).toContain('Booth: Z-1');
    expect(ics).toContain('Booth: C-2');
    const bio = (await app.inject({ method: 'GET', url: `${base}/instagram.txt` })).body;
    expect(bio).toContain('hall 9 booth Z-1');
  });

  it('serves the overlay to the client without legacy keys once cleaned', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/m/public-events/config', headers: auth() });
    expect(res.json().overlays.legacy).toEqual({ igHandle: '@legacycon', hidden: false });
  });

  it('is idempotent: another start writes nothing', async () => {
    const before = eventOps().length;
    const rows = ['own', 'legacy', 'mixed', 'hid'].map(overlayRow);
    await stop();
    await boot();
    expect(eventOps().length).toBe(before);
    expect(['own', 'legacy', 'mixed', 'hid'].map(overlayRow)).toEqual(rows);
    expect(await upcoming('legacy')).toMatchObject({ hall: '4', booth: 'C-2' });
  });

  it('a booth field cleared on the event stays cleared', async () => {
    const cleared = eventOp(2, 'legacy', { updatedAt: Date.now() + 10_000, booth: { hall: '4' } });
    const res = await push([{ ...cleared, opId: 'op-clear-00000001' }]);
    expect(res.statusCode).toBe(200);
    expect(await upcoming('legacy')).toMatchObject({ hall: '4', booth: '', link: '', blurb: '' });
    await stop();
    await boot();
    expect(await upcoming('legacy')).toMatchObject({ hall: '4', booth: '', link: '', blurb: '' });
    const page = (await app.inject({ method: 'GET', url: base })).body;
    expect(page).not.toContain('legacy.example');
    expect(page).not.toContain('Legacy blurb');
  });

  it('ignores legacy fields from an older client and still saves the publishing ones', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/m/public-events/overlay/legacy',
      headers: auth(),
      payload: { hall: '99', booth: 'ZZ', link: 'https://old-client.example', blurb: 'stale', igHandle: '@new', hidden: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().overlay).toEqual({ igHandle: '@new', hidden: false });
    expect(overlayRow('legacy')).toEqual({ igHandle: '@new', hidden: false });
    expect(await upcoming('legacy')).toMatchObject({ hall: '4', booth: '', link: '', blurb: '' });
  });

  it('keeps a stored legacy value across a save until it has been carried onto the event', async () => {
    db()
      .prepare('UPDATE public_events_overlay SET overlay = ? WHERE eventId = ?')
      .run(JSON.stringify({ hall: '5', igHandle: '', hidden: false }), 'mixed');
    await app.inject({ method: 'PUT', url: '/api/m/public-events/overlay/mixed', headers: auth(), payload: { igHandle: '@m' } });
    expect(overlayRow('mixed')).toEqual({ hall: '5', igHandle: '@m', hidden: false });
  });

  it('keeps escaping markup and drops an unsafe link', async () => {
    // The JSON data island is a non-executing script block that carries raw strings
    // (only "</" is escaped); everything rendered as markup must be escaped.
    const page = (await app.inject({ method: 'GET', url: base })).body.replace(/<script type="application\/json"[^>]*>.*?<\/script>/s, '');
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).not.toContain('<img src=x>');
    expect(page).not.toContain('javascript:');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).toContain('Hall &lt;b&gt;1&lt;/b&gt;');
    expect((await upcoming('evil')).link).toBe('');
  });
});
