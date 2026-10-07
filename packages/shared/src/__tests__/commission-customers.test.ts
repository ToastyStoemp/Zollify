import { describe, expect, it } from 'vitest';
import { DAY_MS, closedAtOf, decideErase, eraseCommission, findDuplicates, groupForMigration, phoneKey, totalOwed } from '../commission-customers';
import type { Commission } from '../commissions';

const c = (id: string, email: string, phone: string) => ({ id, email, phone });

describe('findDuplicates', () => {
  const existing = [c('a', 'Mira@Example.test', '+41 79 555 01 02'), c('b', '', '044 123 45 67'), c('c', 'other@example.test', '')];

  it('matches the email in any case, and the phone on digits only', () => {
    expect(findDuplicates({ email: 'mira@example.TEST', phone: '' }, existing).map((x) => x.id)).toEqual(['a']);
    expect(findDuplicates({ email: '', phone: '044-123 45.67' }, existing).map((x) => x.id)).toEqual(['b']);
    expect(findDuplicates({ email: '', phone: '+41795550102' }, existing).map((x) => x.id)).toEqual(['a']);
  });

  it('matches nothing without an email or a usable phone, and never on a blank', () => {
    expect(findDuplicates({ email: '', phone: '' }, existing)).toEqual([]);
    expect(findDuplicates({ email: '', phone: '12' }, [c('x', '', '12')])).toEqual([]);
    expect(findDuplicates({ email: '', phone: '' }, [c('x', '', '')])).toEqual([]);
    expect(findDuplicates({ email: 'new@example.test', phone: '' }, existing)).toEqual([]);
  });

  it('reports every match, not just one', () => {
    expect(findDuplicates({ email: 'other@example.test', phone: '0441234567' }, existing).map((x) => x.id)).toEqual(['b', 'c']);
  });
});

describe('phoneKey', () => {
  it('keeps digits and drops numbers too short to mean anything', () => {
    expect(phoneKey('+41 79 555 01 02')).toBe('41795550102');
    expect(phoneKey('123')).toBe('');
  });
});

describe('groupForMigration', () => {
  it('groups by email (any case), else by phone digits, else one each', () => {
    const groups = groupForMigration([
      c('1', 'Mira@x.test', '079 555 01 02'),
      c('2', 'mira@X.test', ''),
      c('3', '', '+41 79 555 01 02'),
      c('4', '', '0795550102'),
      c('5', '', ''),
      c('6', '', ''),
      c('7', 'other@x.test', '0795550102'),
    ]);
    // A commission with an email is grouped by it, never by its phone; different digits are different numbers.
    expect(groups).toEqual([['1', '2'], ['3'], ['4'], ['5'], ['6'], ['7']]);
  });

  it('puts two commissions with the same phone and no email together', () => {
    expect(groupForMigration([c('1', '', '079 555 01 02'), c('2', '', '079-5550102'), c('3', '', '')])).toEqual([['1', '2'], ['3']]);
  });
});

const NOW = Date.UTC(2026, 5, 30);
const closed = (daysAgo: number, status: 'collected' | 'cancelled' = 'collected') => ({ status, closedAt: NOW - daysAgo * DAY_MS });

describe('decideErase', () => {
  const base = { createdAt: NOW - 400 * DAY_MS, keepFrom: 0, now: NOW, retentionDays: 30 };

  it('keeps a customer with any open commission, however old the others are', () => {
    const d = decideErase({ ...base, commissions: [closed(200), { status: 'in_progress', closedAt: 0 }] });
    expect(d).toEqual({ erase: false, needed: true, dueAt: null });
  });

  it('erases once the last commission closed the retention ago', () => {
    expect(decideErase({ ...base, commissions: [closed(31), closed(60)] }).erase).toBe(true);
    expect(decideErase({ ...base, commissions: [closed(29), closed(60)] }).erase).toBe(false);
    expect(decideErase({ ...base, commissions: [closed(30)] }).erase).toBe(true);
    expect(decideErase({ ...base, commissions: [closed(10, 'cancelled')] }).dueAt).toBe(NOW + 20 * DAY_MS);
  });

  it('restarts the clock from the latest close', () => {
    expect(decideErase({ ...base, commissions: [closed(100), closed(1)] }).erase).toBe(false);
  });

  it('with 0 days erases as soon as everything is closed', () => {
    expect(decideErase({ ...base, retentionDays: 0, commissions: [closed(0)] }).erase).toBe(true);
    expect(decideErase({ ...base, retentionDays: 0, commissions: [{ status: 'requested', closedAt: 0 }] }).erase).toBe(false);
  });

  it('counts from the migration time when that is later', () => {
    const d = decideErase({ ...base, keepFrom: NOW - 1 * DAY_MS, commissions: [closed(200)] });
    expect(d.erase).toBe(false);
    expect(d.dueAt).toBe(NOW + 29 * DAY_MS);
  });

  it('a customer with no commissions is counted from when they were added', () => {
    expect(decideErase({ ...base, createdAt: NOW - 5 * DAY_MS, commissions: [] }).erase).toBe(false);
    expect(decideErase({ ...base, createdAt: NOW - 45 * DAY_MS, commissions: [] }).erase).toBe(true);
  });
});

const commission = (over: Partial<Commission> = {}): Commission => ({
  id: 'x',
  customerId: 'cust',
  customerErasedAt: null,
  title: 'Fox',
  description: 'for my daughter Anna',
  currency: 'EUR',
  price: 100,
  depositAsked: 20,
  dueDate: '2026-02-01',
  notes: 'allergic to cats',
  status: 'collected',
  createdAt: 1,
  updatedAt: 9,
  createdBy: 'u',
  updates: [
    { id: 'u1', at: 1, status: 'requested', changed: true, message: '' },
    { id: 'u2', at: 5, status: 'accepted', changed: true, message: 'Hi Anna, yes' },
    { id: 'u3', at: 7, status: 'collected', changed: true, message: 'Thanks!' },
    { id: 'u4', at: 8, status: 'collected', changed: false, message: 'late note' },
  ],
  ...over,
});

describe('closedAtOf', () => {
  it('is the step that closed it, not a later message', () => {
    expect(closedAtOf(commission())).toBe(7);
  });
  it('falls back to the last touch when no step closed it', () => {
    expect(closedAtOf(commission({ updates: [] }))).toBe(9);
  });
});

describe('eraseCommission', () => {
  it('clears free text and the link to the customer, keeps what the books need, and is idempotent', () => {
    const e = eraseCommission(commission(), 99);
    expect(e).toMatchObject({ customerId: null, customerErasedAt: 99, notes: '', description: '', title: 'Fox', price: 100, depositAsked: 20, dueDate: '2026-02-01', status: 'collected', createdAt: 1 });
    expect(e.updates.map((u) => [u.at, u.status, u.changed, u.message])).toEqual([
      [1, 'requested', true, ''],
      [5, 'accepted', true, ''],
      [7, 'collected', true, ''],
      [8, 'collected', false, ''],
    ]);
    expect(eraseCommission(e, 200)).toEqual(e);
  });
});

describe('totalOwed', () => {
  it('adds the balances of the commissions, but a cancelled one owes nothing', () => {
    expect(totalOwed([{ status: 'in_progress', balance: 50.1 }, { status: 'ready', balance: 20.2 }, { status: 'cancelled', balance: 40 }, { status: 'collected', balance: 0 }])).toBe(70.3);
    expect(totalOwed([])).toBe(0);
  });
});
