import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * On mobile data a connection can stall without ever failing. A request must
 * then give up after its limit - before, one stalled request stopped every
 * sync after it until the app was restarted.
 */

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const user = { id: 'u1', accountId: 'a1', accountName: 'Booth', email: 'owner@example.test', role: 'owner', allowedEventIds: null, profile: undefined };

/** A fetch that never answers, letting go only when told to - as a real one does on abort. */
const stalled = vi.fn(
  (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
);
/** One that never answers and ignores the abort altogether. */
const deaf = vi.fn(() => new Promise<Response>(() => {}));

async function signedIn() {
  vi.resetModules();
  const s = await import('../session');
  // A token good for an hour, so no refresh comes first.
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  s.applyLogin({ accessToken: `x.${payload}.y`, user } as never);
  return s;
}

beforeEach(() => store.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a request on a stalled connection', () => {
  it('gives up after its limit and says why', async () => {
    const s = await signedIn();
    vi.stubGlobal('fetch', stalled);
    const err = (await s.authFetch('/sync/pull?since=0', { timeoutMs: 40 }).catch((e: unknown) => e)) as Error & { timeout?: boolean };
    expect(err.timeout).toBe(true);
    expect(err.message).toMatch(/did not answer within/);
    // The request was told to let go.
    expect((stalled.mock.calls[0]![1] as RequestInit).signal!.aborted).toBe(true);
  });

  it('gives up even when the request ignores being cut off', async () => {
    const s = await signedIn();
    vi.stubGlobal('fetch', deaf);
    const err = (await s.authFetch('/modules/manifest', { timeoutMs: 40 }).catch((e: unknown) => e)) as Error & { timeout?: boolean };
    expect(err.timeout).toBe(true);
  });

  it('has a limit by default', async () => {
    vi.useFakeTimers();
    const s = await signedIn();
    vi.stubGlobal('fetch', stalled);
    const pending = s.authFetch('/devices').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(s.REQUEST_TIMEOUT_MS + 10);
    expect(((await pending) as { timeout?: boolean }).timeout).toBe(true);
  });

  it('still answers normally when the server does', async () => {
    const s = await signedIn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { headers: { 'content-type': 'application/json' } })));
    expect(await s.authFetch('/devices', { timeoutMs: 1000 })).toEqual({ ok: 1 });
  });

  it('is not a timeout when the caller cancels it', async () => {
    const s = await signedIn();
    vi.stubGlobal('fetch', stalled);
    const ctl = new AbortController();
    const pending = s.authFetch('/devices', { timeoutMs: 5000, signal: ctl.signal }).catch((e: unknown) => e);
    ctl.abort();
    const err = (await pending) as { timeout?: boolean; name?: string };
    expect(err.timeout).toBeUndefined();
    expect(err.name).toBe('AbortError');
  });
});

describe('a token refresh on a stalled connection', () => {
  it('gives up rather than holding every request behind it', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const s = await import('../session');
    s.applyLogin({ accessToken: 'not-a-jwt', user } as never);
    vi.stubGlobal('fetch', stalled);
    const refreshed = s.refreshAccessToken();
    await vi.advanceTimersByTimeAsync(21_000);
    expect(await refreshed).toBe(false);
    // Still signed in: a slow network is not a refusal.
    expect(s.getAccount()).not.toBeNull();
  });
});
