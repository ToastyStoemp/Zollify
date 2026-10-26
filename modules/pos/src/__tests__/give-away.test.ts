import { beforeEach, describe, expect, it } from 'vitest';
import type { Sdk, SaleEvent } from '@zollify/sdk';
import { setSdk } from '../runtime';
import { GIVEN_AWAY, addMisc, cart, checkout, clear, setCustomDiscount } from '../cart';

/**
 * Something given away at the booth: a 100% discount brings the cart to
 * nothing. It is completed as given away - the items leave stock and the sale
 * is on record - and only a cart that comes to nothing can be.
 */

const emitted: SaleEvent[] = [];
const empty = (): unknown => new Proxy(() => [], { get: (_t, k) => (k === 'then' ? undefined : empty()), apply: () => [] });
const fake = new Proxy(
  {
    events: { emit: (_name: string, sale: SaleEvent) => emitted.push(sale), on: () => () => {} },
    data: new Proxy({ events: { sellLock: () => null, get: () => undefined, list: () => [] } } as Record<string, unknown>, { get: (t, k: string) => (k in t ? t[k] : empty()) }),
    fx: { latest: async () => null },
    config: { get: async () => undefined, set: async () => {} },
  } as Record<string, unknown>,
  { get: (t, k: string) => (k in t ? t[k] : empty()) },
) as unknown as Sdk;

beforeEach(() => {
  setSdk(fake);
  clear();
  emitted.length = 0;
  Object.assign(cart, { eventId: 'ev', baseCurrency: 'EUR', currency: 'EUR', exchangeRate: null, roundingIncrement: 0, priceOverrides: {}, tierOverrides: {} });
});

describe('giving a cart away', () => {
  it('completes a cart at 100% off, with its items and no payment', async () => {
    addMisc('Sticker', 3, 2);
    setCustomDiscount({ type: 'percent', value: 100, name: 'Gift' });
    const outcome = await checkout('s1', { method: GIVEN_AWAY });
    expect(outcome.approved).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ total: 0, payment: { method: GIVEN_AWAY, approved: true, legs: [] } });
    expect(emitted[0]!.lines).toMatchObject([{ name: 'Sticker', qty: 2, lineTotal: 0 }]);
    expect(emitted[0]!.asCharged?.discounts).toMatchObject([{ name: 'Gift', amount: 6 }]);
  });

  it('asks for Give away rather than a payment of nothing', async () => {
    addMisc('Sticker', 3, 1);
    setCustomDiscount({ type: 'percent', value: 100, name: 'Gift' });
    const outcome = await checkout('s2', { method: 'cash' });
    expect(outcome).toMatchObject({ approved: false, error: expect.stringContaining('Give away') });
    expect(emitted).toHaveLength(0);
  });

  it('never gives away a cart that still costs something', async () => {
    addMisc('Print', 20, 1);
    setCustomDiscount({ type: 'percent', value: 50, name: 'Half' });
    const outcome = await checkout('s3', { method: GIVEN_AWAY });
    expect(outcome.approved).toBe(false);
    expect(emitted).toHaveLength(0);
  });
});
