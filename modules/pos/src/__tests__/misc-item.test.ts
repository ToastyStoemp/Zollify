import { beforeEach, describe, expect, it } from 'vitest';
import type { SalesEvent } from '@zollify/shared';
import type { Sdk } from '@zollify/sdk';
import { setSdk } from '../runtime';
import { addMisc, cart, checkout, clear, setCartEvent, total } from '../cart';

/**
 * A misc item is typed in the currency the customer pays in. It used to be
 * stored in base currency rounded to cents and converted back, so 25 at a
 * rate of 11.3 was charged as 24.97.
 */

const emitted: { total: number; baseTotal: number; lines: Record<string, unknown>[] }[] = [];
const empty = (): unknown => new Proxy(() => [], { get: (_t, k) => (k === 'then' ? undefined : empty()), apply: () => [] });
const fake = new Proxy(
  {
    data: new Proxy({ events: { sellLock: () => null, list: () => [], get: () => undefined } } as Record<string, unknown>, { get: (t, k: string) => (k in t ? t[k] : empty()) }),
    events: { emit: (_name: string, sale: (typeof emitted)[number]) => emitted.push(sale) },
    config: { get: async () => undefined, set: async () => {} },
  } as Record<string, unknown>,
  { get: (t, k: string) => (k in t ? t[k] : empty()) },
) as unknown as Sdk;

const event = (extra: Partial<SalesEvent> = {}): SalesEvent =>
  ({ id: 'con', name: 'con', venue: {}, currency: 'EUR', status: 'active', updatedAt: 1, ...extra }) as SalesEvent;

beforeEach(() => {
  setSdk(fake);
  emitted.length = 0;
  clear();
});

describe('a misc item is charged as typed', () => {
  it('25 at a rate of 11.3 is charged 25, not 24.97', async () => {
    setCartEvent(event({ localCurrency: 'SEK', exchangeRate: 11.3 }), 'EUR');
    addMisc('Commission sketch', 25, 1);
    expect(total.value).toBe(25);

    const out = await checkout('s1', { method: 'cash' });
    expect(out.approved).toBe(true);
    // The customer pays the typed 25 SEK; the books get its base value.
    expect(emitted[0]).toMatchObject({ total: 25, baseTotal: 2.21 });
    // The typed price is the cart's own business, not part of the sale record.
    expect(emitted[0]!.lines[0]).not.toHaveProperty('typed');
  });

  it('stays exact for several of them, whatever the event rounds prices to', () => {
    setCartEvent(event({ localCurrency: 'SEK', exchangeRate: 11.3, roundingIncrement: 5 }), 'EUR');
    addMisc('Sticker', 12, 3);
    expect(total.value).toBe(36);
  });

  it('without conversion the typed price is the price', () => {
    setCartEvent(event(), 'EUR');
    addMisc('Sticker', 2.5, 2);
    expect(total.value).toBe(5);
    expect(cart.lines[0]).not.toHaveProperty('typed');
  });

  it('falls back to converting the base value when the till moves to another currency', () => {
    setCartEvent(event({ localCurrency: 'SEK', exchangeRate: 11.3 }), 'EUR');
    addMisc('Print', 25, 1);
    setCartEvent(event({ id: 'other', localCurrency: 'DKK', exchangeRate: 7.46 }), 'EUR');
    // 2.21 EUR at 7.46 - never 25 DKK.
    expect(total.value).toBe(16.49);
  });
});
