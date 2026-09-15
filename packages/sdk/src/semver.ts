/**
 * A deliberately small semver range checker.
 *
 * The SDK ships inside every module bundle's dependency graph and is loaded
 * before anything else, so pulling in a full semver implementation to answer
 * one question ("can this host satisfy the range this module was built
 * against?") is not worth the bytes. Supported ranges are the ones a module
 * manifest is allowed to express: `*`, exact, `^`, `~`, and comparators.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(input: string): SemVer | null {
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/** -1 when a < b, 0 when equal, 1 when a > b. Prereleases sort below their release. */
export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  // A version with a prerelease tag is always lower than the same version without.
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

function upperBoundFor(op: '^' | '~', v: SemVer): SemVer {
  if (op === '~') return { major: v.major, minor: v.minor + 1, patch: 0, prerelease: null };
  // Caret keeps the leftmost non-zero component stable, so 0.x releases are
  // treated as breaking on every minor - matching npm, and mattering here
  // because the SDK will sit on 0.x for a while.
  if (v.major > 0) return { major: v.major + 1, minor: 0, patch: 0, prerelease: null };
  if (v.minor > 0) return { major: 0, minor: v.minor + 1, patch: 0, prerelease: null };
  return { major: 0, minor: 0, patch: v.patch + 1, prerelease: null };
}

/**
 * Does `version` satisfy `range`? Unparseable input answers `false` rather than
 * throwing: a malformed range in a module manifest must read as "cannot load",
 * never as an exception escaping the loader.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;

  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === '') return true;

  // Space-separated comparators are ANDed together (`>=1.2.0 <2.0.0`).
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) return parts.every((part) => satisfies(version, part));

  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(trimmed);
  if (!m) return false;
  const op = m[1] ?? '=';
  const target = parseVersion(m[2] ?? '');
  if (!target) return false;

  const cmp = compareVersions(v, target);

  switch (op) {
    case '=':
      return cmp === 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '^':
    case '~':
      return cmp >= 0 && compareVersions(v, upperBoundFor(op, target)) < 0;
    default:
      return false;
  }
}
