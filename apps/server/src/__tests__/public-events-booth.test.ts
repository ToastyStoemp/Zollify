import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '@zollify/server-core';
import { publicEventsServerModule } from '../modules/public-events';

/**
 * Booth facts live on the event now. The page must read them from there, fall
 * back to the legacy overlay where the event has none, and keep escaping.
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

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-booth-'));
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.OWNER_PASSWORD = OWNER_PASSWORD;
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

  const push = await app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: auth(),
    payload: {
      deviceId: 'dev-1',
      ops: [
        // own: booth on the event, a different one in the overlay
        eventOp(1, 'own', { booth: { hall: '9', number: 'Z-1', link: 'https://own.example', note: 'From event' } }),
        // legacy: nothing on the event, everything in the overlay
        eventOp(2, 'legacy', {}),
        // mixed: hall on the event, booth number only in the overlay
        eventOp(3, 'mixed', { booth: { hall: '7' } }),
        // hostile: markup and a javascript: link on the event
        eventOp(4, 'evil', { booth: { hall: '<b>1</b>', number: '"><img src=x>', link: 'javascript:alert(1)', note: '<script>alert(1)</script>' } }),
      ],
    },
  });
  expect(push.statusCode).toBe(200);

  await app.inject({ method: 'PUT', url: '/api/m/public-events/config', headers: auth(), payload: { slug: 'booth-test' } });
  const put = (id: string, payload: object) =>
    app.inject({ method: 'PUT', url: `/api/m/public-events/overlay/${id}`, headers: auth(), payload });
  await put('own', { hall: '3', booth: 'B-12', link: 'https://overlay.example', blurb: 'From overlay' });
  await put('legacy', { hall: '4', booth: 'C-2', link: 'https://legacy.example', blurb: 'Legacy blurb' });
  await put('mixed', { hall: '1', booth: 'D-5' });
});

afterAll(async () => {
  try {
    app.zollify?.db?.close();
  } catch {
    /* already closed */
  }
  await app.close();
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

  it('uses the overlay when the event has nothing, so nothing disappears', async () => {
    expect(await upcoming('legacy')).toMatchObject({ hall: '4', booth: 'C-2', link: 'https://legacy.example', blurb: 'Legacy blurb' });
  });

  it('resolves field by field', async () => {
    expect(await upcoming('mixed')).toMatchObject({ hall: '7', booth: 'D-5' });
  });

  it('shows hall and booth in the page, calendar and bio as before', async () => {
    const page = (await app.inject({ method: 'GET', url: base })).body;
    expect(page).toContain('Hall 9 · Booth Z-1');
    expect(page).toContain('Hall 4 · Booth C-2');
    const ics = (await app.inject({ method: 'GET', url: `${base}/events.ics` })).body;
    expect(ics).toContain('Booth: Z-1');
    const bio = (await app.inject({ method: 'GET', url: `${base}/instagram.txt` })).body;
    expect(bio).toContain('hall 9 booth Z-1');
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
