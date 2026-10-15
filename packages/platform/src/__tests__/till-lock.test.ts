import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Lock button belongs on screen only once a shared-till PIN lock is set up
 * on this device - with the lock off there is nothing to lock.
 */

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

beforeEach(() => {
  vi.resetModules();
  store.clear();
});

describe('lock button visibility', () => {
  it('is hidden until a PIN lock is set up, and hidden again when it is turned off', async () => {
    const { canLockTill, saveTillSettings, tillSettings } = await import('../till-lock');
    expect(canLockTill()).toBe(false);
    saveTillSettings({ ...tillSettings.value, enabled: true });
    expect(canLockTill()).toBe(true);
    saveTillSettings({ ...tillSettings.value, enabled: false });
    expect(canLockTill()).toBe(false);
  });
});
