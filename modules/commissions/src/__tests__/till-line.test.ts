import { describe, expect, it } from 'vitest';
import { decideCharge } from '../till-line';

const base = { amount: 50, commissionCurrency: 'EUR', tillCurrency: 'EUR', inCart: null };

describe('decideCharge', () => {
  it('adds a first line', () => {
    expect(decideCharge(base)).toEqual({ kind: 'add' });
  });

  it('needs a positive amount', () => {
    expect(decideCharge({ ...base, amount: 0 }).kind).toBe('invalid');
    expect(decideCharge({ ...base, amount: -5 }).kind).toBe('invalid');
    expect(decideCharge({ ...base, amount: Number.NaN }).kind).toBe('invalid');
  });

  it('names both currencies when the till works in another one', () => {
    const d = decideCharge({ ...base, tillCurrency: 'CHF' });
    expect(d.kind).toBe('blocked');
    if (d.kind === 'blocked') {
      expect(d.message).toContain('EUR');
      expect(d.message).toContain('CHF');
    }
    // Even with a line already in the cart: the currency block comes first.
    expect(decideCharge({ ...base, tillCurrency: 'CHF', inCart: 20 }).kind).toBe('blocked');
  });

  it('offers to replace a different amount already in the cart, and says both', () => {
    const d = decideCharge({ ...base, inCart: 20 });
    expect(d.kind).toBe('replace');
    if (d.kind === 'replace') {
      expect(d.message).toContain('20');
      expect(d.message).toContain('50');
      expect(d.confirm).toBe('Replace');
    }
  });

  it('leaves the cart alone when the same amount is already there', () => {
    expect(decideCharge({ ...base, inCart: 50 }).kind).toBe('unchanged');
    expect(decideCharge({ ...base, amount: 0.3, inCart: 0.1 + 0.2 }).kind).toBe('unchanged');
  });
});
