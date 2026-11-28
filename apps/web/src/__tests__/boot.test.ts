import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'vue-router';

/**
 * Starting the app in a hall where the phone is connected but nothing gets
 * through. A device that is already signed in must reach the till from what
 * is on it, with the server asked only afterwards; a device nobody is signed
 * in on still waits for the server, but never without a limit.
 */

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

// The device's own data and the services that sync it are not what is tested
// here - only when they are reached. Everything else of the platform is real:
// the session, its timeouts, the module loader.
const local = (() => {
  const names = [
    'loadCatalog',
    'loadSalesEvents',
    'loadTransactions',
    'loadDiscounts',
    'loadInventory',
    'loadSellLockSettings',
    'loadRefusedSales',
    'refreshPendingCount',
    'startAutoSync',
    'startRealtime',
    'startAutoEvents',
    'startTillLock',
    'stopAutoSync',
    'stopAutoEvents',
    'stopRealtime',
    'guardUnsyncedOnClose',
  ] as const;
  return Object.fromEntries(names.map((n) => [n, vi.fn(async () => undefined)])) as Record<(typeof names)[number], ReturnType<typeof vi.fn>>;
})();

const user = { id: 'u1', accountId: 'a1', accountName: 'Booth', email: 'owner@example.test', role: 'owner', allowedEventIds: null, profile: undefined };
const snapshot = { accountId: 'a1', accountName: 'Booth', userId: 'u1', email: 'owner@example.test', role: 'owner', allowedEventIds: null, profile: {} };
/** A token good for an hour. */
const token = (): string => `x.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.y`;
const MANIFEST_KEY = 'zollify.manifest.a1';
// A module this build does not carry: it fails to load on its own, which is all the loader is asked to show here.
const lastRun = { sdk: '1', modules: [{ moduleId: 'ghost', version: '1.0.0', url: '/modules/ghost.js', integrity: 'aa' }] };
const changed = { sdk: '1', modules: [{ moduleId: 'ghost', version: '1.1.0', url: '/modules/ghost.js', integrity: 'bb' }] };

/** This device was signed in before and has run its modules: the state of a booth's phone on the second morning. */
function signedInBefore(): void {
  store.set('zollify.device-account', JSON.stringify({ snapshot, at: Date.now() }));
  store.set(MANIFEST_KEY, JSON.stringify(lastRun));
}

/** A connection that is up but lets nothing through: no answer, no error, and deaf to being cut off. */
const stalled = () => vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {}));

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A server that answers; `refresh` and `manifest` say what with. */
function server(answers: { refresh: () => Response; manifest?: () => Response }) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/auth/refresh')) return answers.refresh();
    if (url.endsWith('/modules/manifest') && answers.manifest) return answers.manifest();
    return json({ error: 'not found' }, 404);
  });
}

function fakeRouter(fullPath = '/m/pos') {
  const replace = vi.fn(async () => undefined);
  return { router: { currentRoute: { value: { fullPath, meta: {} } }, replace } as unknown as Router, replace };
}

/** A fresh app start: new module state, same device storage. */
async function start() {
  vi.resetModules();
  vi.doMock('@zollify/platform', async () => ({ ...(await vi.importActual<typeof import('@zollify/platform')>('@zollify/platform')), ...local }));
  const platform = await import('@zollify/platform');
  const boot = await import('../boot');
  const loadAll = vi.spyOn(boot.loader, 'loadAll');
  return { platform, boot, loadAll };
}

const requested = (fetch: ReturnType<typeof vi.fn>): string[] => fetch.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  store.clear();
  for (const fn of Object.values(local)) fn.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('starting a signed-in device on a stalled connection', () => {
  it('opens from what is on the device, without any request answering', async () => {
    signedInBefore();
    const fetch = stalled();
    vi.stubGlobal('fetch', fetch);
    // The clock stands still: were anything waiting on a timeout, this would never finish.
    vi.useFakeTimers();
    const { platform, boot, loadAll } = await start();

    await boot.bootApp(fakeRouter().router);

    expect(boot.booted.value).toBe(true);
    expect(platform.getAccount()).toMatchObject({ accountId: 'a1', userId: 'u1' });
    expect(platform.signedInOffline.value).toBe(true);
    // Its data and the modules it last ran, then the services that sync.
    for (const loader of ['loadCatalog', 'loadSalesEvents', 'loadTransactions', 'loadDiscounts', 'loadInventory', 'loadSellLockSettings', 'loadRefusedSales', 'refreshPendingCount'] as const) {
      expect(local[loader]).toHaveBeenCalledTimes(1);
    }
    expect(loadAll).toHaveBeenCalledWith(lastRun.modules, 'owner');
    expect(local.startAutoSync).toHaveBeenCalledTimes(1);
    expect(local.startTillLock).toHaveBeenCalledWith({ unlocked: undefined });
    // The server was asked - and is still not answering.
    expect(requested(fetch)).toEqual(['/api/auth/refresh']);
  });

  it('asks the server only once the app is open', async () => {
    signedInBefore();
    const { boot } = await start();
    const bootedWhenAsked: boolean[] = [];
    const answering = server({ refresh: () => json({ accessToken: token(), user }), manifest: () => json(lastRun) });
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      bootedWhenAsked.push(boot.booted.value);
      return answering(url, init);
    });
    vi.stubGlobal('fetch', fetch);

    await boot.bootApp(fakeRouter().router);

    await vi.waitFor(() => expect(requested(fetch)).toEqual(['/api/auth/refresh', '/api/modules/manifest']));
    expect(bootedWhenAsked).toEqual([true, true]);
  });

  it('stays signed in when the server does not answer in time, or answers with an error', async () => {
    signedInBefore();
    vi.stubGlobal('fetch', server({ refresh: () => json({ error: 'bad gateway' }, 502) }));
    const { platform, boot } = await start();
    const { router, replace } = fakeRouter();

    await boot.bootApp(router);
    await boot.refreshInBackground(router, 'device');

    expect(platform.getAccount()).toMatchObject({ userId: 'u1' });
    expect(replace).not.toHaveBeenCalled();
    expect(store.has('zollify.device-account')).toBe(true);

    // And on the stalled connection, once the refresh has run out its limit.
    vi.useFakeTimers();
    vi.stubGlobal('fetch', stalled());
    const waiting = boot.refreshInBackground(router, 'device');
    await vi.advanceTimersByTimeAsync(20_000);
    await waiting;
    expect(platform.getAccount()).toMatchObject({ userId: 'u1' });
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('what the server says after a start from the device', () => {
  it('ends a session the server refuses, and shows the login screen with the way back', async () => {
    signedInBefore();
    vi.stubGlobal('fetch', server({ refresh: () => json({ error: 'revoked' }, 401) }));
    const { platform, boot } = await start();
    const { router, replace } = fakeRouter('/m/pos');

    await boot.bootApp(router);
    // The till was open for a moment - the refusal comes afterwards.
    expect(boot.booted.value).toBe(true);

    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith({ name: 'login', query: { next: '/m/pos' } }));
    expect(platform.getAccount()).toBeNull();
    // Forgotten, so the next start does not resume it either.
    expect(store.has('zollify.device-account')).toBe(false);
    expect(local.stopAutoSync).toHaveBeenCalled();
  });

  it('keeps a changed module list for the next start instead of swapping modules now', async () => {
    signedInBefore();
    vi.stubGlobal('fetch', server({ refresh: () => json({ accessToken: token(), user }), manifest: () => json(changed) }));
    const { platform, boot, loadAll } = await start();

    await boot.bootApp(fakeRouter().router);

    await vi.waitFor(() => expect(JSON.parse(store.get(MANIFEST_KEY)!)).toEqual(changed));
    // Running modules are left alone: loaded once, from the list the device started with.
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(loadAll).toHaveBeenCalledWith(lastRun.modules, 'owner');
    expect(platform.toasts.map((t) => t.message)).toEqual([expect.stringMatching(/modules changed/)]);
    expect(platform.toasts[0]!.action?.label).toBe('Restart now');
    expect(platform.signedInOffline.value).toBe(false);
  });

  it('says nothing when the module list is the same', async () => {
    signedInBefore();
    const fetch = server({ refresh: () => json({ accessToken: token(), user }), manifest: () => json(lastRun) });
    vi.stubGlobal('fetch', fetch);
    const { platform, boot } = await start();

    await boot.bootApp(fakeRouter().router);

    await vi.waitFor(() => expect(requested(fetch)).toContain('/api/modules/manifest'));
    await new Promise((r) => setTimeout(r, 0));
    expect(platform.toasts).toEqual([]);
  });
});

describe('a start that needs the server', () => {
  it('with nobody signed in, waits for the server - but only for the refresh limit', async () => {
    vi.stubGlobal('fetch', stalled());
    vi.useFakeTimers();
    const { platform, boot } = await start();
    const done = vi.fn();
    void boot.bootApp(fakeRouter().router).then(done);

    await vi.advanceTimersByTimeAsync(19_000);
    expect(boot.booted.value).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toHaveBeenCalled();
    // Booted with nobody signed in: the router shows the login screen.
    expect(boot.booted.value).toBe(true);
    expect(platform.getAccount()).toBeNull();
    expect(local.loadCatalog).not.toHaveBeenCalled();
    expect(local.startAutoSync).not.toHaveBeenCalled();
  });

  it('signed in but never told its modules, gives up on the list after its limit and says so', async () => {
    const { platform, boot, loadAll } = await start();
    platform.applyLogin({ accessToken: token(), user } as never);
    vi.stubGlobal('fetch', stalled());
    vi.useFakeTimers();

    // The same way in as the login screen takes.
    const { ready } = await boot.openSession({ modules: 'server-first', unlocked: true });
    const done = vi.fn();
    void ready.then(done);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(done).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toHaveBeenCalledWith('none');
    expect(loadAll).not.toHaveBeenCalled();
    expect(platform.toasts.map((t) => t.action?.label)).toEqual(['Try again']);
    // The app still starts syncing: the data does not depend on the modules.
    expect(local.startAutoSync).toHaveBeenCalledTimes(1);
    expect(local.startTillLock).toHaveBeenCalledWith({ unlocked: true });
  });

  it('gives up on a module bundle that stalls', async () => {
    vi.stubGlobal('fetch', stalled());
    vi.useFakeTimers();
    const { boot } = await start();
    const failed = vi.fn();
    void boot.downloadBundle('/modules/pos.js').catch(failed);

    await vi.advanceTimersByTimeAsync(boot.BUNDLE_TIMEOUT_MS - 1);
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ timeout: true }));
  });
});
