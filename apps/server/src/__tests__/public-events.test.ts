import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled } from '@zollify/server-core';
import { publicEventsServerModule } from '../modules/public-events';

/**
 * The public half runs with no session, so the things worth proving are the
 * gates: an unknown slug is nothing, a disabled module is nothing, and what
 * does come out is embeddable from another origin.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;
let token: string;

const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-pubev-'));
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

  // Two events through the real sync path, so the page reads the op-log.
  const push = await app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: auth(),
    payload: {
      deviceId: 'dev-1',
      ops: [
        {
          opId: 'op-0000000000000001',
          deviceId: 'dev-1',
          ts: 1,
          type: 'event.upsert',
          payload: {
            id: 'ev-far',
            name: 'Far Future Con',
            dateStart: '2099-05-01',
            dateEnd: '2099-05-03',
            venue: { city: 'Zürich', country: 'Switzerland' },
            currency: 'CHF',
            status: 'planned',
            updatedAt: 1,
          },
        },
        {
          opId: 'op-0000000000000002',
          deviceId: 'dev-1',
          ts: 2,
          type: 'event.upsert',
          payload: {
            id: 'ev-old',
            name: 'Old Con',
            dateStart: '2001-01-01',
            venue: {},
            currency: 'CHF',
            status: 'closed',
            updatedAt: 1,
          },
        },
      ],
    },
  });
  expect(push.statusCode).toBe(200);
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

describe('public events', () => {
  it('is unpublished until a slug is chosen', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/m/public-events/preview', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().published).toBe(false);
    expect(res.json().base).toBeNull();
  });

  it('refuses a malformed slug', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/m/public-events/config',
      headers: auth(),
      payload: { slug: 'Not Valid!' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('publishes at the chosen address', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/m/public-events/config',
      headers: auth(),
      payload: { slug: 'harbour-prints', tagline: 'Where to find us', pastLimit: 5 },
    });
    expect(res.statusCode).toBe(200);

    const overlay = await app.inject({
      method: 'PUT',
      url: '/api/m/public-events/overlay/ev-far',
      headers: auth(),
      payload: { hall: '3', booth: 'B-12', igHandle: '@farcon' },
    });
    expect(overlay.statusCode).toBe(200);
  });

  it('serves the page, the feed, the widget and the bio without a session', async () => {
    const page = await app.inject({ method: 'GET', url: '/p/public-events/harbour-prints' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Far Future Con');
    expect(page.body).toContain('Booth B-12');
    expect(page.body).toContain('Old Con'); // past section
    // Calendar toggle: the data island carries the same event (incl. hall/booth
    // for the calendar tooltip), and calendar.js is referenced same-origin.
    expect(page.body).toContain('id="zev-data"');
    expect(page.body).toContain('"name":"Far Future Con"');
    expect(page.body).toContain('"booth":"B-12"');
    expect(page.body).toContain('/p/public-events/harbour-prints/calendar.js"');

    const calendarJs = await app.inject({ method: 'GET', url: '/p/public-events/harbour-prints/calendar.js' });
    expect(calendarJs.statusCode).toBe(200);
    expect(calendarJs.headers['content-type']).toContain('javascript');
    expect(calendarJs.body).toContain('initCalendar');
    // Cross-origin embedding is the point, so the isolation headers are relaxed here.
    expect(page.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(page.headers['access-control-allow-origin']).toBe('*');

    const json = await app.inject({ method: 'GET', url: '/p/public-events/harbour-prints/events.json' });
    expect(json.json().upcoming[0].id).toBe('ev-far');
    // Nothing but display fields leaves.
    expect(json.json().upcoming[0]).not.toHaveProperty('currency');

    const embed = await app.inject({ method: 'GET', url: '/p/public-events/harbour-prints/embed.js' });
    expect(embed.headers['content-type']).toContain('javascript');
    expect(embed.body).toContain('/p/public-events/harbour-prints"');

    const ics = await app.inject({ method: 'GET', url: '/p/public-events/harbour-prints/events.ics' });
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.body).toContain('SUMMARY:Far Future Con');

    const bio = await app.inject({ method: 'GET', url: '/p/public-events/harbour-prints/instagram.txt' });
    expect(bio.body).toContain('@farcon, hall 3 booth B-12, 1-3rd May');
  });

  it('is nothing at an unknown slug', async () => {
    const res = await app.inject({ method: 'GET', url: '/p/public-events/nobody-here' });
    expect(res.statusCode).toBe(404);
  });

  it('goes dark the moment the module is switched off', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth() });
    setEnabled(app.zollify.db, me.json().user.accountId, 'public-events', false);

    const res = await app.inject({ method: 'GET', url: '/p/public-events/harbour-prints' });
    expect(res.statusCode).toBe(404);
  });
});
