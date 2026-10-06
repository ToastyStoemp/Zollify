import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WireOp } from '@zollify/shared';
import { buildGateway } from '../app';
import type { ServerModule } from '../modules/mount';
import { setEnabled } from '../modules/entitlements';

/**
 * Staff accounts sell; they do not run the store. Their screens hide the
 * rest, but the server is what makes it true - and what makes "who sold
 * this" something a staff member cannot fake.
 */

const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let staff: string;
let accountId: string;
const seen: { accountId: string; types: string[] }[] = [];

// A module that watches pushes and writes back, the way consignment does.
const watcher: ServerModule = {
  id: 'watcher',
  routes: () => async () => {},
  onOps(ctx, acct, ops: WireOp[]) {
    seen.push({ accountId: acct, types: ops.map((o) => o.type) });
    if (ops.some((o) => o.type === 'tx.create')) ctx.writeOps(acct, [{ type: 'setting.upsert', payload: { key: 'watcher.saw', value: true, updatedAt: 1 } }]);
  },
};

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
let n = 0;
const op = (type: string, payload: unknown) => ({ opId: `op-staff-${String(++n).padStart(10, '0')}`, deviceId: 'd', ts: n, type, payload });
const pull = async () =>
  (await app.inject({ method: 'GET', url: '/api/sync/pull?since=0', headers: auth(owner) })).json().ops as { type: string; deviceId: string; payload: Record<string, unknown> }[];

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-staff-'));
  process.env.OWNER_EMAIL = 'owner@shop.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [watcher],
    defaultModules: [],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@shop.test', password: PASSWORD } });
  owner = login.json().accessToken;
  accountId = login.json().user.accountId;
  setEnabled(app.zollify.db, accountId, 'watcher', true);
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'member' } });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'sam@shop.test', password: PASSWORD, inviteCode: invite.json().code } });
  staff = reg.json().accessToken;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('staff accounts', () => {
  it('can sell and claim stock, but not change the catalogue, prices or settings', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: auth(staff),
      payload: {
        deviceId: 'till-2',
        ops: [
          op('product.upsert', { id: 'p1', title: 'Cheap now', price: 1, updatedAt: 9 }),
          op('discount.upsert', { id: 'd1', name: '100% off', updatedAt: 9 }),
          op('setting.upsert', { key: 'x', value: 1, updatedAt: 9 }),
          op('tx.create', { id: 't1', eventId: 'zh', items: [], total: 10, currency: 'CHF', soldBy: { userId: 'someone-else', email: 'boss@shop.test' } }),
          op('stock.set', { eventId: 'zh', productId: 'p1', variantId: '', broughtQty: 2, updatedAt: 9 }),
        ],
      },
    });
    expect(res.json()).toMatchObject({ accepted: 2 });
    const types = (await pull()).filter((o) => !o.deviceId.startsWith('server:')).map((o) => o.type);
    expect(types).toEqual(['tx.create', 'stock.set']);
  });

  it('stamps the real seller on a staff sale, whatever the device said', async () => {
    const sale = (await pull()).find((o) => o.type === 'tx.create')!;
    expect(sale.payload.soldBy).toMatchObject({ email: 'sam@shop.test' });
    expect((sale.payload.soldBy as { userId: string }).userId).not.toBe('someone-else');
  });

  it("stamps an admin's sale too, unless it already names someone (an import)", async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: auth(owner),
      payload: { deviceId: 'till-1', ops: [op('tx.create', { id: 't2', items: [] }), op('tx.create', { id: 't3', items: [], soldBy: { userId: 'old', email: 'old@shop.test' } })] },
    });
    const sales = (await pull()).filter((o) => o.type === 'tx.create');
    expect(sales.find((o) => o.payload.id === 't2')?.payload.soldBy).toMatchObject({ email: 'owner@shop.test' });
    expect(sales.find((o) => o.payload.id === 't3')?.payload.soldBy).toMatchObject({ email: 'old@shop.test' });
  });

  it('lets a module follow pushes and write back as the server', async () => {
    expect(seen.map((s) => s.types)).toContainEqual(['tx.create', 'stock.set']);
    const written = (await pull()).filter((o) => o.deviceId === 'server:watcher');
    expect(written.length).toBeGreaterThan(0);
    expect(written[0]?.payload).toMatchObject({ key: 'watcher.saw' });
  });
});
