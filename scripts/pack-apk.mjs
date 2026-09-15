/**
 * Copies the built debug APKs (one per flavour) into apps/server/apk/ with a
 * version.json read from the version stamped into android/app/build.gradle,
 * so the server can hand each device the flavour it runs.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'apps', 'server', 'apk');
const flavors = ['carbon', 'compat', 'full'];

mkdirSync(outDir, { recursive: true });
let packed = 0;
for (const flavor of flavors) {
  const src = join(root, 'android', 'app', 'build', 'outputs', 'apk', flavor, 'debug', `app-${flavor}-debug.apk`);
  if (!existsSync(src)) {
    console.warn(`Skipping ${flavor} — ${src} not found (build it first).`);
    continue;
  }
  copyFileSync(src, join(outDir, `zollify-${flavor}.apk`));
  packed++;
}
if (!packed) {
  console.error('No APKs found — run `npm run android:apk` first.');
  process.exit(1);
}
const gradle = readFileSync(join(root, 'android', 'app', 'build.gradle'), 'utf-8');
const versionCode = Number(gradle.match(/versionCode (\d+)/)?.[1]);
const versionName = gradle.match(/versionName "([^"]*)"/)?.[1];
writeFileSync(join(outDir, 'version.json'), JSON.stringify({ versionCode, versionName }, null, 2) + '\n');
console.log(`Packed ${packed} APK(s) -> apps/server/apk/ (versionCode ${versionCode}, "${versionName}")`);
