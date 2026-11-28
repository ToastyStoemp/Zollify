import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sdk } from '@zollify/sdk';
import { setSdk, clearSdk } from '../runtime';
import { accountBranding, accountLogo, backfillBranding, pushBranding, pushReceiptToggles, receiptSocials, refreshReceiptCopies, resetBrandingCache, screenLogo, serverBranding, serverSocials } from '../lib/branding';

/**
 * The thank-you screen must not wait for the network: the logo comes from the
 * device, a slow or missing server costs at most a short wait once, and a
 * failed fetch is not retried on every sale.
 */

/** What the device keeps of the account's branding, as last given by the server. */
const keptBranding = (): unknown => (store.get('cache.branding') as { value: unknown } | undefined)?.value;
/** Put a copy on the device as if the server gave it `ageMs` ago. */
const keep = (key: string, value: unknown, ageMs = 0): void => void store.set(key, { value, at: Date.now() - ageMs });
const HOUR = 60 * 60_000;

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
    expect(keptBranding()).toEqual({ logo: 'SRV', footer: null });
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
    keep('cache.branding', { logo: 'KEPT', footer: null }, HOUR);
    get.mockReturnValue(new Promise(() => {}));
    expect(await accountLogo(2500)).toBe('KEPT');
  });

  it('still comes from the copy an older version kept, without waiting, until the server is reached', async () => {
    store.set('receipt.serverLogoCache', 'OLDER');
    get.mockReturnValue(new Promise(() => {}));
    const logo = accountLogo(2500);
    await vi.advanceTimersByTimeAsync(0);
    expect(await logo).toBe('OLDER');
    resetBrandingCache();
    get.mockResolvedValue({ logo: 'SRV', footer: null });
    await refreshReceiptCopies();
    expect(await accountLogo()).toBe('SRV');
  });

  it('is kept after a fetch, so the next session has it offline', async () => {
    get.mockResolvedValueOnce({ logo: 'SRV', footer: null });
    expect(await accountLogo()).toBe('SRV');
    resetBrandingCache();
    get.mockRejectedValue(new Error('offline'));
    expect(await accountLogo()).toBe('SRV');
  });

  it('follows a deliberate change made on this device', async () => {
    keep('cache.branding', { logo: 'OLD', footer: null });
    put.mockResolvedValueOnce({ logo: null, footer: null });
    await pushBranding({ logo: null });
    expect(keptBranding()).toEqual({ logo: null, footer: null });
    expect(await accountLogo()).toBeUndefined();
  });
});

describe('account footer', () => {
  it('is kept with the logo, so a receipt has it offline in a new session', async () => {
    get.mockResolvedValueOnce({ logo: 'SRV', footer: 'Thanks!' });
    expect((await accountBranding())?.footer).toBe('Thanks!');
    resetBrandingCache();
    get.mockRejectedValue(new Error('offline'));
    expect((await accountBranding())?.footer).toBe('Thanks!');
  });
});

describe('branding changed on another device', () => {
  it('arrives with the next sync, without anyone doing anything', async () => {
    keep('cache.branding', { logo: 'OLD', footer: null }, HOUR);
    get.mockImplementation(async (path: string) => (path === 'branding' ? { logo: 'NEW', footer: 'New footer' } : { showOnPrint: true }));
    await refreshReceiptCopies();
    await vi.advanceTimersByTimeAsync(0);
    get.mockReturnValue(new Promise(() => {}));
    expect(await accountBranding()).toEqual({ logo: 'NEW', footer: 'New footer' });
    expect((await receiptSocials())?.showOnPrint).toBe(true);
  });

  it('is not asked for on every sync - a copy of a few minutes ago will do', async () => {
    get.mockResolvedValue({ logo: 'SRV', footer: null });
    for (let i = 0; i < 5; i++) {
      await refreshReceiptCopies();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    // Once for the branding, once for the links.
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('never throws from the refresh, signed out or offline', async () => {
    get.mockRejectedValue(new Error('offline'));
    await expect(refreshReceiptCopies()).resolves.toBeUndefined();
  });
});

describe('filling blanks on the server', () => {
  it("does not send this device's logo on the word of an old copy while the server cannot be reached", async () => {
    keep('cache.branding', { logo: null, footer: null }, HOUR);
    store.set('receipt.logoScreenB64', 'OWN');
    get.mockRejectedValue(new Error('offline'));
    await backfillBranding();
    expect(put).not.toHaveBeenCalled();
  });

  it("sends this device's logo when the server says it has none", async () => {
    store.set('receipt.logoScreenB64', 'OWN');
    get.mockResolvedValue({ logo: null, footer: null });
    put.mockResolvedValue({ logo: 'OWN', footer: null });
    await backfillBranding();
    expect(put).toHaveBeenCalledWith('branding', { logo: 'OWN' });
  });
});

describe('receipt links', () => {
  const links = { webstore: 'https://shop.example', showOnPrint: true, showEvents: false };

  it('print from the copy on the device, without waiting for the server', async () => {
    keep('cache.receiptLinks', links, HOUR);
    get.mockReturnValue(new Promise(() => {}));
    expect(await receiptSocials(2500)).toEqual(links);
  });

  it('wait only briefly when there is no copy and the server does not answer', async () => {
    get.mockReturnValue(new Promise(() => {}));
    const read = receiptSocials(2500);
    await vi.advanceTimersByTimeAsync(2500);
    expect(await read).toBeNull();
  });

  it('follow a change of the switches made on this device', async () => {
    keep('cache.receiptLinks', links);
    put.mockResolvedValueOnce({ ...links, showOnPrint: false });
    await pushReceiptToggles({ showOnPrint: false, showEvents: false });
    expect((await receiptSocials())?.showOnPrint).toBe(false);
  });

  it('are asked from the server afresh for the settings page, not taken from the copy', async () => {
    keep('cache.receiptLinks', links);
    get.mockResolvedValueOnce({ ...links, showOnPrint: false });
    expect((await serverSocials())?.showOnPrint).toBe(false);
  });
});
