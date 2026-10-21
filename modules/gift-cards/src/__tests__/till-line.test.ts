import { describe, expect, it } from 'vitest';
import { decideRedeem, decideSell, suggestedRedeem } from '../till-line';

describe('decideSell', () => {
  it('needs a positive amount within the limit', () => {
    expect(decideSell({ amount: 50, maxValue: 500, currency: 'EUR' })).toEqual({ kind: 'add' });
    expect(decideSell({ amount: 0, maxValue: 500, currency: 'EUR' }).kind).toBe('invalid');
    expect(decideSell({ amount: Number.NaN, maxValue: 500, currency: 'EUR' }).kind).toBe('invalid');
    const over = decideSell({ amount: 501, maxValue: 500, currency: 'EUR' });
    expect(over.kind).toBe('invalid');
    if (over.kind === 'invalid') expect(over.message).toContain('500');
  });
});

const base = { amount: 20, balance: 50, refusal: null, cardCurrency: 'EUR', tillCurrency: 'EUR', tillTotal: 30, inCart: null };

describe('suggestedRedeem', () => {
  it('offers what is on the card, capped at what the sale comes to', () => {
    expect(suggestedRedeem({ balance: 50, tillTotal: 30, inCart: null })).toBe(30);
    expect(suggestedRedeem({ balance: 20, tillTotal: 30, inCart: null })).toBe(20);
    // The card's own line is already off the total: it counts back in.
    expect(suggestedRedeem({ balance: 50, tillTotal: 10, inCart: 20 })).toBe(30);
    expect(suggestedRedeem({ balance: 50, tillTotal: null, inCart: null })).toBe(50);
    expect(suggestedRedeem({ balance: 0, tillTotal: 30, inCart: null })).toBe(0);
  });
});

describe('decideRedeem', () => {
  it('adds a first line', () => {
    expect(decideRedeem(base)).toEqual({ kind: 'add' });
  });

  it('a card that cannot be spent, or one in another currency, blocks before anything else', () => {
    expect(decideRedeem({ ...base, refusal: 'This card was voided.' })).toEqual({ kind: 'blocked', message: 'This card was voided.' });
    const d = decideRedeem({ ...base, tillCurrency: 'CHF', inCart: 20 });
    expect(d.kind).toBe('blocked');
    if (d.kind === 'blocked') {
      expect(d.message).toContain('EUR');
      expect(d.message).toContain('CHF');
    }
  });

  it('never takes more than is on the card or than the sale comes to', () => {
    expect(decideRedeem({ ...base, amount: 0 }).kind).toBe('invalid');
    expect(decideRedeem({ ...base, amount: 50.01 }).kind).toBe('invalid');
    expect(decideRedeem({ ...base, amount: 31 }).kind).toBe('invalid');
    expect(decideRedeem({ ...base, amount: 30 })).toEqual({ kind: 'add' });
    // The card's own line already in the cart counts back into what the sale comes to.
    expect(decideRedeem({ ...base, amount: 30, tillTotal: 10, inCart: 20 }).kind).toBe('replace');
    expect(decideRedeem({ ...base, amount: 31, tillTotal: 10, inCart: 20 }).kind).toBe('invalid');
    // A shell that cannot say what the sale comes to: the balance is the only cap.
    expect(decideRedeem({ ...base, amount: 50, tillTotal: null })).toEqual({ kind: 'add' });
    expect(decideRedeem({ ...base, tillTotal: 0 }).kind).toBe('blocked');
  });

  it('offers to replace a different amount already in the cart, and says both', () => {
    const d = decideRedeem({ ...base, inCart: 10 });
    expect(d.kind).toBe('replace');
    if (d.kind === 'replace') {
      expect(d.message).toContain('10.00');
      expect(d.message).toContain('20.00');
    }
    expect(decideRedeem({ ...base, inCart: 20 }).kind).toBe('unchanged');
  });
});
