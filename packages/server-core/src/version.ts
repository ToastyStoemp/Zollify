import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * The commit this server is running, resolved at boot so a deploy maps 1:1 to a
 * commit. Order: explicit env override → the file deploy.sh writes into the data
 * volume (containers have no .git) → git directly (dev) → 'dev'. A '-dirty'
 * suffix flags a build/run made with uncommitted changes.
 */
export function resolveCommit(dataDir: string): string {
  if (process.env.ZOLLTOOL_COMMIT_SHA) return process.env.ZOLLTOOL_COMMIT_SHA;
  try {
    const f = readFileSync(join(dataDir, 'commit'), 'utf8').trim();
    if (f) return f;
  } catch {
    /* no commit file — fall through to git (dev) */
  }
  try {
    const sha = execSync('git rev-parse --short HEAD').toString().trim();
    const dirty = execSync('git status --porcelain').toString().trim() ? '-dirty' : '';
    return sha + dirty;
  } catch {
    return 'dev';
  }
}
