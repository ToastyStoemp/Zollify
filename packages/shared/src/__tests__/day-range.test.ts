import { describe, expect, it } from 'vitest';
import { eventDays, fmtDayRange } from '../day';
import { fmtPrice } from '../money';

describe('fmtDayRange', () => {
  it('shows one date for a one-day event and none without dates', () => {
    expect(fmtDayRange('2026-10-17', '2026-10-17', 2026)).toBe(fmtDayRange('2026-10-17', undefined, 2026));
    expect(fmtDayRange(undefined, undefined, 2026)).toBe('');
  });

  it('adds the year only when it is not this one', () => {
    expect(fmtDayRange('2026-10-17', '2026-10-18', 2026)).not.toMatch(/2026/);
    expect(fmtDayRange('2025-10-17', '2025-10-18', 2026)).toMatch(/2025/);
  });
});

describe('eventDays', () => {
  it('counts the first and last day', () => {
    expect(eventDays('2026-10-17', '2026-10-18')).toBe(2);
    expect(eventDays('2026-10-31', '2026-12-01')).toBe(32);
    expect(eventDays('2026-10-31', undefined)).toBe(0);
  });
});

describe('fmtPrice', () => {
  it('prints the currency code in capitals however it was stored', () => {
    expect(fmtPrice(3430, 'Eur')).toBe('EUR 3430.00');
  });
});
