import { describe, expect, it } from 'vitest';
import { CommissionCreateSchema, CommissionInputSchema, CommissionSettingsSchema, CustomerInputSchema, CommissionUpdateSchema, commissionTotals, isOverdue, nextStatuses } from '../commissions';

describe('commissionTotals', () => {
  it('sums payments to the cent and never goes negative', () => {
    const pay = (amount: number) => ({ saleId: 's', at: 1, amount, label: 'Deposit' });
    expect(commissionTotals(100, [pay(0.1), pay(0.2)])).toMatchObject({ paid: 0.3, balance: 99.7 });
    expect(commissionTotals(100, [pay(150)])).toMatchObject({ paid: 150, balance: 0 });
    expect(commissionTotals(0, [])).toMatchObject({ paid: 0, balance: 0 });
  });
});

describe('isOverdue', () => {
  it('flags an open commission past its due date only', () => {
    expect(isOverdue({ dueDate: '2026-01-01', status: 'in_progress' }, '2026-01-02')).toBe(true);
    expect(isOverdue({ dueDate: '2026-01-02', status: 'in_progress' }, '2026-01-02')).toBe(false);
    expect(isOverdue({ dueDate: '', status: 'accepted' }, '2026-01-02')).toBe(false);
    expect(isOverdue({ dueDate: '2026-01-01', status: 'collected' }, '2026-01-02')).toBe(false);
    expect(isOverdue({ dueDate: '2026-01-01', status: 'cancelled' }, '2026-01-02')).toBe(false);
  });
});

describe('nextStatuses', () => {
  it('offers every other open step, and nothing once closed', () => {
    expect(nextStatuses('requested')).toEqual(['accepted', 'in_progress', 'ready', 'collected', 'cancelled']);
    expect(nextStatuses('collected')).toEqual([]);
    expect(nextStatuses('cancelled')).toEqual([]);
  });
});

describe('input schemas', () => {
  it('a commission needs a title and defaults the rest; it carries no customer details', () => {
    const ok = CommissionInputSchema.parse({ title: 'Fox', customerName: 'Mira', email: 'mira@example.test' });
    expect(ok).toMatchObject({ title: 'Fox', price: 0, dueDate: '', currency: 'EUR' });
    expect(ok).not.toHaveProperty('customerName');
    expect(ok).not.toHaveProperty('email');
    expect(CommissionInputSchema.safeParse({ title: '' }).success).toBe(false);
    expect(CommissionInputSchema.safeParse({ title: 'x', dueDate: 'tomorrow' }).success).toBe(false);
    expect(CommissionInputSchema.safeParse({ title: 'x', price: -1 }).success).toBe(false);
  });

  it('a customer needs a name, and has its email tidied', () => {
    expect(CustomerInputSchema.parse({ name: ' Mira ', email: ' MIRA@Example.test ' })).toMatchObject({ name: 'Mira', email: 'mira@example.test', phone: '' });
    expect(CustomerInputSchema.safeParse({ name: '' }).success).toBe(false);
    expect(CustomerInputSchema.safeParse({ name: 'a', email: 'nope' }).success).toBe(false);
  });

  it('a new commission is for an existing customer or a new one, never both or neither', () => {
    const customer = { name: 'Mira' };
    expect(CommissionCreateSchema.safeParse({ title: 'Fox', customer }).success).toBe(true);
    expect(CommissionCreateSchema.safeParse({ title: 'Fox', customerId: 'c1' }).success).toBe(true);
    expect(CommissionCreateSchema.safeParse({ title: 'Fox' }).success).toBe(false);
    expect(CommissionCreateSchema.safeParse({ title: 'Fox', customer, customerId: 'c1' }).success).toBe(false);
    expect(CommissionCreateSchema.parse({ title: 'Fox', customerId: 'c1' }).forceNewCustomer).toBe(false);
  });

  it('only knows the fixed statuses', () => {
    expect(CommissionUpdateSchema.safeParse({ status: 'ready' }).success).toBe(true);
    expect(CommissionUpdateSchema.safeParse({ status: 'shipped' }).success).toBe(false);
  });
});

describe('settings time zone', () => {
  it('defaults to UTC and only takes a zone the runtime knows', () => {
    expect(CommissionSettingsSchema.parse({}).timeZone).toBe('UTC');
    expect(CommissionSettingsSchema.parse({ timeZone: ' Europe/Zurich ' }).timeZone).toBe('Europe/Zurich');
    expect(CommissionSettingsSchema.safeParse({ timeZone: 'Mars/Olympus' }).success).toBe(false);
    expect(CommissionSettingsSchema.safeParse({ timeZone: '' }).success).toBe(false);
  });
});

describe('settings retention', () => {
  it('defaults to 30 days and allows 0 to 365', () => {
    expect(CommissionSettingsSchema.parse({}).keepCustomerDays).toBe(30);
    expect(CommissionSettingsSchema.parse({ keepCustomerDays: 0 }).keepCustomerDays).toBe(0);
    expect(CommissionSettingsSchema.parse({ keepCustomerDays: 365 }).keepCustomerDays).toBe(365);
    expect(CommissionSettingsSchema.safeParse({ keepCustomerDays: -1 }).success).toBe(false);
    expect(CommissionSettingsSchema.safeParse({ keepCustomerDays: 366 }).success).toBe(false);
    expect(CommissionSettingsSchema.safeParse({ keepCustomerDays: 1.5 }).success).toBe(false);
  });
});
