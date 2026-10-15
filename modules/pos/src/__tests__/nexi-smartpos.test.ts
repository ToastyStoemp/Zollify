import { describe, expect, it } from 'vitest';
import { toMinor } from '../payments/nexi-smartpos';

describe('toMinor', () => {
  it('sends kroner as øre and euro as cents, without float noise', () => {
    expect(toMinor(125, 'DKK')).toBe(12500);
    expect(toMinor(19.99, 'EUR')).toBe(1999);
    expect(toMinor(0.1 + 0.2, 'EUR')).toBe(30);
  });

  it('respects currencies without minor units', () => {
    expect(toMinor(1500, 'JPY')).toBe(1500);
  });
});
