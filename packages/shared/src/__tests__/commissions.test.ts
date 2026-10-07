import { describe, expect, it } from 'vitest';
import { CommissionInputSchema, CommissionSettingsSchema, CommissionUpdateSchema, commissionTotals, isOverdue, nextStatuses } from '../commissions';

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
  it('needs a name and a title, tidies an email and defaults the rest', () => {
    const ok = CommissionInputSchema.parse({ customerName: ' Mira ', title: 'Fox', email: ' MIRA@Example.test ' });
    expect(ok).toMatchObject({ customerName: 'Mira', email: 'mira@example.test', price: 0, dueDate: '', currency: 'EUR' });
    expect(CommissionInputSchema.safeParse({ customerName: '', title: 'x' }).success).toBe(false);
    expect(CommissionInputSchema.safeParse({ customerName: 'a', title: 'x', dueDate: 'tomorrow' }).success).toBe(false);
    expect(CommissionInputSchema.safeParse({ customerName: 'a', title: 'x', price: -1 }).success).toBe(false);
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
