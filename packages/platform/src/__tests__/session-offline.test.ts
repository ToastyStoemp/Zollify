import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Starting the app without the server: resume as whoever signed this device
 * in, from what is already on it - unless the server refused that sign-in,
 * the person signed out, or it was too long ago.
 */

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const user = { id: 'u1', accountId: 'a1', accountName: 'Loppehjørnet', email: 'owner@example.test', role: 'owner', allowedEventIds: null, profile: undefined };
const login = { accessToken: 'not-a-jwt', user } as never;

/** A fresh app start: new module state, same device storage. */
async function restart() {
  vi.resetModules();
  return import('../session');
}

beforeEach(() => {
  store.clear();
  vi.unstubAllGlobals();
});

describe('starting without the server', () => {
  it('resumes as the person who signed this device in, with no token until the server answers', async () => {
    (await restart()).applyLogin(login);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const s = await restart();
    expect(await s.refreshAccessToken()).toBe(false);
    expect(s.getAccount()).toBeNull();
    expect(s.resumeOffline()).toBe(true);
    expect(s.getAccount()).toMatchObject({ accountId: 'a1', userId: 'u1', role: 'owner' });
    expect(s.signedInOffline.value).toBe(true);
    expect(s.getAccessToken()).toBeNull();
  });

  it('does not resume a sign-in the server refused', async () => {
    (await restart()).applyLogin(login);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const s = await restart();
    expect(await s.refreshAccessToken()).toBe(false);
    expect(s.resumeOffline()).toBe(false);
  });

  it('does not resume after signing out, or a month on', async () => {
    const first = await restart();
    first.applyLogin(login);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect((await restart()).resumeOffline(Date.now() + 31 * 24 * 3600 * 1000)).toBe(false);
    const again = await restart();
    again.applyLogin(login);
    await again.signOut();
    expect((await restart()).resumeOffline()).toBe(false);
  });

  it('keeps the remembered profile current when it is edited', async () => {
    const s = await restart();
    s.applyLogin(login);
    s.applyUser({ ...user, accountName: 'Renamed' } as never);
    const next = await restart();
    expect(next.resumeOffline()).toBe(true);
    expect(next.getAccount()?.accountName).toBe('Renamed');
  });
});
