import { beforeEach, describe, expect, it } from 'vitest';
import type { Sdk, SaleEvent } from '@zollify/sdk';
import { setSdk } from '../runtime';
import { addMisc, cart, checkout, clear, loadMarketFx, marketFx } from '../cart';

/**
 * A sale charged in a local currency records the day's market rate, so its
 * base value is what the money was worth that day (115 SEK at 11.13 = EUR
 * 10.33), not the catalogue figure.
 */

const emitted: SaleEvent[] = [];
let latest: { rate: number; at: number } | null = null;
const empty = (): unknown => new Proxy(() => [], { get: (_t, k) => (k === 'then' ? undefined : empty()), apply: () => [] });
const fake = new Proxy(
  {
    events: { emit: (_name: string, sale: SaleEvent) => emitted.push(sale), on: () => () => {} },
    data: new Proxy({ events: { sellLock: () => null, get: () => undefined, list: () => [] } } as Record<string, unknown>, { get: (t, k: string) => (k in t ? t[k] : empty()) }),
    fx: { latest: async () => latest },
    config: { get: async () => undefined, set: async () => {} },
  } as Record<string, unknown>,
  { get: (t, k: string) => (k in t ? t[k] : empty()) },
) as unknown as Sdk;

beforeEach(() => {
  setSdk(fake);
  clear();
  emitted.length = 0;
  Object.assign(cart, { eventId: 'gbg', baseCurrency: 'EUR', currency: 'SEK', exchangeRate: 11.5, roundingIncrement: 0, priceOverrides: {}, tierOverrides: {} });
});

describe('the day rate on a converted sale', () => {
  it('is recorded with the sale', async () => {
    latest = { rate: 11.13, at: Date.now() };
    await loadMarketFx();
    addMisc('Print', 10, 1);
    await checkout('s1', { method: 'cash' } as never);
    expect(emitted[0]).toMatchObject({ currency: 'SEK', baseCurrency: 'EUR', marketRate: { rate: 11.13 } });
  });

  it('is left out when the only rate the till has is days old', async () => {
    latest = { rate: 11.13, at: Date.now() - 5 * 86400000 };
    await loadMarketFx();
    addMisc('Print', 10, 1);
    await checkout('s2', { method: 'cash' } as never);
    expect(emitted[0]!.marketRate).toBeUndefined();
  });

  it('a rate for another currency pair is never used', async () => {
    latest = { rate: 11.13, at: Date.now() };
    await loadMarketFx();
    Object.assign(cart, { currency: 'NOK', exchangeRate: 11.7 });
    latest = null;
    await loadMarketFx();
    expect(marketFx.rate).toBeNull();
  });
});
