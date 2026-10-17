import { beforeEach, describe, expect, it } from 'vitest';
import type { SalesEvent } from '@zollify/shared';
import type { Sdk } from '@zollify/sdk';
import { setSdk } from '../runtime';
import { addMisc, cardFx, cart, checkout, clear, setCartEvent } from '../cart';

/**
 * The cart follows the till's event: where a sale is recorded, its currency and
 * rate. And Sell 🔒 is checked against the event the sale goes to, not only the
 * banner's.
 */

let locks: Record<string, { by: { id: string; name: string }[]; forced: boolean; canForce: boolean } | null> = {};
const recorded: unknown[] = [];

// Anything the cart reaches for that a test does not care about comes back empty.
const empty = (): unknown => new Proxy(() => [], { get: (_t, k) => (k === 'then' ? undefined : empty()), apply: () => [] });
const fake = new Proxy(
  {
    data: new Proxy(
      {
        events: { sellLock: (id: string) => locks[id] ?? null, list: () => [], get: () => undefined },
        transactions: { record: async (s: unknown) => recorded.push(s), recent: () => [] },
      } as Record<string, unknown>,
      { get: (t, k: string) => (k in t ? t[k] : empty()) },
    ),
    config: { get: async () => undefined, set: async () => {} },
  } as Record<string, unknown>,
  { get: (t, k: string) => (k in t ? t[k] : empty()) },
) as unknown as Sdk;

const ev = (id: string, extra: Partial<SalesEvent> = {}): SalesEvent =>
  ({ id, name: id, venue: {}, currency: 'CHF', status: 'active', updatedAt: 1, ...extra }) as SalesEvent;

beforeEach(() => {
  setSdk(fake);
  locks = {};
  clear();
});

describe('the cart follows the till event', () => {
  it('takes the new event, its currency and rate, and drops a card rate for another pair', () => {
    setCartEvent(ev('narcon'), 'CHF');
    expect(cart).toMatchObject({ eventId: 'narcon', baseCurrency: 'CHF', currency: 'CHF', exchangeRate: null });
    Object.assign(cardFx, { rate: 1.07, at: 5 });
    setCartEvent(ev('asiacon', { currency: 'CHF', localCurrency: 'SEK', exchangeRate: 11.4, roundingIncrement: 5, localPriceOverrides: { p: 120 } }), 'CHF');
    expect(cart).toMatchObject({ eventId: 'asiacon', baseCurrency: 'CHF', currency: 'SEK', exchangeRate: 11.4, roundingIncrement: 5, priceOverrides: { p: 120 } });
    expect(cardFx.rate).toBeNull();
  });

  it('no event: nothing to record against, in the account currency', () => {
    setCartEvent(null, 'EUR');
    expect(cart).toMatchObject({ eventId: null, baseCurrency: 'EUR', currency: 'EUR' });
  });

  it('refuses a sale at a locked event, whatever the banner shows', async () => {
    setCartEvent(ev('A'), 'CHF');
    locks.A = { by: [{ id: 'B', name: 'B' }], forced: false, canForce: false };
    addMisc('Print', 10, 1);
    const out = await checkout('s1', { method: 'cash' } as never);
    expect(out).toMatchObject({ approved: false, error: expect.stringContaining('Sell 🔒') });
    expect(recorded).toHaveLength(0);
  });

  it('a forced lock lets the sale through to payment', async () => {
    setCartEvent(ev('A'), 'CHF');
    locks.A = { by: [{ id: 'B', name: 'B' }], forced: true, canForce: true };
    addMisc('Print', 10, 1);
    const out = await checkout('s2', { method: 'cash' } as never);
    expect(out.error ?? '').not.toContain('Sell 🔒');
  });
});
