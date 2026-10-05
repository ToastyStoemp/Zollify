import { describe, expect, it } from 'vitest';
import {
  addMonths,
  consignmentStatements,
  nextPeriodStart,
  occupancy,
  rentCharged,
  rentDue,
  rentalEnd,
  rentalPeriods,
  rentalStatus,
  type ConsignmentRental,
} from '../consignment';

const rental = (over: Partial<ConsignmentRental> = {}): ConsignmentRental => ({
  id: 'r1',
  consignorId: 'ana',
  storeId: 'zh',
  spaceId: 'small',
  startDate: '2026-01-01',
  months: 6,
  monthlyFee: 40,
  currency: 'CHF',
  deductFromSales: true,
  note: '',
  endedOn: null,
  upgradedFromId: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('planner dates', () => {
  it('adds months, clamping to the end of a shorter month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonths('2026-03-01', 0)).toBe('2026-03-01');
  });

  it('knows when a rental runs, and when an early end cuts it', () => {
    const r = rental();
    expect(rentalEnd(r)).toBe('2026-07-01');
    expect(rentalStatus(r, '2025-12-31')).toBe('upcoming');
    expect(rentalStatus(r, '2026-06-30')).toBe('active');
    expect(rentalStatus(r, '2026-07-01')).toBe('ended');
    expect(rentalEnd(rental({ endedOn: '2026-03-01' }))).toBe('2026-03-01');
    // An endedOn past the planned end cannot stretch it.
    expect(rentalEnd(rental({ endedOn: '2027-01-01' }))).toBe('2026-07-01');
  });

  it('charges a month once it has started', () => {
    const r = rental();
    expect(rentCharged(r, '2025-12-31')).toBe(0);
    expect(rentCharged(r, '2026-01-01')).toBe(40);
    expect(rentCharged(r, '2026-02-15')).toBe(80);
    expect(rentCharged(r, '2027-01-01')).toBe(240);
  });

  it('upgrades at the next period without billing a month twice', () => {
    const old = rental();
    const from = nextPeriodStart(old, '2026-03-10');
    expect(from).toBe('2026-04-01');
    const ended = { ...old, endedOn: from };
    const bigger = rental({ id: 'r2', spaceId: 'large', startDate: from, months: 3, monthlyFee: 70, upgradedFromId: 'r1' });
    expect(rentalPeriods(ended)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(rentCharged(ended, '2026-12-31') + rentCharged(bigger, '2026-12-31')).toBe(3 * 40 + 3 * 70);
  });

  it('counts how many of each space are taken on a day', () => {
    const used = occupancy([rental(), rental({ id: 'r2', startDate: '2026-05-01' }), rental({ id: 'r3', spaceId: 'large' })], '2026-02-01');
    expect(used.get('small')).toBe(1);
    expect(used.get('large')).toBe(1);
  });

  it('takes deducted rent off the balance, and leaves separately paid rent out', () => {
    const rent = rentDue([rental(), rental({ id: 'r2', deductFromSales: false })], '2026-02-01');
    expect(rent).toEqual([{ consignorId: 'ana', amount: 80, currency: 'CHF' }]);
    const [s] = consignmentStatements([], [], ['ana'], rent);
    expect(s!.totals[0]).toMatchObject({ rent: 80, balance: -80 });
  });
});
