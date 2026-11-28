import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedRead, freshRead, resetCachedReads, writeCached, type CacheStore } from '../lib/cached-read';

/**
 * What the till needs from the server is read from a copy on the device: at
 * once when there is one, with the server only ever asked in the background.
 */

let kept: Map<string, unknown>;
let store: CacheStore;

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const copyOf = (key: string): unknown => (kept.get(key) as { value: unknown } | undefined)?.value;

beforeEach(() => {
  kept = new Map();
  store = {
    get: async <T>(key: string) => kept.get(key) as T | undefined,
    set: async (key, value) => void kept.set(key, value),
  };
  resetCachedReads();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('with a copy on the device', () => {
  it('answers from the copy without waiting for the server', async () => {
    await writeCached('k', 'KEPT', store);
    const fetcher = vi.fn(() => never<string>());
    expect(await cachedRead('k', fetcher, { store })).toBe('KEPT');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes in the background, so the next read has the new value', async () => {
    await writeCached('k', 'OLD', store);
    expect(await cachedRead('k', async () => 'NEW', { store })).toBe('OLD');
    await vi.advanceTimersByTimeAsync(0);
    expect(await cachedRead('k', () => never<string>(), { store })).toBe('NEW');
  });

  it('keeps the old copy when the refresh fails', async () => {
    await writeCached('k', 'KEPT', store);
    const failing = vi.fn(async (): Promise<string> => Promise.reject(new Error('offline')));
    expect(await cachedRead('k', failing, { store })).toBe('KEPT');
    await vi.advanceTimersByTimeAsync(0);
    expect(await cachedRead('k', failing, { store })).toBe('KEPT');
    expect(copyOf('k')).toBe('KEPT');
  });

  it('leaves a recent copy alone', async () => {
    await writeCached('k', 'KEPT', store);
    const fetcher = vi.fn(async () => 'NEW');
    await cachedRead('k', fetcher, { store, maxAgeMs: 60_000 });
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await cachedRead('k', fetcher, { store, maxAgeMs: 60_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a value the server cleared (null) as a copy too', async () => {
    await writeCached('k', null, store);
    const fetcher = vi.fn(() => never<string | null>());
    expect(await cachedRead('k', fetcher, { store, maxAgeMs: 60_000 })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not ask a server that just failed again on every read', async () => {
    await writeCached('k', 'KEPT', store);
    const failing = vi.fn(async (): Promise<string> => Promise.reject(new Error('offline')));
    for (let i = 0; i < 5; i++) {
      await cachedRead('k', failing, { store, retryAfterMs: 60_000 });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(failing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await cachedRead('k', failing, { store, retryAfterMs: 60_000 });
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('gives up on a stalled refresh and aborts its request', async () => {
    await writeCached('k', 'KEPT', store);
    let signal: AbortSignal | undefined;
    const stalled = vi.fn((s: AbortSignal) => ((signal = s), never<string>()));
    await cachedRead('k', stalled, { store, refreshTimeoutMs: 8000 });
    await vi.advanceTimersByTimeAsync(7999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    // The stalled request no longer blocks a later refresh.
    await vi.advanceTimersByTimeAsync(60_000);
    await cachedRead('k', stalled, { store });
    expect(stalled).toHaveBeenCalledTimes(2);
  });
});

describe('without a copy yet', () => {
  it('waits for the server and keeps its answer', async () => {
    expect(await cachedRead('k', async () => 'SRV', { store })).toBe('SRV');
    expect(copyOf('k')).toBe('SRV');
  });

  it('waits only briefly for a server that does not answer', async () => {
    const read = cachedRead('k', () => never<string>(), { store, firstWaitMs: 1500 });
    let done = false;
    void read.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await read).toBeUndefined();
  });

  it('gives undefined, without throwing, when the server cannot be reached', async () => {
    expect(await cachedRead('k', async (): Promise<string> => Promise.reject(new Error('offline')), { store })).toBeUndefined();
  });

  it('counts a fetcher that throws outright as an unreachable server', async () => {
    const broken = (): Promise<string> => {
      throw new Error('no sdk');
    };
    expect(await cachedRead('k', broken, { store })).toBeUndefined();
  });

  it('keeps an answer that arrives after the wait, for the next read', async () => {
    const slow = (): Promise<string> => new Promise((ok) => setTimeout(() => ok('LATE'), 3000));
    const read = cachedRead('k', slow, { store, firstWaitMs: 1500 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await read).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await cachedRead('k', () => never<string>(), { store })).toBe('LATE');
  });

  it('survives storage that cannot be read or written', async () => {
    const broken: CacheStore = { get: () => Promise.reject(new Error('signed out')), set: () => Promise.reject(new Error('signed out')) };
    expect(await cachedRead('k', async () => 'SRV', { store: broken })).toBe('SRV');
  });
});

describe('concurrent reads', () => {
  it('share one request', async () => {
    let answer: (v: string) => void = () => {};
    const fetcher = vi.fn(() => new Promise<string>((ok) => (answer = ok)));
    const reads = [cachedRead('k', fetcher, { store }), cachedRead('k', fetcher, { store }), freshRead('k', fetcher, { store })];
    await vi.advanceTimersByTimeAsync(0);
    answer('SRV');
    expect(await Promise.all(reads)).toEqual(['SRV', 'SRV', 'SRV']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keep different keys apart', async () => {
    const [a, b] = await Promise.all([cachedRead('a', async () => 'A', { store }), cachedRead('b', async () => 'B', { store })]);
    expect([a, b]).toEqual(['A', 'B']);
  });
});

describe('a fresh read', () => {
  it('waits for the server even when a copy is kept', async () => {
    await writeCached('k', 'OLD', store);
    expect(await freshRead('k', async () => 'NEW', { store })).toBe('NEW');
    expect(copyOf('k')).toBe('NEW');
  });

  it('gives undefined rather than a stale copy when the server cannot be reached', async () => {
    await writeCached('k', 'OLD', store);
    expect(await freshRead('k', async (): Promise<string> => Promise.reject(new Error('offline')), { store })).toBeUndefined();
    expect(copyOf('k')).toBe('OLD');
  });

  it('takes a copy inside its max age as current', async () => {
    await writeCached('k', 'RECENT', store);
    const fetcher = vi.fn(async () => 'NEW');
    expect(await freshRead('k', fetcher, { store, maxAgeMs: 60_000 })).toBe('RECENT');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
