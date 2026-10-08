import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A downloaded update only activates on the next restart, and until then the
 * updater still reports the old bundle as current. The background check must
 * not take that as "update available" and download the whole bundle again -
 * it ran on every reconnect, all shift long.
 */

vi.mock('../native', () => ({ isNative: () => true, getServerUrl: () => 'https://booth.example' }));
vi.mock('../shell-ui', () => ({ createShellUi: () => ({ toast: () => {} }) }));

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

let current = '1.0.0';
const download = vi.fn(async (o: { version: string }) => ({ id: `b-${o.version}`, version: o.version }));
let queued: { id: string; version: string } | null = null;
const next = vi.fn(async (o: { id: string }) => ((queued = { id: o.id, version: o.id.replace(/^b-/, '') }), queued));
const reload = vi.fn(async () => {});
(globalThis as { Capacitor?: unknown }).Capacitor = {
  isNativePlatform: () => true,
  isPluginAvailable: () => true,
  Plugins: { CapacitorUpdater: { current: async () => ({ bundle: { id: 'x', version: current }, native: false }), download, next, notifyAppReady: async () => ({}), reload, getNextBundle: async () => queued } },
};
globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ version: '1.1.0', url: '/api/shell/1.1.0/bundle.zip', integrity: 'abc', sizeBytes: 900_000 }))) as typeof fetch;

beforeEach(() => {
  vi.resetModules();
  store.clear();
  download.mockClear();
  reload.mockClear();
  queued = null;
  current = '1.0.0';
});

describe('background content updates', () => {
  it('downloads a new bundle once, not again on every later check', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { checkAndQueueShellUpdate } = await import('../shell-updates');
    expect(await checkAndQueueShellUpdate()).toBe('1.1.0');
    expect(download).toHaveBeenCalledOnce();

    // Many reconnects later, still not restarted: nothing more downloaded.
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(Date.now() + 31 * 60_000);
      expect(await checkAndQueueShellUpdate()).toBeNull();
    }
    expect(download).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('checks the server at most every half hour on reconnects', async () => {
    const { checkAndQueueShellUpdate } = await import('../shell-updates');
    const fetches = vi.mocked(globalThis.fetch);
    fetches.mockClear();
    await checkAndQueueShellUpdate();
    await checkAndQueueShellUpdate();
    await checkAndQueueShellUpdate();
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it('forgets the queued version once the restart has activated it', async () => {
    const { checkShellUpdate, queueShellUpdate, shellUpdateQueued } = await import('../shell-updates');
    await queueShellUpdate((await checkShellUpdate())!);
    expect(await shellUpdateQueued('1.1.0')).toBe(true);
    current = '1.1.0';
    queued = null;
    await checkShellUpdate();
    expect(await shellUpdateQueued('1.1.0')).toBe(false);
  });

  it('downloads again when the plugin lost the queue (rolled back) but our note remains', async () => {
    const { checkAndQueueShellUpdate, shellUpdateQueued } = await import('../shell-updates');
    expect(await checkAndQueueShellUpdate()).toBe('1.1.0');
    queued = null; // the new bundle never reported ready; the plugin rolled back and forgot it
    expect(await shellUpdateQueued('1.1.0')).toBe(false);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    expect(await checkAndQueueShellUpdate()).toBe('1.1.0');
    expect(download).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('refuses to "reload" when nothing is queued instead of restarting the old bundle', async () => {
    const { reloadShellNow } = await import('../shell-updates');
    await expect(reloadShellNow()).rejects.toThrow(/no longer queued/);
    expect(reload).not.toHaveBeenCalled();
  });
});
