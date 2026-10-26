import { describe, expect, it, vi } from 'vitest';

vi.mock('@zollify/platform', () => ({ isNative: () => false }));
const { shortcutPath } = await import('../shortcuts');

/** The Android launcher shortcuts open the app on a zollify:// link; these are the screens they lead to. */
describe('launcher shortcuts', () => {
  it('opens the quick expense and the till', () => {
    expect(shortcutPath('zollify://expense')).toBe('/m/tax/quick-expense');
    expect(shortcutPath('ZOLLIFY://Sell')).toBe('/m/pos');
  });

  it('ignores links it does not know, and other schemes', () => {
    expect(shortcutPath('zollify://delete-everything')).toBeNull();
    expect(shortcutPath('https://example.com/expense')).toBeNull();
    expect(shortcutPath('')).toBeNull();
  });
});
