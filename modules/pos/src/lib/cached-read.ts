/**
 * A local copy of something the server holds, read stale-while-revalidate.
 *
 * A booth often has bad or no internet, and anything that waits on the server
 * at the till can cost a sale. So what the till needs from the server is kept
 * on the device: a read answers from that copy at once, and the copy is
 * brought up to date in the background whenever the server can be reached.
 * Only the very first read, with nothing kept yet, waits - and then briefly.
 *
 * The copy goes through a store the caller hands in (the module's own
 * device-local config), so it is never queued as a synced change.
 */

/** Where copies are kept: device-local key/value storage, such as `sdk().config`. */
export interface CacheStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** Asks the server. The signal is aborted when the refresh has taken too long. */
export type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

export interface CachedReadOptions {
  store: CacheStore;
  /** A copy younger than this is not refreshed (default 0: every read starts a refresh). */
  maxAgeMs?: number;
  /** How long a read may wait for the server when nothing is kept yet (default 1500). */
  firstWaitMs?: number;
  /** A refresh is given up after this long (default 8000), so a stalled connection is not held open. */
  refreshTimeoutMs?: number;
  /** After a failed refresh, the server is not asked again for this long (default 60000) - a till without internet must not retry on every sale. */
  retryAfterMs?: number;
}

/** A kept copy, with when the server gave it. */
interface Kept<T> {
  value: T;
  at: number;
}

type Settled = Required<CachedReadOptions>;

const settle = (o: CachedReadOptions): Settled => ({ maxAgeMs: 0, firstWaitMs: 1500, refreshTimeoutMs: 8000, retryAfterMs: 60_000, ...o });

/** Refreshes under way, by key, so concurrent reads share one request. */
const inflight = new Map<string, Promise<unknown>>();
/** When each key's last refresh failed. */
const failedAt = new Map<string, number>();

/** For tests: forget refreshes under way and past failures. */
export function resetCachedReads(): void {
  inflight.clear();
  failedAt.clear();
}

/** The kept copy, or undefined when there is none (or the storage cannot be read). */
async function readKept<T>(store: CacheStore, key: string): Promise<Kept<T> | undefined> {
  const kept = await store.get<Kept<T>>(key).catch(() => undefined);
  return kept && typeof kept === 'object' && 'value' in kept && typeof kept.at === 'number' ? kept : undefined;
}

/** Whether the copy is recent enough to leave alone. A clock set back must not make a copy fresh forever, hence the absolute age. */
const isFresh = (kept: Kept<unknown>, maxAgeMs: number): boolean => Math.abs(Date.now() - kept.at) < maxAgeMs;

const failedRecently = (key: string, retryAfterMs: number): boolean => failedAt.has(key) && Date.now() - failedAt.get(key)! < retryAfterMs;

/** Keep a value as the local copy - after this device changed it on the server itself, say. Never throws. */
export async function writeCached(key: string, value: unknown, store: CacheStore): Promise<void> {
  const kept: Kept<unknown> = { value, at: Date.now() };
  await store.set(key, kept).catch(() => undefined);
}

/** Runs the fetcher, giving up (and aborting its request) after `ms`. */
function fetchWithin<T>(fetcher: Fetcher<T>, ms: number): Promise<T> {
  const abort = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abort.abort();
      reject(new Error('The server did not answer in time.'));
    }, ms);
    // Started inside a then(), so a fetcher that throws outright counts as a failed request.
    Promise.resolve()
      .then(() => fetcher(abort.signal))
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

/**
 * Ask the server and keep its answer. One request per key at a time; resolves
 * to undefined - never rejects - when the server cannot be reached, or was
 * unreachable a moment ago.
 */
function refresh<T>(key: string, fetcher: Fetcher<T>, o: Settled): Promise<T | undefined> {
  const running = inflight.get(key) as Promise<T | undefined> | undefined;
  if (running) return running;
  if (failedRecently(key, o.retryAfterMs)) return Promise.resolve(undefined);
  const run = fetchWithin(fetcher, o.refreshTimeoutMs)
    .then(
      async (value) => {
        failedAt.delete(key);
        await writeCached(key, value, o.store);
        return value;
      },
      () => {
        failedAt.set(key, Date.now());
        return undefined;
      },
    )
    .finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

/** The promise's value, or undefined when it takes longer than `ms`. */
function within<T>(promise: Promise<T | undefined>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/**
 * The local copy at once, refreshed in the background for next time. Without
 * a copy yet it waits for the server, at most `firstWaitMs`, and gives
 * undefined when that does not answer. Never throws.
 */
export async function cachedRead<T>(key: string, fetcher: Fetcher<T>, options: CachedReadOptions): Promise<T | undefined> {
  const o = settle(options);
  const kept = await readKept<T>(o.store, key);
  if (!kept) return within(refresh(key, fetcher, o), o.firstWaitMs);
  if (!isFresh(kept, o.maxAgeMs)) void refresh(key, fetcher, o);
  return kept.value;
}

/**
 * What the server has now, for the few places a stale copy would do harm
 * (deciding what to write back to the server). Waits for the answer - shared
 * with a refresh already under way, and kept as the local copy - and gives
 * undefined when the server cannot be reached. A copy younger than `maxAgeMs`
 * counts as current. Never throws.
 */
export async function freshRead<T>(key: string, fetcher: Fetcher<T>, options: CachedReadOptions): Promise<T | undefined> {
  const o = settle(options);
  const kept = await readKept<T>(o.store, key);
  if (kept && isFresh(kept, o.maxAgeMs)) return kept.value;
  return refresh(key, fetcher, o);
}
