/**
 * Stamp a fresh versionCode/versionName into android/app/build.gradle before
 * building. Run this first, then build the APKs, then `npm run pack:apk` -
 * which reads the version back from build.gradle so server/apk/version.json
 * always matches exactly what's embedded in the APKs it's shipping (not a
 * separately-computed timestamp that can drift a few minutes apart).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStamp } from './build-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gradlePath = join(root, 'android', 'app', 'build.gradle');

// Minutes-since-epoch: monotonically increasing, no state to track between runs.
// Update detection still keys off this integer.
const versionCode = Math.floor(Date.now() / 60000);
// versionName = the same MAJOR.MINOR.PATCH-<commit> as the content updates
// (scripts/build-version.mjs), so the app and its content read alike and an
// APK built from the commit the server serves has nothing to download. It is
// also the version the content updater gives the content inside the APK. A
// "-dirty" suffix flags a build made with uncommitted changes.
const versionName = buildStamp() + (dirty() ? '-dirty' : '');

function dirty() {
  try {
    return execSync('git status --porcelain', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== '';
  } catch {
    return false;
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
