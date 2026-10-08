import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled } from '@zollify/server-core';
import type { AdminAccount, AdminAccountRelation } from '@zollify/shared';
import { consignmentArtistServerModule, consignmentServerModule } from '../modules/consignment';

/**
 * The server owner's admin panel shows how accounts hang together: which
 * invite made an account, and which artist accounts consign to which store.
 */

const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let artistAccountId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-admin-rel-'));
  process.env.OWNER_EMAIL = 'shop@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({ dataDir, moduleStoreDir: join(dataDir, 'modules'), jwtSecret: 'test-secret-value-long-enough-for-signing', serverModules: [consignmentServerModule, consignmentArtistServerModule], defaultModules: ['consignment', 'consignment-artist'], allowedOrigins: [], requireHttps: false, trustProxy: false, logLevel: 'silent', mailer: { enabled: false, send: async () => false } });
  await app.ready();
  owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shop@example.test', password: PASSWORD } })).json().accessToken;

  // The shop invites Ana to Zollify; she makes her own account from it...
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { newAccount: true } });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'ana@example.test', password: PASSWORD, inviteCode: invite.json().code, accountName: 'Ana Draws' } });
  const artist = reg.json().accessToken;
  artistAccountId = reg.json().user.accountId;
  setEnabled(app.zollify.db, artistAccountId, 'consignment', true);
  setEnabled(app.zollify.db, artistAccountId, 'consignment-artist', true);
  // ...and links it to the shop's consignor record for her.
  await app.inject({ method: 'PUT', url: '/api/m/consignment/consignors/ana', headers: auth(owner), payload: { name: 'Ana', commissionPct: 40 } });
  const { code } = (await app.inject({ method: 'POST', url: '/api/m/consignment/consignors/ana/link-code', headers: auth(owner) })).json();
  expect((await app.inject({ method: 'POST', url: '/api/m/consignment-artist/links', headers: auth(artist), payload: { code } })).statusCode).toBeLessThan(300);
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('admin: accounts and how they relate', () => {
  it('marks the account that owns the server and names its admin', async () => {
    const accounts = (await app.inject({ method: 'GET', url: '/api/admin/accounts', headers: auth(owner) })).json() as AdminAccount[];
    expect(accounts.find((a) => a.ownsServer)).toMatchObject({ adminEmail: 'shop@example.test' });
    expect(accounts.find((a) => a.id === artistAccountId)).toMatchObject({ name: 'Ana Draws', ownsServer: false, adminEmail: 'ana@example.test' });
  });

  it('reports the invite that made an account and the consignment link, owner only', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/relations', headers: auth(owner) });
    expect(res.statusCode).toBe(200);
    const { relations } = res.json() as { relations: AdminAccountRelation[] };
    const shop = relations[0]!.from;
    expect(relations).toEqual([
      { from: shop, to: { id: artistAccountId, name: 'Ana Draws' }, kind: 'consignment', label: 'Ana', since: expect.any(Number) },
      { from: shop, to: { id: artistAccountId, name: 'Ana Draws' }, kind: 'invited', label: 'ana@example.test', since: expect.any(Number) },
    ]);
    const artist = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ana@example.test', password: PASSWORD } })).json().accessToken;
    expect((await app.inject({ method: 'GET', url: '/api/admin/relations', headers: auth(artist) })).statusCode).toBe(403);
  });
});
