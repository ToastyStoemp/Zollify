import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, setEnabled, type MailMessage } from '@zollify/server-core';
import { CUSTOMER_REMOVED_LABEL, DAY_MS } from '@zollify/shared';
import { commissionsServerModule, migrateCustomers, sweepCustomers } from '../modules/commissions';

/**
 * Customers of commissions hold a person's name, email and phone, so the tests
 * pin the whole life of that data: one record picked or added from the form, a
 * gentle offer instead of a duplicate, every commission of a customer in one
 * place, and the erasure once nothing is open - what it clears, what it keeps,
 * that it never runs early, and that the public page never needed any of it.
 */

const PASSWORD = 'correct horse battery staple';
const sent: MailMessage[] = [];
let app: FastifyInstance;
let dataDir: string;
let owner: string;
let staff: string;
let accountId: string;
let seq = 0;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (t: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/m/commissions${url}`, headers: auth(t), ...(payload ? { payload } : {}) });
const pay = (txId: string, commissionId: string, amount: number) =>
  app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: auth(owner),
    payload: {
      deviceId: 'till',
      ops: [
        {
          opId: `op-customers-test-${String(++seq).padStart(6, '0')}`,
          deviceId: 'till',
          ts: seq,
          type: 'tx.create',
          payload: {
            id: txId,
            eventId: 'shop',
            deviceId: 'till',
            timestamp: Date.now(),
            method: 'cash',
            payments: [],
            discounts: [],
            total: amount,
            currency: 'EUR',
            items: [{ pid: `module:commission:${commissionId}`, vid: null, title: 'Deposit', qty: 1, unitPrice: amount, lineTotal: amount, ref: { moduleId: 'commissions', kind: 'commission', id: commissionId } }],
          },
        },
      ],
    },
  });

const ANA = { name: 'Ana Ruiz', email: 'ana@example.test', phone: '+41 78 111 22 33' };
const BEN = { name: 'Ben Frei', email: 'ben@example.test', phone: '' };
const PIECE = { title: 'Heron', description: 'for my daughter Lea, her room is blue', price: 100, depositAsked: 20, dueDate: '2099-05-01', notes: 'Ana is allergic to cats' };
const make = async (over: Record<string, unknown>, t = staff) => {
  const res = await call(t, 'POST', '/commissions', { ...PIECE, ...over });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};
const move = (id: string, status: string, message = '') => call(staff, 'POST', `/commissions/${id}/updates`, { status, message });
const customerIds = () => (app.zollify.db.prepare('SELECT id FROM commission_customers WHERE accountId = ?').all(accountId) as { id: string }[]).map((r) => r.id);
const later = (days: number) => Date.now() + days * DAY_MS + 60_000;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zollify-commission-customers-'));
  process.env.OWNER_EMAIL = 'shop@example.test';
  process.env.OWNER_PASSWORD = PASSWORD;
  process.env.REQUIRE_CAPTCHA = '0';
  app = await buildGateway({
    dataDir,
    moduleStoreDir: join(dataDir, 'modules'),
    jwtSecret: 'test-secret-value-long-enough-for-signing',
    serverModules: [commissionsServerModule],
    defaultModules: ['commissions'],
    allowedOrigins: [],
    requireHttps: false,
    trustProxy: false,
    logLevel: 'silent',
    mailer: { enabled: true, send: async (m) => (sent.push(m), true) },
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'shop@example.test', password: PASSWORD } });
  owner = login.json().accessToken;
  accountId = login.json().user.accountId;
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'member' } });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'staff@example.test', password: PASSWORD, inviteCode: invite.json().code } });
  staff = reg.json().accessToken;
  await app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: auth(owner),
    payload: { deviceId: 'till', ops: [{ opId: 'op-customers-test-shop', deviceId: 'till', ts: 1, type: 'event.upsert', payload: { id: 'shop', name: 'Shop', kind: 'store', venue: {}, currency: 'EUR', status: 'active', updatedAt: 1 } }] },
  });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.REQUIRE_CAPTCHA;
});

describe('adding and picking customers', () => {
  let ana = '';

  it('a new customer is typed in the same form and kept once, off the commission', async () => {
    const c = await make({ customer: ANA });
    ana = c.customerId;
    expect(ana).toBeTruthy();
    // The owner's view joins the details in, as before.
    expect(c).toMatchObject({ customerName: 'Ana Ruiz', email: 'ana@example.test', phone: '+41 78 111 22 33' });
    const stored = app.zollify.db.prepare('SELECT doc FROM commissions WHERE id = ?').get(c.id) as { doc: string };
    for (const detail of ['Ana Ruiz', 'ana@example.test', '111 22 33']) expect(stored.doc).not.toContain(detail);
    expect(customerIds()).toContain(ana);
  });

  it('offers the existing customer instead of a duplicate, on email in any case or phone digits', async () => {
    const before = customerIds().length;
    const byEmail = await call(staff, 'POST', '/commissions', { ...PIECE, customer: { name: 'Ana R.', email: 'ANA@Example.TEST' } });
    expect(byEmail.statusCode).toBe(409);
    expect(byEmail.json()).toMatchObject({ error: 'customer_exists', matches: [{ id: ana, name: 'Ana Ruiz', email: 'ana@example.test', phone: '+41 78 111 22 33' }] });
    const byPhone = await call(staff, 'POST', '/commissions', { ...PIECE, customer: { name: 'Ana', phone: '0041 78 111 22 33'.replace('0041', '+41') } });
    expect(byPhone.statusCode).toBe(409);
    expect(byPhone.json().matches[0].id).toBe(ana);
    // Nothing was created or merged by asking.
    expect(customerIds()).toHaveLength(before);
    // A different person is simply added.
    expect((await call(staff, 'POST', '/commissions', { ...PIECE, customer: { name: 'Someone', email: 'someone@example.test' } })).statusCode).toBe(201);
  });

  it('the seller can still add the duplicate on purpose, or pick the existing customer', async () => {
    const before = customerIds().length;
    const forced = await make({ customer: { name: 'Ana Ruiz', email: 'ana@example.test' }, forceNewCustomer: true });
    expect(forced.customerId).not.toBe(ana);
    expect(customerIds()).toHaveLength(before + 1);
    const picked = await make({ customerId: ana, title: 'Second piece' });
    expect(picked).toMatchObject({ customerId: ana, customerName: 'Ana Ruiz' });
    expect(customerIds()).toHaveLength(before + 1);
  });

  it('refuses an unknown customer and a request with both or neither', async () => {
    expect((await call(staff, 'POST', '/commissions', { ...PIECE, customerId: 'nope' })).statusCode).toBe(400);
    expect((await call(staff, 'POST', '/commissions', { ...PIECE })).statusCode).toBe(400);
    expect((await call(staff, 'POST', '/commissions', { ...PIECE, customerId: ana, customer: ANA })).statusCode).toBe(400);
  });

  it('staff can correct a customer\'s details', async () => {
    const res = await call(staff, 'PUT', `/customers/${ana}`, { name: 'Ana Ruiz-Meyer', email: 'ana@example.test', phone: '+41 78 111 22 33' });
    expect(res.statusCode).toBe(200);
    expect((await call(staff, 'GET', '/commissions')).json().commissions.find((c: { customerId: string }) => c.customerId === ana).customerName).toBe('Ana Ruiz-Meyer');
    await call(staff, 'PUT', `/customers/${ana}`, ANA);
    expect((await call(staff, 'PUT', '/customers/nope', ANA)).statusCode).toBe(404);
    expect((await call(staff, 'PUT', `/customers/${ana}`, { name: '' })).statusCode).toBe(400);
  });
});

describe('search', () => {
  it('finds by name, email or phone digits, needs two characters and returns contact fields only', async () => {
    const find = async (q: string) => (await call(staff, 'GET', `/customers/search?q=${encodeURIComponent(q)}`)).json().customers as { id: string; name: string }[];
    expect((await find('ruiz')).map((c) => c.name)).toContain('Ana Ruiz');
    expect((await find('ANA@exam')).length).toBeGreaterThan(0);
    expect((await find('78 111')).length).toBeGreaterThan(0);
    expect((await find('78-111-22')).length).toBeGreaterThan(0);
    expect(await find('a')).toEqual([]);
    expect(await find('zzzzzz')).toEqual([]);
    expect(Object.keys((await find('ruiz'))[0]!).sort()).toEqual(['email', 'id', 'name', 'phone']);
    // % and _ are not wildcards.
    expect(await find('%%')).toEqual([]);
    expect(await find('r_iz')).toEqual([]);
  });

  it('never returns another account\'s customers', async () => {
    const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { newAccount: true } });
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'other@example.test', password: PASSWORD, inviteCode: invite.json().code, accountName: 'Other' } });
    setEnabled(app.zollify.db, reg.json().user.accountId, 'commissions', true);
    const other = reg.json().accessToken as string;
    await make({ customer: { name: 'Zora Zeller', email: 'zora@example.test', phone: '+41 79 000 11 22' } }, other);
    expect((await call(other, 'GET', '/customers/search?q=ruiz')).json().customers).toEqual([]);
    expect((await call(other, 'GET', '/customers/search?q=zora')).json().customers).toHaveLength(1);
    expect((await call(staff, 'GET', '/customers/search?q=zora')).json().customers).toEqual([]);
    expect((await call(staff, 'GET', '/customers')).json().customers.map((c: { name: string }) => c.name)).not.toContain('Zora Zeller');
    // Her customer cannot be read, changed or erased from this account.
    const zora = (await call(other, 'GET', '/customers')).json().customers[0].id as string;
    expect((await call(owner, 'GET', `/customers/${zora}`)).statusCode).toBe(404);
    expect((await call(owner, 'PUT', `/customers/${zora}`, ANA)).statusCode).toBe(404);
    expect((await call(owner, 'POST', `/customers/${zora}/erase`)).statusCode).toBe(404);
    // A same-named pick is refused too: ids are looked up inside the account.
    expect((await call(staff, 'POST', '/commissions', { ...PIECE, customerId: zora })).statusCode).toBe(400);

  });
});

describe('one customer, several commissions', () => {
  it('lists them all with status, price, paid, balance and the total still owed', async () => {
    const first = await make({ customer: BEN, title: 'Owl', price: 120 });
    const customerId = first.customerId as string;
    const second = await make({ customerId, title: 'Fox', price: 80 });
    const third = await make({ customerId, title: 'Hare', price: 50 });
    await pay('tx-owl', first.id, 40);
    await pay('tx-fox', second.id, 80);
    await move(second.id, 'collected');
    await pay('tx-hare', third.id, 10);
    await move(third.id, 'cancelled');

    const res = (await call(staff, 'GET', `/customers/${customerId}`)).json();
    expect(res.customer).toMatchObject({ name: 'Ben Frei', commissionCount: 3, openCount: 1, owed: 80 });
    const by = Object.fromEntries(res.commissions.map((c: { title: string }) => [c.title, c]));
    expect(by.Owl).toMatchObject({ status: 'requested', price: 120, paid: 40, balance: 80 });
    expect(by.Fox).toMatchObject({ status: 'collected', paid: 80, balance: 0 });
    // A cancelled one is still listed, but nothing is owed on it.
    expect(by.Hare).toMatchObject({ status: 'cancelled', paid: 10, balance: 40 });
    expect(res.customer.erasesAt).toBeNull();

    const list = (await call(staff, 'GET', '/customers')).json();
    expect(list.keepCustomerDays).toBe(30);
    expect(list.customers.find((c: { id: string }) => c.id === customerId)).toMatchObject({ owed: 80, openCount: 1 });
  });
});

describe('erasing after the last commission closes', () => {
  /** A customer with the given statuses; returns their id and commissions. */
  async function customer(person: { name: string; email: string; phone?: string }, steps: string[][]) {
    const made = [];
    let customerId: string | undefined;
    for (const [i, path] of steps.entries()) {
      const c = await make({ ...(customerId ? { customerId } : { customer: person }), title: `Piece ${i}`, description: `private description of ${person.name}`, notes: `private note about ${person.name}` });
      customerId = c.customerId;
      for (const status of path) await move(c.id, status, `Message to ${person.name} for ${status}`);
      made.push(c);
    }
    return { customerId: customerId!, ids: made.map((c) => c.id as string), token: made[0].token as string };
  }
  const setDays = (days: number) => call(owner, 'PUT', '/settings', { keepCustomerDays: days });
  const exists = (id: string) => !!app.zollify.db.prepare('SELECT 1 FROM commission_customers WHERE id = ?').get(id);

  it('keeps the details for the retention period, then erases them, keeping what the books need', async () => {
    await setDays(30);
    const cara = await customer({ name: 'Cara Vogt', email: 'cara@example.test', phone: '+41 76 222 33 44' }, [['accepted', 'collected'], ['cancelled']]);
    await pay('tx-cara', cara.ids[0]!, 60);
    const before = (await call(owner, 'GET', `/commissions/${cara.ids[0]}`)).json();

    // Closed just now: not yet.
    expect(sweepCustomers(app.zollify.db, Date.now())).toBe(0);
    expect(sweepCustomers(app.zollify.db, later(29))).toBe(0);
    expect(exists(cara.customerId)).toBe(true);
    const detail = (await call(staff, 'GET', `/customers/${cara.customerId}`)).json();
    expect(detail.customer.openCount).toBe(0);
    expect(detail.customer.erasesAt).toBeGreaterThan(Date.now() + 29 * DAY_MS);

    const now = later(31);
    const page = (await app.inject({ method: 'GET', url: before.publicPath })).body;
    expect(sweepCustomers(app.zollify.db, now)).toBeGreaterThanOrEqual(1);
    expect(exists(cara.customerId)).toBe(false);

    const after = (await call(owner, 'GET', `/commissions/${cara.ids[0]}`)).json();
    // Cleared: name, email, phone, internal notes, details, messages, the link to the customer.
    expect(after).toMatchObject({ customerName: CUSTOMER_REMOVED_LABEL, email: '', phone: '', customerId: null, notes: '', description: '' });
    expect(after.customerErasedAt).toBeGreaterThan(0);
    expect(after.updates.every((u: { message: string }) => u.message === '')).toBe(true);
    // Kept: title, price, amounts paid from sales, dates, status, timeline steps, link.
    expect(after).toMatchObject({ title: before.title, price: before.price, paid: 60, balance: before.balance, status: 'collected', dueDate: before.dueDate, createdAt: before.createdAt, token: before.token });
    expect(after.updates.map((u: { at: number; status: string }) => [u.at, u.status])).toEqual(before.updates.map((u: { at: number; status: string }) => [u.at, u.status]));
    expect(after.payments).toHaveLength(1);
    const dump = JSON.stringify(app.zollify.db.prepare('SELECT doc FROM commissions WHERE accountId = ?').all(accountId));
    for (const gone of ['Cara', 'cara@example.test', '222 33 44', 'private description of Cara', 'private note about Cara', 'Message to Cara']) expect(dump).not.toContain(gone);
    // The second commission was cleared too, and the public page still works and shows the same.
    expect((await call(owner, 'GET', `/commissions/${cara.ids[1]}`)).json()).toMatchObject({ customerName: CUSTOMER_REMOVED_LABEL, notes: '', status: 'cancelled' });
    const pageAfter = await app.inject({ method: 'GET', url: before.publicPath });
    expect(pageAfter.statusCode).toBe(200);
    expect(pageAfter.body).toContain(before.title);
    expect(pageAfter.body).not.toContain('Message to Cara');
    expect(page).toContain('Message to Cara Vogt for collected');
    expect(pageAfter.body).not.toContain('Vogt');
    expect(pageAfter.body).not.toContain(CUSTOMER_REMOVED_LABEL);
  });

  it('a second sweep finds nothing and changes nothing', async () => {
    const dump = () => JSON.stringify(app.zollify.db.prepare('SELECT doc FROM commissions ORDER BY id').all());
    const before = dump();
    expect(sweepCustomers(app.zollify.db, later(31))).toBe(0);
    expect(dump()).toBe(before);
  });

  it('never erases a customer with an open commission, and the clock restarts when a new one closes', async () => {
    await setDays(30);
    const dana = await customer({ name: 'Dana Roth', email: 'dana@example.test' }, [['collected'], ['in_progress']]);
    expect(sweepCustomers(app.zollify.db, later(400))).toBe(0);
    expect(exists(dana.customerId)).toBe(true);
    // Closing the second one starts the clock again from now.
    await move(dana.ids[1]!, 'collected');
    expect(sweepCustomers(app.zollify.db, later(29))).toBe(0);
    expect(sweepCustomers(app.zollify.db, later(31))).toBe(1);
    expect(exists(dana.customerId)).toBe(false);
  });

  it('a new commission before the sweep keeps the customer, and a closed one cannot be reopened', async () => {
    const eli = await customer({ name: 'Eli Brandt', email: 'eli@example.test' }, [['collected']]);
    expect((await move(eli.ids[0]!, 'in_progress')).statusCode).toBe(409);
    const fresh = await make({ customerId: eli.customerId, title: 'Another' });
    expect(sweepCustomers(app.zollify.db, later(60))).toBe(0);
    expect(exists(eli.customerId)).toBe(true);
    await move(fresh.id, 'cancelled');
    expect(sweepCustomers(app.zollify.db, later(60))).toBe(1);
  });

  it('with 0 days erases at the next sweep after the last close', async () => {
    await setDays(0);
    const fay = await customer({ name: 'Fay Hess', email: 'fay@example.test' }, [['cancelled']]);
    const gil = await customer({ name: 'Gil Maurer', email: 'gil@example.test' }, [['accepted']]);
    expect(sweepCustomers(app.zollify.db, Date.now() + 1000)).toBe(1);
    expect(exists(fay.customerId)).toBe(false);
    expect(exists(gil.customerId)).toBe(true);
    await setDays(30);
  });

  it('only acts while the module is on for the account', async () => {
    const hal = await customer({ name: 'Hal Imhof', email: 'hal@example.test' }, [['collected']]);
    setEnabled(app.zollify.db, accountId, 'commissions', false);
    expect(sweepCustomers(app.zollify.db, later(400))).toBe(0);
    expect(exists(hal.customerId)).toBe(true);
    setEnabled(app.zollify.db, accountId, 'commissions', true);
    expect(sweepCustomers(app.zollify.db, later(400))).toBeGreaterThanOrEqual(1);
    expect(exists(hal.customerId)).toBe(false);
  });

  it('the retention setting is an admin\'s, from 0 to 365 days', async () => {
    expect((await call(staff, 'PUT', '/settings', { keepCustomerDays: 5 })).statusCode).toBe(403);
    expect((await call(owner, 'PUT', '/settings', { keepCustomerDays: 366 })).statusCode).toBe(400);
    expect((await call(owner, 'PUT', '/settings', { keepCustomerDays: -1 })).statusCode).toBe(400);
    expect((await call(owner, 'PUT', '/settings', { keepCustomerDays: 365 })).json().keepCustomerDays).toBe(365);
    expect((await call(staff, 'GET', '/settings')).json().keepCustomerDays).toBe(365);
    await setDays(30);
  });

  it('stops emailing once the customer is gone, and breaks nothing', async () => {
    const ivo = await customer({ name: 'Ivo Lenz', email: 'ivo@example.test' }, [['ready']]);
    sent.length = 0;
    expect((await call(staff, 'POST', `/commissions/${ivo.ids[0]}/updates`, { message: 'Hello', email: true })).json().emailed).toBe(true);
    expect(sent[0]).toMatchObject({ to: 'ivo@example.test' });
    await move(ivo.ids[0]!, 'collected');
    expect((await call(owner, 'POST', `/customers/${ivo.customerId}/erase`)).statusCode).toBe(200);
    sent.length = 0;
    const res = await call(staff, 'POST', `/commissions/${ivo.ids[0]}/updates`, { message: 'Thanks again', email: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().emailed).toBe(false);
    expect(sent).toEqual([]);
    expect((await call(staff, 'POST', `/commissions/${ivo.ids[0]}/email-link`)).statusCode).toBe(400);
    expect((await call(staff, 'GET', `/commissions/${ivo.ids[0]}`)).statusCode).toBe(200);
  });
});

describe('erasing by hand', () => {
  const cust = async (person: { name: string; email: string }, status: string) => {
    const c = await make({ customer: person, title: `${person.name} piece` });
    if (status !== 'requested') await move(c.id, status);
    return c.customerId as string;
  };

  it('erase now is for admins, and refused while a commission is open', async () => {
    const open = await cust({ name: 'Jan Open', email: 'jan@example.test' }, 'requested');
    const done = await cust({ name: 'Kim Done', email: 'kim@example.test' }, 'collected');
    expect((await call(staff, 'POST', `/customers/${done}/erase`)).statusCode).toBe(403);
    expect((await call(staff, 'POST', '/customers/erase-closed')).statusCode).toBe(403);
    expect((await call(owner, 'POST', `/customers/${open}/erase`)).statusCode).toBe(409);
    expect((await call(owner, 'POST', `/customers/${done}/erase`)).json()).toMatchObject({ ok: true, commissions: 1 });
    expect((await call(owner, 'GET', `/customers/${done}`)).statusCode).toBe(404);
    expect(customerIds()).toContain(open);
  });

  it('erase all closed customers leaves the open ones, without waiting for the retention period', async () => {
    const open = await cust({ name: 'Lou Open', email: 'lou@example.test' }, 'in_progress');
    const a = await cust({ name: 'Max Closed', email: 'max@example.test' }, 'collected');
    const b = await cust({ name: 'Nia Closed', email: 'nia@example.test' }, 'cancelled');
    const res = (await call(owner, 'POST', '/customers/erase-closed')).json();
    expect(res.erased).toBeGreaterThanOrEqual(2);
    expect(customerIds()).toContain(open);
    expect(customerIds()).not.toContain(a);
    expect(customerIds()).not.toContain(b);
    expect((await call(owner, 'POST', '/customers/erase-closed')).json()).toEqual({ erased: 0 });
  });
});

describe('a shared till', () => {
  it('cannot erase customers even for an admin, but can pick and add them', async () => {
    const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: auth(owner), payload: { role: 'admin' } });
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'admin2@example.test', password: PASSWORD, inviteCode: invite.json().code } });
    const adminId = reg.json().user.id as string;
    const grant = (await app.inject({ method: 'POST', url: '/api/device-users', headers: auth(owner), payload: { deviceId: 'counter2', email: 'admin2@example.test', password: PASSWORD, pin: '4711' } })).json().grant;
    const till = (await app.inject({ method: 'POST', url: '/api/auth/unlock', headers: auth(owner), payload: { deviceId: 'counter2', userId: adminId, pin: '4711', grant } })).json().accessToken as string;
    const target = (await make({ customer: { name: 'Olga Till', email: 'olga@example.test' } })).customerId as string;
    await move((await call(owner, 'GET', `/customers/${target}`)).json().commissions[0].id, 'cancelled');

    expect((await call(till, 'POST', `/customers/${target}/erase`)).statusCode).toBe(403);
    expect((await call(till, 'POST', '/customers/erase-closed')).statusCode).toBe(403);
    expect((await call(till, 'GET', '/customers/search?q=olga')).json().customers).toHaveLength(1);
    expect((await call(till, 'POST', '/commissions', { ...PIECE, customerId: target })).statusCode).toBe(201);
    // The same admin on their own device can.
    const own = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin2@example.test', password: PASSWORD } })).json().accessToken as string;
    expect((await call(own, 'POST', '/customers/erase-closed')).statusCode).toBe(200);
  });
});

describe('what the public page shows', () => {
  it('is built from the same fields as before: no customer name, email, phone or notes, before or after erasure', async () => {
    const c = await make({ customer: { name: 'Pia Zbinden', email: 'pia@example.test', phone: '+41 77 333 44 55' }, title: 'Lynx', notes: 'Pia pays cash' });
    await move(c.id, 'accepted', 'See you soon');
    const html = (await app.inject({ method: 'GET', url: c.publicPath })).body;
    for (const secret of ['Pia', 'Zbinden', 'pia@example.test', '333 44 55', 'Pia pays cash', 'private', c.customerId]) expect(html).not.toContain(secret);
    expect(html).toContain('Lynx');
    expect(html).toContain('See you soon');
    // Closed and erased: the page is the same, only the messages are gone.
    await move(c.id, 'collected');
    await call(owner, 'POST', `/customers/${c.customerId}/erase`);
    const closed = (await app.inject({ method: 'GET', url: c.publicPath })).body;
    expect(closed).toContain('Lynx');
    expect(closed).not.toContain('See you soon');
    expect(closed).not.toContain('Pia');
  });
});

describe('migrating commissions that carry their own details', () => {
  const legacy = (id: string, over: Record<string, unknown>, account = accountId) => {
    const now = Date.now();
    const doc = { id, customerName: 'x', email: '', phone: '', title: id, description: 'd', currency: 'EUR', price: 10, depositAsked: 0, dueDate: '', notes: 'n', status: 'collected', updates: [{ id: `${id}-u`, at: 1000, status: 'collected', changed: true, message: '' }], createdAt: 1000, updatedAt: 1000, createdBy: null, ...over };
    app.zollify.db.prepare('INSERT INTO commissions (accountId, id, doc, token, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(account, id, JSON.stringify(doc), `legacy-token-${id}`.padEnd(32, 'x'), doc.createdAt, doc.updatedAt);
    return now;
  };

  it('groups by email, else phone digits, else one each; sets customerId; keeps working', async () => {
    legacy('old-1', { customerName: 'Quinn Alt', email: 'Quinn@Example.test', phone: '079 555 66 77', updatedAt: 3000 });
    legacy('old-2', { customerName: 'Quinn Alter', email: 'quinn@example.test', updatedAt: 4000 });
    legacy('old-3', { customerName: 'Rue Same', phone: '+41 79 888 99 00' });
    legacy('old-4', { customerName: 'Rue Same', phone: '0041798889900'.replace('0041', '+41') });
    legacy('old-5', { customerName: 'Sam Loner' });
    legacy('old-6', { customerName: 'Sam Loner' });
    const before = customerIds().length;
    const now = Date.now();
    expect(migrateCustomers(app.zollify.db, now)).toBe(4);
    expect(customerIds()).toHaveLength(before + 4);

    const all = (await call(owner, 'GET', '/commissions')).json().commissions as { id: string; customerId: string; customerName: string; email: string; phone: string }[];
    const of = (id: string) => all.find((c) => c.id === id)!;
    expect(of('old-1').customerId).toBe(of('old-2').customerId);
    expect(of('old-3').customerId).toBe(of('old-4').customerId);
    expect(new Set([of('old-1').customerId, of('old-3').customerId, of('old-5').customerId, of('old-6').customerId]).size).toBe(4);
    // The newest commission's name, and the first email and phone found, are kept: nothing is lost.
    expect(of('old-1')).toMatchObject({ customerName: 'Quinn Alter', email: 'quinn@example.test', phone: '079 555 66 77' });
    expect(of('old-3')).toMatchObject({ customerName: 'Rue Same', phone: '+41 79 888 99 00' });
    const doc = JSON.parse((app.zollify.db.prepare('SELECT doc FROM commissions WHERE id = ?').get('old-1') as { doc: string }).doc);
    expect(doc).not.toHaveProperty('customerName');
    expect(doc).not.toHaveProperty('email');
    expect(doc.customerId).toBe(of('old-1').customerId);
    // The customer page lists both of Quinn's.
    const quinn = (await call(owner, 'GET', `/customers/${of('old-1').customerId}`)).json();
    expect(quinn.commissions.map((c: { id: string }) => c.id).sort()).toEqual(['old-1', 'old-2']);
    expect((await app.inject({ method: 'GET', url: `/p/commissions/${'legacy-token-old-1'.padEnd(32, 'x')}` })).statusCode).toBe(200);
  });

  it('is idempotent', () => {
    const before = customerIds().length;
    expect(migrateCustomers(app.zollify.db)).toBe(0);
    expect(customerIds()).toHaveLength(before);
  });

  it('erases nothing on the day of deploy, then follows the retention period from the migration', async () => {
    // These were closed in 1970, far past any retention period; the clock starts at the migration.
    expect(sweepCustomers(app.zollify.db, Date.now())).toBe(0);
    expect(sweepCustomers(app.zollify.db, later(29))).toBe(0);
    const erased = sweepCustomers(app.zollify.db, later(31));
    expect(erased).toBeGreaterThanOrEqual(4);
    const quinn = (await call(owner, 'GET', '/commissions/old-1')).json();
    expect(quinn).toMatchObject({ customerName: CUSTOMER_REMOVED_LABEL, email: '', notes: '', description: '', title: 'old-1', price: 10, status: 'collected' });
  });
});

describe('startup', () => {
  it('migrates at boot and sweeps when the server starts, without erasing migrated customers that day', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zollify-commission-boot-'));
    const options = {
      dataDir: dir,
      moduleStoreDir: join(dir, 'modules'),
      jwtSecret: 'test-secret-value-long-enough-for-signing',
      serverModules: [commissionsServerModule],
      defaultModules: ['commissions'],
      allowedOrigins: [],
      requireHttps: false,
      trustProxy: false,
      logLevel: 'silent' as const,
    };
    try {
      const first = await buildGateway(options);
      await first.ready();
      const acc = (first.zollify.db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: string }).id;
      const insert = (id: string, doc: Record<string, unknown>) =>
        first.zollify.db.prepare('INSERT INTO commissions (accountId, id, doc, token, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, 1)').run(acc, id, JSON.stringify(doc), `boot-${id}`.padEnd(32, 'x'));
      const base = { description: 'd', notes: 'n', currency: 'EUR', price: 5, depositAsked: 0, dueDate: '', title: 't', status: 'collected', createdAt: 1, updatedAt: 1, createdBy: null, updates: [{ id: 'u', at: 1, status: 'collected', changed: true, message: '' }] };
      // One commission from before the feature, and one customer already past retention.
      insert('legacy', { ...base, id: 'legacy', customerName: 'Tia Old', email: 'tia@example.test', phone: '' });
      insert('modern', { ...base, id: 'modern', customerId: 'cust-old', customerErasedAt: null });
      first.zollify.db
        .prepare('INSERT INTO commission_customers (accountId, id, name, email, phone, phoneDigits, keepFrom, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1)')
        .run(acc, 'cust-old', 'Uli Past', 'uli@example.test', '', '');
      await first.close();

      const second = await buildGateway(options);
      await second.ready();
      const names = (second.zollify.db.prepare('SELECT name FROM commission_customers').all() as { name: string }[]).map((r) => r.name);
      // Migrated at boot and kept; the one past retention was erased by the startup sweep.
      expect(names).toEqual(['Tia Old']);
      const modern = JSON.parse((second.zollify.db.prepare("SELECT doc FROM commissions WHERE id = 'modern'").get() as { doc: string }).doc);
      expect(modern).toMatchObject({ customerId: null, notes: '', description: '' });
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('search rate limit', () => {
  // Last: it uses up the window for this address.
  it('is limited, so a typed-in guess cannot be run at speed to list customers', async () => {
    const codes = new Set<number>();
    for (let i = 0; i < 100; i++) codes.add((await call(staff, 'GET', '/customers/search?q=ruiz')).statusCode);
    expect(codes.has(429)).toBe(true);
  });
});
