/**
 * The version a build is stamped with: MAJOR.MINOR.PATCH-<commit>.
 *
 * MAJOR and MINOR come from apps/web/package.json and are bumped by hand in
 * the change that earns it (see CLAUDE.md, Versioning). PATCH counts the
 * commits on master since that version line last changed, so it starts at 0
 * on each bump and goes up by one with every merge - nobody has to remember it.
 *
 * Shared by apps/web/vite.config.ts (__ZOLLIFY_VERSION__) and
 * scripts/publish-shell.mjs (the content bundle's version), which must agree.
 *
 * The Docker build has no .git (.dockerignore), so CI works out the patch and
 * the commit and passes them in as ZOLLIFY_BUILD and ZOLLIFY_COMMIT; git is
 * only the fallback for a local build.
 *
 * `-`, not semver's `+`, before the commit: the string is a URL path segment
 * (the shell bundle route), and the updater's native downloader failed on a
 * `+` in the URL. Nothing parses it - devices only compare it for equality.
 *
 * Run directly, it prints the patch number (for the image workflow).
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILE = 'apps/web/package.json';

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

/** Commits on master's line since the version was last set; 0 when git cannot tell. */
export function patchNumber() {
  const fromEnv = process.env.ZOLLIFY_BUILD;
  if (fromEnv && /^\d+$/.test(fromEnv)) return Number(fromEnv);
  // The last commit whose diff touched the top-level "version" line.
  const since = git(`log -1 --format=%H -G'^  "version":' -- ${VERSION_FILE}`);
  if (!since) return 0;
  const count = git(`rev-list --count --first-parent ${since}..HEAD`);
  return /^\d+$/.test(count) ? Number(count) : 0;
}

export function buildStamp() {
  const version = JSON.parse(readFileSync(join(root, VERSION_FILE), 'utf8')).version;
  const [major = '0', minor = '0'] = String(version).split('.');
  const commit = process.env.ZOLLIFY_COMMIT && process.env.ZOLLIFY_COMMIT !== 'unknown' ? process.env.ZOLLIFY_COMMIT.slice(0, 7) : git('rev-parse --short HEAD');
  const base = `${major}.${minor}.${patchNumber()}`;
  return commit ? `${base}-${commit}` : base;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(patchNumber());
}
