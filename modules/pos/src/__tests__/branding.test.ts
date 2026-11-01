import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sdk } from '@zollify/sdk';
import { setSdk, clearSdk } from '../runtime';
import { accountLogo, pushBranding, resetBrandingCache, screenLogo, serverBranding } from '../lib/branding';

/**
 * The thank-you screen must not wait for the network: the logo comes from the
 * device, a slow or missing server costs at most a short wait once, and a
 * failed fetch is not retried on every sale.
 */

let store: Map<string, unknown>;
let get: ReturnType<typeof vi.fn>;
let put: ReturnType<typeof vi.fn>;

function fakeSdk(): Sdk {
  return {
    config: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => void store.set(k, v),
      remove: async (k: string) => void store.delete(k),
    },
    http: { get, put },
    account: () => ({ role: 'owner' }),
  } as unknown as Sdk;
}

beforeEach(() => {
  store = new Map();
  get = vi.fn();
  put = vi.fn();
  setSdk(fakeSdk());
  resetBrandingCache();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  clearSdk();
});

describe('screen logo', () => {
  it("uses this device's own logo without asking the server", async () => {
    store.set('receipt.logoScreenB64', 'OWN');
    expect(await screenLogo()).toBe('data:image/png;base64,OWN');
    expect(get).not.toHaveBeenCalled();
  });

  it('waits only briefly for a server that does not answer', async () => {
    get.mockReturnValue(new Promise(() => {}));
    const logo = screenLogo();
    await vi.advanceTimersByTimeAsync(1600);
    expect(await logo).toBeUndefined();
  });

  it('keeps the fetched logo on the device and shows it at once next time, even with the server hanging', async () => {
    get.mockResolvedValueOnce({ logo: 'SRV', footer: null });
    expect(await screenLogo()).toBe('data:image/png;base64,SRV');
    expect(store.get('receipt.serverLogoCache')).toBe('SRV');
    resetBrandingCache();
    get.mockReturnValue(new Promise(() => {}));
    expect(await screenLogo()).toBe('data:image/png;base64,SRV');
  });

  it('does not retry a failed fetch on every sale', async () => {
    get.mockRejectedValue(new Error('offline'));
    expect(await serverBranding()).toBeNull();
    expect(await serverBranding()).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(61_000);
    await serverBranding();
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('account logo (used for printing too)', () => {
  it('comes from the copy kept on the device in a new session, without waiting for the server', async () => {
    store.set('receipt.serverLogoCache', 'KEPT');
    get.mockReturnValue(new Promise(() => {}));
    expect(await accountLogo(2500)).toBe('KEPT');
  });

  it('is kept after a fetch, so the next session has it offline', async () => {
    get.mockResolvedValueOnce({ logo: 'SRV', footer: null });
    expect(await accountLogo()).toBe('SRV');
    resetBrandingCache();
    get.mockRejectedValue(new Error('offline'));
    expect(await accountLogo()).toBe('SRV');
  });

  it('follows a deliberate change made on this device', async () => {
    store.set('receipt.serverLogoCache', 'OLD');
    put.mockResolvedValueOnce({ logo: null, footer: null });
    await pushBranding({ logo: null });
    expect(store.get('receipt.serverLogoCache')).toBe('');
    expect(await accountLogo()).toBeUndefined();
  });
});
