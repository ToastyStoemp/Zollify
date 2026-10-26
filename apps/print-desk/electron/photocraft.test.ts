import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { photocraftConfigDir, printSettingsFrom } from './photocraft.js';

describe('printSettingsFrom', () => {
  it("takes PhotoCraft's remembered print without copies or dialog-only keys", () => {
    const prefs = {
      dialogs: {
        'file.print': { printer: 'Canon PRO-1000 series', printerSettings: 'abcd', paper: [842.29, 1191.14], orientation: 'portrait', scaleToFit: true, copies: 3, units: 'cm', printable: [0, 0, 842.29, 1191.14] },
      },
    };
    expect(printSettingsFrom(prefs)).toEqual({ printer: 'Canon PRO-1000 series', printerSettings: 'abcd', paper: [842.29, 1191.14], orientation: 'portrait', scaleToFit: true });
  });

  it('turns a landscape driver paper into the portrait paper in landscape', () => {
    const prefs = { dialogs: { 'file.print': { paper: [1191.14, 842.29], orientation: 'portrait' } } };
    expect(printSettingsFrom(prefs)).toEqual({ paper: [842.29, 1191.14], orientation: 'landscape' });
  });

  it('is null when PhotoCraft has not printed yet', () => {
    for (const prefs of [{}, { dialogs: {} }, { dialogs: { 'file.print': 'x' } }, null]) expect(printSettingsFrom(prefs)).toBeNull();
  });
});

describe('photocraftConfigDir', () => {
  it('follows PhotoCraft: its override first, then the platform folder', () => {
    expect(photocraftConfigDir('', { PHOTOCRAFT_CONFIG_DIR: 'D:\\pc' }, 'win32')).toBe('D:\\pc');
    expect(photocraftConfigDir('', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32')).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'Photocraft'));
    expect(photocraftConfigDir('', { XDG_CONFIG_HOME: '/x' }, 'linux')).toBe(join('/x', 'photocraft'));
  });
});
