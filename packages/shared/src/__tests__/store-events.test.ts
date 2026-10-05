import { describe, expect, it } from 'vitest';
import { discountAppliesAt } from '../types';
import { featureOn, placeSignup, promoteFromWaitlist, seatsTaken, type Signup } from '../store-events';

const s = (id: string, status: Signup['status'], seats: number, createdAt: number) => ({ id, status, seats, createdAt });

describe('workshop seats', () => {
  const ws = { capacity: 6, waitlist: true };

  it('books while there is room, then waitlists', () => {
    expect(placeSignup(ws, [s('a', 'booked', 4, 1)], 2)).toBe('booked');
    expect(placeSignup(ws, [s('a', 'booked', 4, 1)], 3)).toBe('waitlist');
    expect(placeSignup({ ...ws, waitlist: false }, [s('a', 'booked', 6, 1)], 1)).toBe('full');
    // A party bigger than the whole workshop can never get in.
    expect(placeSignup(ws, [], 7)).toBe('full');
  });

  it('never lets a newcomer jump the queue', () => {
    expect(placeSignup(ws, [s('a', 'booked', 4, 1), s('b', 'waitlist', 3, 2)], 1)).toBe('waitlist');
  });

  it('ignores cancelled sign-ups', () => {
    expect(seatsTaken([s('a', 'cancelled', 6, 1), s('b', 'booked', 2, 2)])).toBe(2);
  });

  it('moves the waitlist up in order, whole parties only', () => {
    const list = [s('a', 'booked', 2, 1), s('b', 'waitlist', 3, 2), s('c', 'waitlist', 3, 3), s('d', 'waitlist', 1, 4)];
    expect(promoteFromWaitlist(ws, list)).toEqual(['b']);
    // c does not fit in what is left, so d waits behind it.
    expect(promoteFromWaitlist({ capacity: 8 }, list)).toEqual(['b', 'c']);
  });
});

describe('dated and scoped discounts', () => {
  it('applies only inside its dates and at its venues', () => {
    const rule = { validFrom: '2026-11-01', validUntil: '2026-11-30', eventIds: ['zh'] };
    expect(discountAppliesAt(rule, '2026-11-01', 'zh')).toBe(true);
    expect(discountAppliesAt(rule, '2026-11-30', 'zh')).toBe(true);
    expect(discountAppliesAt(rule, '2026-12-01', 'zh')).toBe(false);
    expect(discountAppliesAt(rule, '2026-11-15', 'be')).toBe(false);
    expect(discountAppliesAt(rule, '2026-11-15', null)).toBe(false);
    expect(discountAppliesAt({}, '2026-11-15', null)).toBe(true);
  });

  it('knows when a feature runs', () => {
    expect(featureOn({ startDate: '2026-11-01', endDate: '2026-11-30' }, '2026-11-30')).toBe(true);
    expect(featureOn({ startDate: '2026-11-01', endDate: '2026-11-30' }, '2026-12-01')).toBe(false);
  });
});
