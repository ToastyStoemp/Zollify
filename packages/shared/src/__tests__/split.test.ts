import { describe, expect, it } from 'vitest';
import { splitAmount } from '../split';

describe('splitAmount', () => {
  it('whole units when everything is whole, adding up exactly', () => {
    expect(splitAmount(25, [40, 30, 30])).toEqual([10, 8, 7]);
    expect(splitAmount(15, [40, 40, 40])).toEqual([5, 5, 5]);
  });

  it('cents when the amount or a price has cents', () => {
    expect(splitAmount(10, [12.5, 12.5])).toEqual([5, 5]);
    const out = splitAmount(3.33, [1, 1, 1]);
    expect(out.reduce((a, b) => Math.round((a + b) * 100) / 100, 0)).toBe(3.33);
  });

  it('whole units can be forced when a price has cents', () => {
    expect(splitAmount(110, [80, 31.86], { wholeUnits: true })).toEqual([79, 31]);
  });

  it('nothing to split', () => {
    expect(splitAmount(0, [10, 20])).toEqual([0, 0]);
    expect(splitAmount(5, [])).toEqual([]);
    expect(splitAmount(5, [0, 0])).toEqual([0, 0]);
  });
});
