import { afterEach, describe, expect, it } from 'vitest';
import { moduleRequestPath } from '../sdk-host';
import { configureApiBase } from '../session';

/**
 * A module's requests carry the user's token. Its paths must stay under
 * `/m/<moduleId>/`, however the way out is spelled - the URL parser folds
 * far more than a literal `..` into a dot segment.
 */

afterEach(() => configureApiBase('/api'));

describe("a module's request path", () => {
  it('is rooted at the module, tidied as before', () => {
    expect(moduleRequestPath('pos', 'settings')).toBe('/m/pos/settings');
    expect(moduleRequestPath('pos', '/settings/')).toBe('/m/pos/settings');
    expect(moduleRequestPath('pos', 'a//b/./c')).toBe('/m/pos/a/b/c');
    expect(moduleRequestPath('pos', '')).toBe('/m/pos');
  });

  it('keeps the query and encoded values within a segment', () => {
    expect(moduleRequestPath('tax', 'lookup?scheme=vat&id=CH%2F123&back=../x')).toBe('/m/tax/lookup?scheme=vat&id=CH%2F123&back=../x');
    expect(moduleRequestPath('pos', `documents/${encodeURIComponent('2026/001 a')}/send`)).toBe('/m/pos/documents/2026%2F001%20a/send');
  });

  it('allows a dot segment that stays inside, and sends it resolved', () => {
    expect(moduleRequestPath('pos', 'a/../b')).toBe('/m/pos/b');
  });

  it.each([
    ['plain dot segments', '../../account/wipe'],
    ['dot segments behind a real segment', 'a/../../../account/wipe'],
    ['encoded dots', '%2e%2e/%2e%2e/account/wipe'],
    ['upper-case encoded dots', '%2E%2E/%2E%2E/account/wipe'],
    ['a half-encoded dot segment', '.%2e/.%2e/account/wipe'],
    ['an encoded dot segment that would stay inside', 'a/%2e%2e/b'],
    ['backslashes', '..\\..\\account\\wipe'],
    ['a backslash after a segment', 'a\\..\\..\\..\\account/wipe'],
    ['a tab hidden in the dots', '.\t./.\t./account/wipe'],
    ['a newline hidden in the dots', '.\n./.\n./account/wipe'],
    ['another module', '../tax/reports'],
    ['a sibling whose name starts the same', '../pos-evil/x'],
    ['leading slashes and dots', '//../../account/wipe'],
  ])('refuses %s', (_name, path) => {
    expect(() => moduleRequestPath('pos', path)).toThrow('may only call its own server routes');
  });

  it('holds with an absolute API base, as in the Android shell', () => {
    configureApiBase('https://booth.example.test/api/');
    expect(moduleRequestPath('pos', 'settings')).toBe('/m/pos/settings');
    expect(() => moduleRequestPath('pos', '../../account/wipe')).toThrow('may only call its own server routes');
    expect(() => moduleRequestPath('pos', '%2e%2e/%2e%2e/%2e%2e/x')).toThrow('may only call its own server routes');
  });
});
