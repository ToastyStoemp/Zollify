import { describe, expect, it, vi } from 'vitest';

vi.mock('../session', () => ({ authFetch: vi.fn(), getAccount: () => null }));
vi.mock('../shell-ui', () => ({ createShellUi: () => ({ toast: vi.fn() }) }));
vi.mock('../native', () => ({ isNative: () => false }));

const { wantsSystemNotification } = await import('../core/notifications');

describe('system notifications', () => {
  it('posts every note while the app is in the background', () => {
    expect(wantsSystemNotification({ kind: 'sale' }, false)).toBe(true);
    expect(wantsSystemNotification({ kind: null }, false)).toBe(true);
  });
  it('in front, leaves news to the toast but posts a printer waiting for someone', () => {
    expect(wantsSystemNotification({ kind: 'sale' }, true)).toBe(false);
    expect(wantsSystemNotification({ kind: null }, true)).toBe(false);
    expect(wantsSystemNotification({ kind: 'print-desk' }, true)).toBe(true);
  });
});
