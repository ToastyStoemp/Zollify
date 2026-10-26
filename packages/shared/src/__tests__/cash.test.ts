import { describe, expect, it } from 'vitest';
import { cashShortcutAmounts } from '../cash';

/** What a customer hands over in notes and a coin or two - never with a piece to spare. */
describe('cash suggestions', () => {
  it('offers single notes for 15 euros, not 20 + 5 or 20 + 20', () => {
    expect(cashShortcutAmounts(15, 'EUR')).toEqual([20, 50, 100, 200]);
  });

  it('offers two twenties when one is not enough', () => {
    expect(cashShortcutAmounts(35, 'EUR')).toEqual([40, 50, 100, 200]);
  });

  it('rounds a price with cents up with a coin or two, and a five', () => {
    // 10 + 2 + 1, 10 + 2 + 2, 10 + 5.
    expect(cashShortcutAmounts(12.5, 'EUR')).toEqual([13, 14, 15, 20, 50]);
    // 10 + 5 + 2 + 2 for 18; never three coins.
    expect(cashShortcutAmounts(18, 'EUR')).toEqual([19, 20, 50, 100, 200]);
  });

  it('offers coins and the smaller notes for a small price', () => {
    // Two 2-euro coins for 3.
    expect(cashShortcutAmounts(3, 'EUR')).toEqual([4, 5, 10, 20, 50]);
  });

  it('never pads a hand with a coin that is spare', () => {
    // 10 + 2 + 1 for 12 pounds: the 10 and 2 already pay.
    expect(cashShortcutAmounts(12, 'GBP')).toEqual([15, 20, 50]);
  });

  it('uses each currency’s own notes', () => {
    // A dollar note makes 16 a fair hand for 15.50; 15 exactly has its own button.
    expect(cashShortcutAmounts(15.5, 'USD')).toEqual([16, 20, 50, 100]);
    expect(cashShortcutAmounts(15, 'USD')).toEqual([20, 50, 100]);
    // Swiss notes start at 10; the 2 and 5 franc coins round up with them.
    expect(cashShortcutAmounts(7.5, 'CHF')).toEqual([10, 20, 50, 100, 200]);
    expect(cashShortcutAmounts(12.5, 'CHF')).toEqual([14, 15, 20, 50, 100]);
    expect(cashShortcutAmounts(1500, 'JPY')).toEqual([2000, 5000, 10000]);
  });

  it('never suggests less than the total, nor the total itself', () => {
    for (const total of [0.5, 9.99, 20, 49.9, 50, 87.3, 199, 250]) {
      for (const a of cashShortcutAmounts(total, 'EUR')) expect(a).toBeGreaterThan(total);
    }
  });

  it('rounds up to the large notes past what a hand of notes covers', () => {
    expect(cashShortcutAmounts(1730, 'EUR')).toEqual([1750, 1800]);
    // Already a round sum: the next one up.
    expect(cashShortcutAmounts(2000, 'EUR')).toEqual([2050, 2100, 2200]);
  });

  it('falls back to common notes for a currency it does not know', () => {
    expect(cashShortcutAmounts(15, 'XYZ')).toEqual([20, 50, 100, 200]);
  });
});
