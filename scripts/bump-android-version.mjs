/**
 * Stamp a fresh versionCode/versionName into android/app/build.gradle before
 * building. Run this first, then build the APKs, then `npm run pack:apk` —
 * which reads the version back from build.gradle so server/apk/version.json
 * always matches exactly what's embedded in the APKs it's shipping (not a
 * separately-computed timestamp that can drift a few minutes apart).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gradlePath = join(root, 'android', 'app', 'build.gradle');

// Minutes-since-epoch: monotonically increasing, no state to track between runs.
// Update detection still keys off this integer.
const versionCode = Math.floor(Date.now() / 60000);
// versionName = the git commit being built, so a running app maps 1:1 to a
// commit. A "-dirty" suffix flags a build made with uncommitted changes.
const versionName = gitVersion();

function gitVersion() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: root }).toString().trim() ? '-dirty' : '';
    return sha + dirty;
  } catch {
    // No git (e.g. a source tarball) — fall back to a timestamp so it's never empty.
    return new Date().toISOString().slice(0, 16).replace('T', ' ');
  }
}

let content = readFileSync(gradlePath, 'utf-8');
if (!/versionCode \d+/.test(content) || !/versionName "[^"]*"/.test(content)) {
  console.error('Could not find versionCode/versionName in android/app/build.gradle.');
  process.exit(1);
}
content = content.replace(/versionCode \d+/, `versionCode ${versionCode}`);
content = content.replace(/versionName "[^"]*"/, `versionName "${versionName}"`);
writeFileSync(gradlePath, content);

console.log(`Bumped android/app/build.gradle -> versionCode ${versionCode}, versionName "${versionName}"`);
