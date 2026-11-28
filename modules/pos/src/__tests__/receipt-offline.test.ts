import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sdk } from '@zollify/sdk';
import type { Transaction } from '@zollify/shared';
import { clearSdk, setSdk } from '../runtime';
import { resetBrandingCache } from '../lib/branding';
import { printableReceipt } from '../receipt';

/**
 * A second till (the Carbon) has no logo, footer or links of its own: they
 * come from the account, through the server. At an event its connection is
 * often bad or gone, and the receipt must come out all the same - at once,
 * and with everything it had the last time the server was reachable.
 */

const BRANDING = { logo: null, footer: 'See you next year!' };
const LINKS = { webstore: 'https://shop.example', showOnPrint: true, showEvents: false };
/** A request on a stalled connection: nothing for as long as the app's own limit, then an error. */
const REQUEST_TIMEOUT_MS = 30_000;

let store: Map<string, unknown>;
let get: ReturnType<typeof vi.fn>;

function fakeSdk(): Sdk {
  return {
    config: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => void store.set(k, v),
      remove: async (k: string) => void store.delete(k),
    },
    http: { get },
    account: () => ({ role: 'member', profile: { artist: {}, links: { webstore: LINKS.webstore } } }),
  } as unknown as Sdk;
}

const sale: Transaction = {
  id: 'tx-0000-1234abcd',
  eventId: 'ev',
  deviceId: 'd',
  timestamp: Date.UTC(2026, 9, 3, 10, 0),
  method: 'cash',
  payments: [{ kind: 'cash', amount: 20 }],
  items: [{ pid: 'p1', vid: null, title: 'Print', qty: 1, unitPrice: 20, lineTotal: 20 }],
  discounts: [],
  total: 20,
  currency: 'CHF',
};

const serverAnswers = (): void => void get.mockImplementation(async (path: string) => (path === 'branding' ? BRANDING : LINKS));
const serverStalls = (): void =>
  void get.mockImplementation(() => new Promise((_, fail) => setTimeout(() => fail(new Error('timeout')), REQUEST_TIMEOUT_MS)));
const serverUnreachable = (): void => void get.mockRejectedValue(new Error('offline'));

/** Prints the sale, and says how long the receipt took to be ready (to the tenth of a second). */
async function print(): Promise<{ text: string; waitedMs: number }> {
  const start = Date.now();
  let lines: Awaited<ReturnType<typeof printableReceipt>> | undefined;
  void printableReceipt(sale, 'Con').then((l) => (lines = l));
  await vi.advanceTimersByTimeAsync(0);
  while (!lines && Date.now() - start < 2 * REQUEST_TIMEOUT_MS) await vi.advanceTimersByTimeAsync(100);
  return { text: (lines ?? []).map((l) => l.text ?? '').join('\n'), waitedMs: Date.now() - start };
}

/** The app closed and opened again: what was only in memory is gone, what is on the device stays. */
const restart = (): void => resetBrandingCache();

beforeEach(() => {
  store = new Map<string, unknown>([['receipt.printQr', false]]);
  get = vi.fn();
  setSdk(fakeSdk());
  resetBrandingCache();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  clearSdk();
});

describe('receipt on a second till that was online once', () => {
  beforeEach(async () => {
    serverAnswers();
    await print();
    restart();
  });

  it('prints at once, footer and links included, while the connection stalls', async () => {
    serverStalls();
    const receipt = await print();
    expect(receipt.waitedMs).toBe(0);
    expect(receipt.text).toContain(BRANDING.footer);
    expect(receipt.text).toContain('shop.example');
  });

  it('prints at once on every sale of a day on a stalling connection', async () => {
    serverStalls();
    let waited = 0;
    for (let i = 0; i < 10; i++) {
      waited += (await print()).waitedMs;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    }
    expect(waited).toBe(0);
  });

  it('keeps the footer and links with no connection at all', async () => {
    serverUnreachable();
    const receipt = await print();
    expect(receipt.waitedMs).toBe(0);
    expect(receipt.text).toContain(BRANDING.footer);
    expect(receipt.text).toContain('shop.example');
  });
});

describe('receipt on a second till that never reached the server', () => {
  it('still prints within a few seconds on a stalled connection, without the shared parts', async () => {
    serverStalls();
    const receipt = await print();
    expect(receipt.waitedMs).toBeLessThanOrEqual(2500);
    expect(receipt.text).toContain('Print');
    expect(receipt.text).not.toContain(BRANDING.footer);
  });
});
