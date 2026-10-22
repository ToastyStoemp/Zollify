import { describe, expect, it } from 'vitest';
import { cashShortcutAmounts } from '../cash';

/** What a customer hands over in notes - never with a note to spare. */
describe('cash suggestions', () => {
  it('offers single notes for 15 euros, not 20 + 5 or 20 + 20', () => {
    expect(cashShortcutAmounts(15, 'EUR')).toEqual([20, 50, 100, 200]);
  });

  it('offers two twenties when one is not enough', () => {
    expect(cashShortcutAmounts(35, 'EUR')).toEqual([40, 50, 100, 200]);
  });

  it('offers a ten and a five for a price with cents', () => {
    expect(cashShortcutAmounts(12.5, 'EUR')).toEqual([15, 20, 50, 100]);
  });

  it('offers the smaller notes for a small price', () => {
    expect(cashShortcutAmounts(3, 'EUR')).toEqual([5, 10, 20, 50]);
  });

  it('uses each currency’s own notes', () => {
    // A dollar note makes 16 a fair hand for 15.50; 15 exactly has its own button.
    expect(cashShortcutAmounts(15.5, 'USD')).toEqual([16, 20, 50, 100]);
    expect(cashShortcutAmounts(15, 'USD')).toEqual([20, 50, 100]);
    // Swiss notes start at 10.
    expect(cashShortcutAmounts(7.5, 'CHF')).toEqual([10, 20, 50, 100]);
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
