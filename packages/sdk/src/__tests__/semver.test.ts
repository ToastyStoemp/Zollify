import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion, satisfies } from '../semver';

describe('parseVersion', () => {
  it('parses plain and prerelease versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
    expect(parseVersion('0.1.0-beta.2')).toEqual({ major: 0, minor: 1, patch: 0, prerelease: 'beta.2' });
  });

  it('rejects junk rather than guessing', () => {
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('v1.2.3')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('compareVersions', () => {
  const v = (s: string) => parseVersion(s)!;

  it('orders by major, minor, then patch', () => {
    expect(compareVersions(v('1.0.0'), v('2.0.0'))).toBe(-1);
    expect(compareVersions(v('1.3.0'), v('1.2.9'))).toBe(1);
    expect(compareVersions(v('1.2.3'), v('1.2.3'))).toBe(0);
  });

  it('sorts a prerelease below its release', () => {
    expect(compareVersions(v('1.0.0-rc.1'), v('1.0.0'))).toBe(-1);
    expect(compareVersions(v('1.0.0'), v('1.0.0-rc.1'))).toBe(1);
  });
});

describe('satisfies', () => {
  it('accepts wildcards and exact matches', () => {
    expect(satisfies('1.2.3', '*')).toBe(true);
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '1.2.3')).toBe(false);
  });

  it('treats caret on 0.x as breaking per minor, matching npm', () => {
    // This is the case that matters: the SDK sits on 0.x for a while, so a
    // module built against ^0.1.0 must refuse to load on 0.2.0.
    expect(satisfies('0.1.5', '^0.1.0')).toBe(true);
    expect(satisfies('0.2.0', '^0.1.0')).toBe(false);
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false);
  });

  it('lets caret span minors once major is non-zero', () => {
    expect(satisfies('1.4.0', '^1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfies('1.1.0', '^1.2.0')).toBe(false);
  });

  it('bounds tilde to the patch range', () => {
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
  });

  it('handles comparators and ANDed ranges', () => {
    expect(satisfies('1.5.0', '>=1.2.0')).toBe(true);
    expect(satisfies('1.1.0', '>=1.2.0')).toBe(false);
    expect(satisfies('1.5.0', '>=1.2.0 <2.0.0')).toBe(true);
    expect(satisfies('2.0.1', '>=1.2.0 <2.0.0')).toBe(false);
  });

  it('answers false for malformed input instead of throwing', () => {
    // A bad range in a manifest must read as "cannot load", never as an
    // exception escaping the loader mid-boot.
    expect(satisfies('1.0.0', 'not-a-range')).toBe(false);
    expect(satisfies('garbage', '^1.0.0')).toBe(false);
    expect(satisfies('1.0.0', '^')).toBe(false);
  });
});
